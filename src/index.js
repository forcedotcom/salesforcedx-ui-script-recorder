import { chromium, firefox, webkit } from 'playwright'
import { createServer } from './server.js'
import { buildInjectedScript } from './build.js'
import { convertToPlaywright } from './playwright-converter.js'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'

const browsers = { chromium, firefox, webkit }

export async function startRecording(options) {
  const {
    url,
    output,
    headless,
    browser: browserName,
    dataAttribute,
    viewportWidth,
    viewportHeight,
    profileDir,
    saveAuth
  } = options

  // Build the injected script bundle
  console.log(chalk.gray('  Building injected scripts...'))
  const injectedScript = await buildInjectedScript()

  // Start WebSocket server for communication
  const { server, port, events } = await createServer()
  console.log(chalk.gray(`  WebSocket server on port ${port}`))

  // Launch the browser — CDP isolated worlds require Chromium
  if (browserName !== 'chromium') {
    console.log(chalk.yellow(`  ⚠ CDP isolated world injection requires Chromium. Falling back to chromium.`))
  }
  const browserType = browsers.chromium

  let browserInstance = null
  let context
  let page

  const chromiumArgs = [
    '--no-sandbox',
    '--disable-notifications',
    '--disable-infobars',
    '--disable-features=TranslateUI',
    '--deny-permission-prompts',
  ]

  const permissions = ['geolocation', 'notifications', 'camera', 'microphone']

  if (profileDir) {
    const userDataDir = path.resolve(profileDir)
    fs.mkdirSync(userDataDir, { recursive: true })
    console.log(chalk.gray(`  Profile dir: ${userDataDir}`))

    context = await browserType.launchPersistentContext(userDataDir, {
      headless: headless === true,
      args: chromiumArgs,
      permissions,
      viewport: { width: parseInt(viewportWidth), height: parseInt(viewportHeight) }
    })
    page = context.pages()[0] || await context.newPage()
  } else {
    browserInstance = await browserType.launch({
      headless: headless === true,
      args: chromiumArgs
    })
    context = await browserInstance.newContext({
      viewport: { width: parseInt(viewportWidth), height: parseInt(viewportHeight) },
      permissions
    })
    page = await context.newPage()
  }

  // Inject the recorder into an ISOLATED world via CDP.
  // This matches how the Chrome extension content scripts work:
  // - Own copy of DOM APIs (unpatched by LWC)
  // - event.target is NOT retargeted across open shadow DOM boundaries
  // - No interference from page-level JavaScript
  const cdpSession = await context.newCDPSession(page)

  const initScriptContent = `
    window.__sfRecorderConfig = {
      wsPort: ${port},
      dataAttribute: ${JSON.stringify(dataAttribute || '')}
    };
    ${injectedScript}
  `

  // Enable Page domain events so we can listen for navigations
  await cdpSession.send('Page.enable')

  await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
    source: initScriptContent,
    worldName: 'SalesforceRecorderIsolated'
  })

  // Recording state - viewport is always the first step
  const recording = []
  let isPaused = false
  let hasGoto = false
  let hasViewPort = false

  // Pre-record viewport as the first entry
  recording.push({
    selector: undefined,
    value: { width: parseInt(viewportWidth), height: parseInt(viewportHeight) },
    action: 'VIEWPORT',
    eventTime: Date.now()
  })
  hasViewPort = true

  // Inject into the current page's isolated world (for pages already loaded
  // before addScriptToEvaluateOnNewDocument takes effect).
  // We create an isolated world on the main frame and evaluate our script in it.
  const injectRecorder = async () => {
    try {
      const { frameTree } = await cdpSession.send('Page.getFrameTree')
      const frameId = frameTree.frame.id

      const { executionContextId } = await cdpSession.send('Page.createIsolatedWorld', {
        frameId,
        worldName: 'SalesforceRecorderIsolated',
        grantUniveralAccess: true
      })

      await cdpSession.send('Runtime.evaluate', {
        expression: initScriptContent,
        contextId: executionContextId,
        awaitPromise: false
      })
    } catch (err) {
      // Frame may have navigated away
    }
  }

  // Track navigations — both for re-injection and for recording navigation events.
  // This produces the NAVIGATION actions that generateUserFlow attaches as
  // assertedEvents on the preceding step (e.g. a click that triggers a page load).
  cdpSession.on('Page.frameNavigated', async (params) => {
    // Only track top-frame navigations
    if (!params.frame.parentId) {
      const navUrl = params.frame.url
      // console.log(chalk.blue(`  ↳ Navigation: ${navUrl}`))

      // Don't record the initial navigation (already handled as GOTO)
      if (navUrl && navUrl !== 'about:blank' && hasGoto) {
        // Skip if this is the same URL as our initial GOTO
        const initialGoto = recording.find(r => r.action === 'GOTO')
        if (!initialGoto || initialGoto.href !== navUrl) {
          // Get the page title after navigation settles
          let title = ''
          try {
            title = await page.title()
          } catch (e) { /* page may still be loading */ }

          recording.push({
            selector: undefined,
            value: navUrl,
            title,
            action: 'NAVIGATION',
            eventTime: Date.now()
          })
          // console.log(chalk.blue(`    ✓ Recorded navigation`))
        }
      }

      // Re-inject as safety net
      setTimeout(() => injectRecorder(), 100)
    }
  })

  // Handle incoming messages from the injected script
  events.on('message', (msg) => {
    if (msg.control) {
      handleControlMessage(msg)
      return
    }

    if (!isPaused) {
      // Add frame info
      msg.frameId = msg.frameId || 0
      msg.frameUrl = msg.frameUrl || null
      msg.frameIndex = msg.frameIndex || null
      recording.push(msg)
    }
  })

  events.on('overlay-action', (msg) => {
    handleOverlayAction(msg)
  })

  function handleControlMessage(msg) {
    const { control, value } = msg

    switch (control) {
      case 'EVENT_RECORDER_STARTED':
        break
      case 'GET_VIEWPORT_SIZE':
        if (!hasViewPort) {
          recording.push({
            selector: undefined,
            value: { width: parseInt(viewportWidth), height: parseInt(viewportHeight) },
            action: 'VIEWPORT',
            eventTime: Date.now()
          })
          hasViewPort = true
        }
        break
      case 'GET_CURRENT_URL': {
        // The CLI handles GOTO recording directly after page.goto()
        // so we just mark it as done to avoid duplicates from the injected script
        hasGoto = true
        break
      }
      case 'GET_SCREENSHOT':
        recording.push({
          selector: undefined,
          value,
          action: 'SCREENSHOT'
        })
        break
    }
  }

  function handleOverlayAction(msg) {
    const { action } = msg

    switch (action) {
      case 'STOP':
        finishRecording()
        break
      case 'PAUSE':
        isPaused = true
        console.log(chalk.yellow('  ⏸  Recording paused'))
        break
      case 'UNPAUSE':
        isPaused = false
        console.log(chalk.green('  ▶  Recording resumed'))
        break
      case 'RESTART':
        recording.length = 0
        hasGoto = false
        hasViewPort = false
        isPaused = false
        console.log(chalk.blue('  🔄 Recording restarted'))
        break
    }
  }

  async function finishRecording() {
    console.log(chalk.green(`\n  ✓ Recording complete! ${recording.length} events captured.`))

    // Generate the JSON user flow
    const userFlow = generateUserFlow(recording, options)

    // Write the JSON output
    const outputPath = path.resolve(output)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, JSON.stringify(userFlow, null, 2))
    console.log(chalk.green(`  ✓ JSON saved to: ${outputPath}`))

    // Convert to Playwright script via remote service
    const playwrightPath = outputPath.replace(/\.json$/, '.spec.js')
    try {
      console.log(chalk.gray('  Converting to Playwright script...'))
      const playwrightCode = await convertToPlaywright(userFlow, {
        cloud: options.cloud,
        user: options.user,
        team: options.team
      })
      fs.writeFileSync(playwrightPath, playwrightCode)
      console.log(chalk.green(`  ✓ Playwright script saved to: ${playwrightPath}\n`))
    } catch (err) {
      console.log(chalk.yellow(`  ⚠ Playwright conversion failed: ${err.message}`))
      console.log(chalk.gray(`    JSON was saved — you can retry conversion later.\n`))
    }

    // Save auth state if requested
    if (saveAuth) {
      try {
        const authPath = path.resolve(saveAuth)
        fs.mkdirSync(path.dirname(authPath), { recursive: true })
        await context.storageState({ path: authPath })
        console.log(chalk.green(`  ✓ Auth state saved to: ${authPath}`))
      } catch (e) {
        console.log(chalk.yellow(`  ⚠ Could not save auth state: ${e.message}`))
      }
    }

    // Cleanup
    server.close()
    if (browserInstance) {
      await browserInstance.close()
    } else {
      await context.close()
    }
    process.exit(0)
  }

  // Handle browser close (works for both persistent context and regular browser)
  const onBrowserClose = async () => {
    if (recording.length > 0) {
      console.log(chalk.yellow('\n  Browser closed. Saving recording...'))

      // Try to save auth state before context is fully destroyed
      if (saveAuth) {
        try {
          const authPath = path.resolve(saveAuth)
          fs.mkdirSync(path.dirname(authPath), { recursive: true })
          await context.storageState({ path: authPath })
          console.log(chalk.green(`  ✓ Auth state saved to: ${authPath}`))
        } catch (e) {
          console.log(chalk.yellow(`  ⚠ Could not save auth state (browser closed abruptly)`))
        }
      }

      const userFlow = generateUserFlow(recording, options)
      const outputPath = path.resolve(output)
      fs.mkdirSync(path.dirname(outputPath), { recursive: true })
      fs.writeFileSync(outputPath, JSON.stringify(userFlow, null, 2))
      console.log(chalk.green(`  ✓ JSON saved to: ${outputPath}`))

      // Convert to Playwright script
      const playwrightPath = outputPath.replace(/\.json$/, '.spec.js')
      try {
        console.log(chalk.gray('  Converting to Playwright script...'))
        const playwrightCode = await convertToPlaywright(userFlow, {
          cloud: options.cloud,
          user: options.user,
          team: options.team
        })
        fs.writeFileSync(playwrightPath, playwrightCode)
        console.log(chalk.green(`  ✓ Playwright script saved to: ${playwrightPath}\n`))
      } catch (err) {
        console.log(chalk.yellow(`  ⚠ Playwright conversion failed: ${err.message}`))
        console.log(chalk.gray(`    JSON was saved — you can retry conversion later.\n`))
      }
    }
    server.close()
    process.exit(0)
  }

  if (browserInstance) {
    browserInstance.on('disconnected', onBrowserClose)
  } else {
    context.on('close', onBrowserClose)
  }

  // Navigate to the starting URL
  if (url && url !== 'about:blank') {
    // Pre-record the GOTO before navigation triggers the injected script
    recording.push({
      selector: undefined,
      title: '',
      action: 'GOTO',
      href: url,
      eventTime: Date.now()
    })
    hasGoto = true

    await page.goto(url)

    // Update the title now that the page has loaded
    const title = await page.title()
    if (recording[recording.length - 1]?.action === 'GOTO' || recording[0]?.action === 'GOTO') {
      const gotoStep = recording.find(r => r.action === 'GOTO')
      if (gotoStep) gotoStep.title = title
    }

    // CDP script should have injected on navigation, but ensure it ran
    await injectRecorder()
  } else {
    // For about:blank, inject manually
    await injectRecorder()
  }

  console.log(chalk.green('  ✓ Recording started! Interact with the page.'))
  console.log(chalk.gray('  Use the overlay controls or close the browser to stop.\n'))

  // Keep the process alive
  await new Promise(() => {})
}

function generateUserFlow(events, options) {
  // TODO: Replace with full Playwright script generation later
  const steps = []
  let previousEventTime = 0
  const tabIds = []

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const { action, selectors, value, href, keyCode, tagName, frameSelectors, parentSelectors, componentType, key, type, inputType, coordinates, title, tabId } = event

    let delay = 0
    if (i === 0) {
      previousEventTime = event.eventTime
    } else if (action !== 'NAVIGATION') {
      delay = event.eventTime - previousEventTime
      previousEventTime = event.eventTime
    }

    switch (action) {
      case 'GOTO': {
        const step = {
          type: 'navigate',
          target: 'main',
          url: href,
          duration: delay,
          assertedEvents: [{ type: 'navigation', url: href, title: title || '' }]
        }
        if (tabIds.length !== 0 && tabIds[tabIds.length - 1] !== tabId) {
          step.assertedEvents[0].isNewTabOrWindow = true
        }
        if (tabIds.length === 0 || tabIds[tabIds.length - 1] !== tabId) {
          tabIds.push(tabId)
        }
        steps.push(step)
        break
      }
      case 'VIEWPORT':
        steps.push({
          type: 'setViewport',
          width: value.width,
          height: value.height,
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
          isLandscape: false
        })
        break
      case 'NAVIGATION': {
        // Attach navigation assertion to previous step
        if (steps.length > 0) {
          const prevStep = steps[steps.length - 1]
          if (prevStep.type !== 'setViewport') {
            prevStep.assertedEvents = [{ type: 'navigation', url: value, title: title || '' }]
            if (tabIds.length !== 0 && tabIds[tabIds.length - 1] !== tabId) {
              prevStep.assertedEvents[0].isNewTabOrWindow = true
            }
            if (tabIds.length === 0 || (tabIds.length && tabIds[tabIds.length - 1] !== tabId)) {
              tabIds.push(tabId)
            }
          }
        }
        break
      }
      case 'RELOAD':
        steps.push({
          type: 'reload',
          target: 'main',
          assertedEvents: [{ type: 'navigation', url: '', title: '' }]
        })
        break
      case 'WINDOW_OR_TAB_CLOSED':
        if (steps.length > 0) {
          const prevStep = steps[steps.length - 1]
          if (prevStep.type !== 'setViewport') {
            prevStep.assertedEvents = [{ type: 'windowOrTabClose' }]
            if (tabIds.length && tabIds[tabIds.length - 1] === tabId) {
              tabIds.pop()
            }
          }
        }
        break
      case 'click':
        steps.push({
          type: 'click',
          target: 'main',
          selectors: selectors || [],
          ...(frameSelectors && { frameSelectors }),
          ...(coordinates && { offsetX: coordinates.x, offsetY: coordinates.y }),
          tagName,
          inputType,
          duration: delay,
          ...(parentSelectors && { parentSelectors, componentType }),
          ...(event.frameIndex && { frame: event.frameIndex })
        })
        break
      case 'dblclick':
        steps.push({
          type: 'doubleClick',
          target: 'main',
          selectors: selectors || [],
          ...(frameSelectors && { frameSelectors }),
          ...(coordinates && { offsetX: coordinates.x, offsetY: coordinates.y }),
          tagName,
          inputType,
          duration: delay,
          ...(event.frameIndex && { frame: event.frameIndex })
        })
        break
      case 'change':
        if (tagName === 'SELECT') {
          steps.push({
            type: 'change',
            target: 'main',
            selectors: selectors || [],
            ...(frameSelectors && { frameSelectors }),
            value,
            tagName,
            inputType,
            duration: delay,
            ...(event.frameIndex && { frame: event.frameIndex })
          })
        } else if (value) {
          steps.push({
            type: 'change',
            target: 'main',
            selectors: selectors || [],
            ...(frameSelectors && { frameSelectors }),
            value,
            tagName,
            inputType,
            duration: delay,
            ...(event.frameIndex && { frame: event.frameIndex })
          })
        }
        break
      case 'keydown':
        if (isSpecialKey(key)) {
          steps.push({ type: 'keyDown', target: 'main', key })
        } else if (keyCode === 9 && value) {
          steps.push({
            type: 'change',
            target: 'main',
            selectors: selectors || [],
            ...(frameSelectors && { frameSelectors }),
            value,
            tagName,
            inputType,
            duration: delay,
            ...(event.frameIndex && { frame: event.frameIndex })
          })
        }
        break
      case 'keyup':
        if (isSpecialKey(key)) {
          steps.push({ type: 'keyUp', target: 'main', key })
        } else if (value) {
          steps.push({
            type: 'change',
            target: 'main',
            selectors: selectors || [],
            ...(frameSelectors && { frameSelectors }),
            value,
            tagName,
            inputType,
            duration: delay,
            ...(event.frameIndex && { frame: event.frameIndex })
          })
        }
        break
      case 'input':
        if ((tagName === 'INPUT' || tagName === 'TEXTAREA') && value) {
          steps.push({
            type: 'change',
            target: 'main',
            selectors: selectors || [],
            ...(frameSelectors && { frameSelectors }),
            value,
            tagName,
            inputType,
            duration: delay,
            ...(event.frameIndex && { frame: event.frameIndex })
          })
        }
        break
      case 'SCREENSHOT':
        steps.push({
          type: 'screenshot',
          target: 'main',
          ...(value && { selector: value })
        })
        break
    }
  }

  // Filter duplicate change steps
  const filteredSteps = filterSteps(steps)

  return {
    title: `Recording - ${new Date().toISOString()}`,
    steps: filteredSteps
  }
}

function isSpecialKey(key) {
  if (!key) return false
  return key === 'Enter' ||
    key.startsWith('Arrow') ||
    key === 'Escape' ||
    key === 'Control' ||
    key === 'Tab' ||
    key === 'Backspace'
}

function filterSteps(steps) {
  const filteredSteps = []
  let lastChangeIndex = -1

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]

    if (step.type === 'change') {
      const isDuplicate = lastChangeIndex !== -1 &&
        filteredSteps[lastChangeIndex]?.type === step.type &&
        filteredSteps[lastChangeIndex]?.target === step.target &&
        JSON.stringify(filteredSteps[lastChangeIndex]?.selectors) === JSON.stringify(step.selectors) &&
        filteredSteps[lastChangeIndex]?.tagName === step.tagName &&
        filteredSteps[lastChangeIndex]?.inputType === step.inputType
      if (isDuplicate) {
        // Remove the previous change and any intermediate keyboard events after it
        filteredSteps.splice(lastChangeIndex)
        lastChangeIndex = filteredSteps.length
      } else {
        lastChangeIndex = filteredSteps.length
      }
      filteredSteps.push(step)
      continue
    }

    // Skip standalone keyUp events (e.g., Backspace between change events)
    if (step.type === 'keyUp') {
      filteredSteps.push(step)
      continue
    }

    if (step.type === 'keyDown' && i < steps.length - 1) {
      const nextStep = steps[i + 1]
      if (nextStep.type === 'keyUp' && step.key === nextStep.key) {
        filteredSteps.push(step)
        i++ // skip keyUp
        continue
      }
    }

    // Non-keyboard, non-change steps reset the dedup tracking
    lastChangeIndex = -1
    filteredSteps.push(step)
  }

  return filteredSteps
}
