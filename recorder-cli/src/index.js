/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { chromium } from 'playwright'
import { createServer } from './server.js'
import { buildInjectedScript } from './build.js'
import { convertToPlaywright } from './playwright-converter.js'
import { getFrontdoorUrl, sanitizeFrontdoor } from './sf-cli.js'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import chalk from 'chalk'
import fs from 'fs'
import path from 'path'

const browsers = { chromium }

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
    saveAuth,
    loadAuth,
    org
  } = options

  // Build the injected script bundle
  console.log(chalk.gray('  Building injected scripts...'))
  const injectedScript = await buildInjectedScript()

  // Start WebSocket server for communication
  const { server, port, events } = await createServer()
  console.log(chalk.gray(`  WebSocket server on port ${port}`))

  // Launch the browser — CDP isolated worlds require Chromium
  const browserType = browsers.chromium

  // Ensure Chromium is installed using the bundled Playwright CLI
  // (must match the exact playwright version in our node_modules)
  const nodeRequire = createRequire(import.meta.url)
  const playwrightPkgDir = path.dirname(nodeRequire.resolve('playwright/package.json'))
  const playwrightCliPath = path.join(playwrightPkgDir, 'cli.js')
  const chromiumPath = browserType.executablePath()

  if (!fs.existsSync(chromiumPath)) {
    console.log(chalk.yellow(`  Chromium not found at: ${chromiumPath}`))
    console.log(chalk.yellow('  Installing Chromium...'))
    try {
      execFileSync(process.execPath, [playwrightCliPath, 'install', 'chromium'], { stdio: 'inherit' })
      console.log(chalk.green('  ✓ Chromium installed'))
    } catch (e) {
      throw new Error(`Failed to install Chromium: ${e.message}. Run "npx playwright install chromium" manually.`)
    }
  }

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

    // If an auth-state file exists, load it as storageState so device cookies
    // (sfdc_lv2) are present — this skips the identity verification screen
    // while still replaying login steps (since session cookies are stripped).
    let authStatePath = null
    if (loadAuth) {
      const resolved = path.resolve(loadAuth)
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        authStatePath = resolved
      }
    } else if (saveAuth) {
      const resolved = path.resolve(saveAuth)
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        let hostname
        try { hostname = new URL(url).hostname } catch {}
        if (hostname) {
          const match = fs.readdirSync(resolved).find((f) => f.startsWith(hostname + '---') && f.endsWith('.json'))
          authStatePath = match ? path.join(resolved, match) : null
        }
      } else if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        authStatePath = resolved
      }
    }
    const hasAuthState = !!authStatePath

    context = await browserInstance.newContext({
      viewport: { width: parseInt(viewportWidth), height: parseInt(viewportHeight) },
      permissions,
      ...(hasAuthState && { storageState: authStatePath })
    })
    page = await context.newPage()

    if (hasAuthState) {
      console.log(chalk.gray(`  Loaded device cookies from: ${authStatePath}`))
    }
  }

  // Inject the recorder into an ISOLATED world via CDP.
  // This matches how the Chrome extension content scripts work:
  // - Own copy of DOM APIs (unpatched by LWC)
  // - composedPath() exposes deep open-shadow targets when event.target is retargeted
  // - No interference from page-level JavaScript
  const cdpSession = await context.newCDPSession(page)

  const mainTabId = 'tab-1'
  let nextTabNumber = 2
  let isRecordingReady = false
  let isFinishing = false
  const attachedPages = new WeakMap()
  const pageStatesByTabId = new Map()

  const buildInitScriptContent = (tabId) => `
    window.__sfRecorderConfig = {
      wsPort: ${port},
      dataAttribute: ${JSON.stringify(dataAttribute || '')},
      tabId: ${JSON.stringify(tabId)}
    };
    ${injectedScript}
  `
  const initScriptContent = buildInitScriptContent(mainTabId)

  // Enable Page domain events so we can listen for navigations
  await cdpSession.send('Page.enable')

  await cdpSession.send('Page.addScriptToEvaluateOnNewDocument', {
    source: initScriptContent,
    worldName: 'SalesforceRecorderIsolated'
  })

  // Recording state - viewport is always the first step
  const recording = []
  let nextRecordingSequence = 0
  const pendingInjectedMessages = []
  let isPaused = false
  let pauseStartedAt = null
  const completedPauseIntervals = []
  let hasGoto = false
  let hasViewPort = false
  let hasHandledInitialNavigation = false

  // Browser events use epoch-millisecond timestamps. Normalize them onto an
  // active-recording clock so time spent paused is never replayed later.
  const recordingEventTime = (eventTime = Date.now()) => {
    const timestamp = Number.isFinite(eventTime) ? eventTime : Date.now()
    const completedPauseDuration = completedPauseIntervals.reduce((duration, interval) => {
      if (timestamp <= interval.start) return duration
      return duration + Math.max(0, Math.min(timestamp, interval.end) - interval.start)
    }, 0)
    const currentPauseDuration = isPaused && Number.isFinite(pauseStartedAt) && timestamp > pauseStartedAt
      ? timestamp - pauseStartedAt
      : 0
    return timestamp - completedPauseDuration - currentPauseDuration
  }

  const eventOccurredWhilePaused = (eventTime) => {
    if (!Number.isFinite(eventTime)) return isPaused
    if (completedPauseIntervals.some(({ start, end }) => eventTime >= start && eventTime < end)) {
      return true
    }
    return isPaused && Number.isFinite(pauseStartedAt) && eventTime >= pauseStartedAt
  }

  const eventOccurredInCompletedPause = (eventTime) => Number.isFinite(eventTime) &&
    completedPauseIntervals.some(({ start, end }) => eventTime >= start && eventTime < end)

  // Lifecycle signals and injected recorder messages arrive over independent
  // transports. Keep their causal timestamp separate from lifecycle completion
  // timing so delayed WebSocket messages can be reordered before the navigation
  // or close they triggered.
  const appendRecordingEvent = (event, {
    orderEventTime,
    rawOrderEventTime,
    rawEventTime,
    lifecycle = false,
    pauseSensitive = false
  } = {}) => {
    const orderedAt = Number.isFinite(rawOrderEventTime)
      ? recordingEventTime(rawOrderEventTime)
      : (Number.isFinite(orderEventTime)
          ? orderEventTime
          : (Number.isFinite(event.eventTime) ? event.eventTime : recordingEventTime()))
    if (Number.isFinite(rawOrderEventTime)) event.__rawOrderEventTime = rawOrderEventTime
    if (Number.isFinite(rawEventTime)) event.__rawEventTime = rawEventTime
    if (pauseSensitive) {
      event.__pauseSensitive = true
      event.__observedWhilePaused = isPaused
    }
    event.__orderEventTime = orderedAt
    event.__orderPriority = lifecycle ? 1 : 0
    event.__recordingSequence = nextRecordingSequence++
    // While a pause is active its eventual end timestamp may already have
    // occurred on another transport. Keep lifecycle events provisionally and
    // classify them once UNPAUSE (or STOP) supplies the complete interval.
    if (!(pauseSensitive && eventOccurredInCompletedPause(rawOrderEventTime))) recording.push(event)
    return event
  }

  const reclassifyLifecycleEventsForPause = ({ start, end }) => {
    const occurredDuringPause = (eventTime) => Number.isFinite(eventTime) &&
      eventTime >= start && eventTime < end

    for (const state of pageStatesByTabId.values()) {
      if (state.tabId !== mainTabId &&
          (occurredDuringPause(state.rawOpenedAt) ||
            (state.openedWhilePaused && state.rawOpenedAt === end))) {
        state.recorded = false
      }
    }

    // A popup whose opener was ignored must also be ignored, even when the
    // child itself opened after the pause interval.
    let changed
    do {
      changed = false
      for (const state of pageStatesByTabId.values()) {
        if (state.tabId === mainTabId || state.recorded === false || state.openerTabId == null) continue
        if (pageStatesByTabId.get(state.openerTabId)?.recorded === false) {
          state.recorded = false
          changed = true
        }
      }
    } while (changed)

    for (let index = recording.length - 1; index >= 0; index--) {
      const event = recording[index]
      const pageState = event.tabId == null ? null : pageStatesByTabId.get(event.tabId)
      const shouldDiscard = (event.__pauseSensitive &&
          (occurredDuringPause(event.__rawOrderEventTime) ||
            (event.__observedWhilePaused && event.__rawOrderEventTime === end))) ||
        (event.tabId !== mainTabId && pageState?.recorded === false)
      if (shouldDiscard) {
        recording.splice(index, 1)
        continue
      }
      if (Number.isFinite(event.__rawOrderEventTime)) {
        event.__orderEventTime = recordingEventTime(event.__rawOrderEventTime)
      }
      if (Number.isFinite(event.__rawEventTime)) {
        event.eventTime = recordingEventTime(event.__rawEventTime)
      }
    }
  }

  let mainFrameId = null
  try {
    const { frameTree } = await cdpSession.send('Page.getFrameTree')
    mainFrameId = frameTree?.frame?.id || null
  } catch {}

  let topFrameNavigationInProgress = false
  let topFrameNavigationStartedWhileRecording = false
  let topFrameNavigationRawOrderEventTime = null
  let topFrameNavigationLoaderId = null
  let currentTopFrameLoaderId = null
  let pendingTopFrameRendererNavigation = false
  const recordedTopFrameReloadLoaders = new Set()
  const isTopFrame = (frameId) => !mainFrameId || frameId === mainFrameId
  const trackTopFrameNavigationStart = ({ frameId, loaderId } = {}, rawOrderEventTime = Date.now()) => {
    if (!isTopFrame(frameId)) return
    const supersedesPendingNavigation = topFrameNavigationInProgress && loaderId &&
      topFrameNavigationLoaderId && loaderId !== topFrameNavigationLoaderId
    if (!topFrameNavigationInProgress || supersedesPendingNavigation) {
      topFrameNavigationInProgress = true
      topFrameNavigationStartedWhileRecording = !eventOccurredInCompletedPause(rawOrderEventTime)
      topFrameNavigationRawOrderEventTime = rawOrderEventTime
    }
    if (loaderId) {
      currentTopFrameLoaderId = loaderId
      topFrameNavigationLoaderId = loaderId
    }
  }

  cdpSession.on('Page.frameRequestedNavigation', (params = {}) => {
    if (params.disposition != null && params.disposition !== 'currentTab') return
    if (isTopFrame(params.frameId)) pendingTopFrameRendererNavigation = true
    trackTopFrameNavigationStart(params, Date.now())
  })
  cdpSession.on('Page.frameStartedNavigating', (params = {}) => {
    if (!isTopFrame(params.frameId)) return
    const rawNavigationTime = Date.now()
    const isRendererInitiated = pendingTopFrameRendererNavigation
    pendingTopFrameRendererNavigation = false
    trackTopFrameNavigationStart(params, rawNavigationTime)

    const isBrowserReload = params.navigationType === 'reload' ||
      params.navigationType === 'reloadBypassingCache'
    const loaderWasRecorded = params.loaderId && recordedTopFrameReloadLoaders.has(params.loaderId)
    if (isTopFrame(params.frameId) && isBrowserReload && !isRendererInitiated &&
        !loaderWasRecorded && isRecordingReady) {
      if (params.loaderId) recordedTopFrameReloadLoaders.add(params.loaderId)
      const rawReloadTime = topFrameNavigationRawOrderEventTime ?? rawNavigationTime
      appendRecordingEvent({
        selector: undefined,
        action: 'RELOAD',
        tabId: mainTabId,
        eventTime: recordingEventTime(rawReloadTime)
      }, {
        rawOrderEventTime: rawReloadTime,
        rawEventTime: rawReloadTime,
        pauseSensitive: true
      })
      // This cannot be the startup commit; do not let same-URL suppression
      // discard the completion marker that belongs to the reload.
      hasHandledInitialNavigation = true
    }
  })
  cdpSession.on('Page.frameStartedLoading', (params = {}) => {
    trackTopFrameNavigationStart(params, Date.now())
  })
  const clearTopFrameNavigation = ({ frameId } = {}) => {
    if (!isTopFrame(frameId)) return
    topFrameNavigationInProgress = false
    topFrameNavigationStartedWhileRecording = false
    topFrameNavigationRawOrderEventTime = null
    topFrameNavigationLoaderId = null
    pendingTopFrameRendererNavigation = false
  }
  cdpSession.on('Page.frameStoppedLoading', clearTopFrameNavigation)
  cdpSession.on('Page.frameClearedScheduledNavigation', clearTopFrameNavigation)

  // Pre-record viewport as the first entry
  appendRecordingEvent({
    selector: undefined,
    value: { width: parseInt(viewportWidth), height: parseInt(viewportHeight) },
    action: 'VIEWPORT',
    eventTime: recordingEventTime()
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
      const rawNavigationCommitTime = Date.now()
      if (params.frame.id) mainFrameId = params.frame.id
      if (params.frame.loaderId) currentTopFrameLoaderId = params.frame.loaderId
      const navUrl = params.frame.url
      const navigationLoaderId = params.frame.loaderId
      const shouldRecordNavigation = topFrameNavigationInProgress
        ? topFrameNavigationStartedWhileRecording
        : !eventOccurredInCompletedPause(rawNavigationCommitTime)
      // console.log(chalk.blue(`  ↳ Navigation: ${navUrl}`))

      // Don't record the initial navigation (already handled as GOTO)
      if (navUrl && navUrl !== 'about:blank' && hasGoto && shouldRecordNavigation) {
        const initialGoto = recording.find(r => r.action === 'GOTO')
        // Only the first top-frame navigation can be the startup GOTO. A later
        // return to the same URL is a real navigation and must be retained.
        const suppressInitialNavigation = !hasHandledInitialNavigation &&
          initialGoto?.href === navUrl
        hasHandledInitialNavigation = true

        if (!suppressInitialNavigation) {
          // Preserve causal ordering immediately. Waiting for page.title()
          // before appending can let the user's first post-navigation click
          // overtake this marker and receive the navigation assertion.
          const navigationEvent = appendRecordingEvent({
            selector: undefined,
            value: navUrl,
            title: '',
            action: 'NAVIGATION',
            tabId: mainTabId
          }, {
            rawOrderEventTime: topFrameNavigationRawOrderEventTime ?? rawNavigationCommitTime,
            lifecycle: true,
            pauseSensitive: true
          })

          try {
            await page.waitForLoadState('domcontentloaded')
            if (navigationLoaderId && currentTopFrameLoaderId !== navigationLoaderId) return
            // The replay action already waits through navigation. Use the
            // lifecycle completion as the baseline so only the user's real
            // post-load pause is emitted before their next action.
            const rawNavigationCompletionTime = Date.now()
            navigationEvent.__rawEventTime = rawNavigationCompletionTime
            navigationEvent.eventTime = recordingEventTime(rawNavigationCompletionTime)
            navigationEvent.title = await page.title()
          } catch (e) { /* page may still be loading */ }
          // console.log(chalk.blue(`    ✓ Recorded navigation`))
        }
      }

      // Re-inject as safety net
      setTimeout(() => injectRecorder(), 100)
    }
  })

  const mainPageState = {
    page,
    tabId: mainTabId,
    recorded: true,
    closed: false
  }
  attachedPages.set(page, mainPageState)
  pageStatesByTabId.set(mainTabId, mainPageState)

  const safePageUrl = (targetPage) => {
    try {
      return targetPage.url?.() || 'about:blank'
    } catch {
      return 'about:blank'
    }
  }

  const setupPopupPage = (popupPage) => {
    const existingState = attachedPages.get(popupPage)
    if (existingState) return existingState.ready || Promise.resolve(existingState)

    const tabId = `tab-${nextTabNumber++}`
    const popupOpenedRawAt = Date.now()
    // An active pause may already have ended at the source while its UNPAUSE
    // message is still in flight. Keep the popup provisional until that pause
    // interval is complete, then reclassify it from this raw timestamp.
    const recorded = isRecordingReady && !eventOccurredInCompletedPause(popupOpenedRawAt)
    const state = {
      page: popupPage,
      tabId,
      recorded,
      rawOpenedAt: popupOpenedRawAt,
      openedWhilePaused: isPaused,
      closed: false,
      openerTabId: null,
      recordingEligibilityResolved: false,
      pendingCloseEventTime: null,
      mainFrameId: null,
      currentLoaderId: null,
      navigationInProgress: false,
      navigationStartedWhileRecording: recorded,
      navigationRawOrderEventTime: null,
      navigationLoaderId: null,
      pendingRendererNavigation: false,
      recordedReloadLoaders: new Set(),
      seenLoaderIds: new Set(),
      initialNavigationClaimed: false,
      initialNavigationEvent: null,
      ready: null
    }
    attachedPages.set(popupPage, state)
    pageStatesByTabId.set(tabId, state)

    const recordPopupOpen = () => {
      if (!state.recorded || state.initialNavigationEvent) return
      state.initialNavigationEvent = appendRecordingEvent({
        selector: undefined,
        value: safePageUrl(popupPage),
        title: '',
        action: 'NAVIGATION',
        tabId
      }, {
        rawOrderEventTime: popupOpenedRawAt,
        lifecycle: true,
        pauseSensitive: true
      })
    }
    const recordPopupClose = (rawCloseEventTime) => {
      if (!state.recorded) return
      appendRecordingEvent({
        selector: undefined,
        action: 'WINDOW_OR_TAB_CLOSED',
        tabId,
        eventTime: recordingEventTime(rawCloseEventTime)
      }, {
        rawOrderEventTime: rawCloseEventTime,
        rawEventTime: rawCloseEventTime,
        lifecycle: true
      })
    }

    if (typeof popupPage.on === 'function') {
      popupPage.on('close', () => {
        if (state.closed) return
        state.closed = true
        if (!isFinishing) {
          const rawCloseEventTime = Date.now()
          if (state.recordingEligibilityResolved) recordPopupClose(rawCloseEventTime)
          else state.pendingCloseEventTime = rawCloseEventTime
        }
      })
    }

    const isTopPopupFrame = (frameId) => !state.mainFrameId || frameId === state.mainFrameId
    const trackPopupNavigationStart = ({ frameId, loaderId } = {}, rawOrderEventTime = Date.now()) => {
      if (!isTopPopupFrame(frameId)) return
      const supersedesPendingNavigation = state.navigationInProgress && loaderId &&
        state.navigationLoaderId && loaderId !== state.navigationLoaderId
      if (!state.navigationInProgress || supersedesPendingNavigation) {
        state.navigationInProgress = true
        state.navigationStartedWhileRecording = !eventOccurredInCompletedPause(rawOrderEventTime)
        state.navigationRawOrderEventTime = rawOrderEventTime
      }
      if (loaderId) {
        state.currentLoaderId = loaderId
        state.navigationLoaderId = loaderId
      }
    }
    const clearPopupNavigation = ({ frameId } = {}) => {
      if (!isTopPopupFrame(frameId)) return
      state.navigationInProgress = false
      state.navigationStartedWhileRecording = false
      state.navigationRawOrderEventTime = null
      state.navigationLoaderId = null
      state.pendingRendererNavigation = false
    }

    const finalizePopupNavigation = async (navigationEvent, loaderId) => {
      try {
        await popupPage.waitForLoadState('domcontentloaded')
        if (state.closed || popupPage.isClosed?.()) return
        if (loaderId && state.currentLoaderId && loaderId !== state.currentLoaderId) return
        const rawNavigationCompletionTime = Date.now()
        navigationEvent.__rawEventTime = rawNavigationCompletionTime
        navigationEvent.eventTime = recordingEventTime(rawNavigationCompletionTime)
        navigationEvent.title = await popupPage.title()
      } catch (e) { /* popup may have navigated again or closed */ }
    }

    const handlePopupNavigation = (frame = {}, rawNavigationCommitTime = Date.now()) => {
      if (frame.parentId) return
      if (frame.id) state.mainFrameId = frame.id
      if (frame.loaderId) {
        if (state.seenLoaderIds.has(frame.loaderId)) return
        state.seenLoaderIds.add(frame.loaderId)
        state.currentLoaderId = frame.loaderId
      }

      const isInitialNavigation = Boolean(
        state.initialNavigationEvent && !state.initialNavigationClaimed
      )
      const navUrl = frame.url || safePageUrl(popupPage)
      if (!isInitialNavigation && (!navUrl || navUrl === 'about:blank')) return

      const shouldRecordNavigation = state.navigationInProgress
        ? state.navigationStartedWhileRecording
        : !eventOccurredInCompletedPause(rawNavigationCommitTime)
      if (!state.recorded || (!isInitialNavigation && !shouldRecordNavigation)) return

      const navigationEvent = isInitialNavigation
        ? state.initialNavigationEvent
        : appendRecordingEvent({
            selector: undefined,
            value: navUrl,
            title: '',
            action: 'NAVIGATION',
            tabId
          }, {
            rawOrderEventTime: state.navigationRawOrderEventTime ?? rawNavigationCommitTime,
            lifecycle: true,
            pauseSensitive: true
          })

      if (isInitialNavigation) {
        state.initialNavigationClaimed = true
        navigationEvent.value = navUrl
      }

      void finalizePopupNavigation(navigationEvent, frame.loaderId)
    }

    state.ready = (async () => {
      try {
        const openerPage = await popupPage.opener?.()
        const openerState = openerPage ? attachedPages.get(openerPage) : null
        if (openerState?.ready) await openerState.ready
        if (openerState?.recorded === false) state.recorded = false
        if (openerState?.tabId != null) {
          state.openerTabId = openerState.tabId
        }

        // Resolve opener provenance before reserving the marker. The stored
        // popup-open timestamp still restores its causal position if this await
        // lets another transport deliver an action first.
        recordPopupOpen()
        if (state.initialNavigationEvent && state.openerTabId != null) {
          state.initialNavigationEvent.openerTabId = state.openerTabId
        }
        state.recordingEligibilityResolved = true
        if (Number.isFinite(state.pendingCloseEventTime)) {
          recordPopupClose(state.pendingCloseEventTime)
          state.pendingCloseEventTime = null
        }

        const popupSession = await context.newCDPSession(popupPage)
        state.cdpSession = popupSession
        await popupSession.send('Page.enable')

        popupSession.on('Page.frameRequestedNavigation', (params = {}) => {
          if (params.disposition != null && params.disposition !== 'currentTab') return
          if (isTopPopupFrame(params.frameId)) state.pendingRendererNavigation = true
          trackPopupNavigationStart(params, Date.now())
        })
        popupSession.on('Page.frameStartedNavigating', (params = {}) => {
          if (!isTopPopupFrame(params.frameId)) return
          const rawNavigationTime = Date.now()
          const isRendererInitiated = state.pendingRendererNavigation
          state.pendingRendererNavigation = false
          trackPopupNavigationStart(params, rawNavigationTime)

          const isBrowserReload = params.navigationType === 'reload' ||
            params.navigationType === 'reloadBypassingCache'
          const loaderWasRecorded = params.loaderId && state.recordedReloadLoaders.has(params.loaderId)
          if (isBrowserReload && !isRendererInitiated && !loaderWasRecorded && state.recorded) {
            if (params.loaderId) state.recordedReloadLoaders.add(params.loaderId)
            const rawReloadTime = state.navigationRawOrderEventTime ?? rawNavigationTime
            appendRecordingEvent({
              selector: undefined,
              action: 'RELOAD',
              tabId,
              eventTime: recordingEventTime(rawReloadTime)
            }, {
              rawOrderEventTime: rawReloadTime,
              rawEventTime: rawReloadTime,
              pauseSensitive: true
            })
          }
        })
        popupSession.on('Page.frameStartedLoading', (params = {}) => {
          trackPopupNavigationStart(params, Date.now())
        })
        popupSession.on('Page.frameStoppedLoading', clearPopupNavigation)
        popupSession.on('Page.frameClearedScheduledNavigation', clearPopupNavigation)
        popupSession.on('Page.frameNavigated', ({ frame } = {}) => {
          handlePopupNavigation(frame, Date.now())
        })

        const popupInitScript = buildInitScriptContent(tabId)
        await popupSession.send('Page.addScriptToEvaluateOnNewDocument', {
          source: popupInitScript,
          worldName: 'SalesforceRecorderIsolated'
        })

        const { frameTree } = await popupSession.send('Page.getFrameTree')
        const currentFrame = frameTree?.frame
        if (currentFrame) handlePopupNavigation(currentFrame, popupOpenedRawAt)

        if (currentFrame?.id && !state.closed) {
          const { executionContextId } = await popupSession.send('Page.createIsolatedWorld', {
            frameId: currentFrame.id,
            worldName: 'SalesforceRecorderIsolated',
            grantUniveralAccess: true
          })
          await popupSession.send('Runtime.evaluate', {
            expression: popupInitScript,
            contextId: executionContextId,
            awaitPromise: false
          })
        }
      } catch (e) {
        // The popup may close before CDP attachment completes.
        state.recordingEligibilityResolved = true
        recordPopupOpen()
        if (Number.isFinite(state.pendingCloseEventTime)) {
          recordPopupClose(state.pendingCloseEventTime)
          state.pendingCloseEventTime = null
        }
      }
      return state
    })()

    return state.ready
  }

  context.on('page', (popupPage) => {
    void setupPopupPage(popupPage)
  })

  // Handle incoming messages from the injected script
  const rawMessageOrderTime = (msg) => Number.isFinite(msg.orderEventTime)
    ? msg.orderEventTime
    : (Number.isFinite(msg.eventTime) ? msg.eventTime : Date.now())
  const appendInjectedMessage = (msg) => {
    const sourcePageState = msg.tabId == null ? null : pageStatesByTabId.get(msg.tabId)
    const isIgnoredPage = msg.tabId != null && sourcePageState?.recorded === false
    const rawOrderEventTime = rawMessageOrderTime(msg)
    if (!eventOccurredWhilePaused(rawOrderEventTime) && !isIgnoredPage) {
      // Add frame info
      const eventTime = recordingEventTime(msg.eventTime)
      const orderEventTime = recordingEventTime(rawOrderEventTime)
      appendRecordingEvent({
        ...msg,
        __rawOrderEventTime: rawOrderEventTime,
        __sourceMessage: msg,
        tabId: msg.tabId ?? mainTabId,
        frameId: msg.frameId || 0,
        frameUrl: msg.frameUrl || null,
        frameIndex: msg.frameIndex || null,
        eventTime
      }, { orderEventTime })
    }
  }
  const flushPendingInjectedMessages = () => {
    const pending = pendingInjectedMessages.splice(0)
    const relevantPause = isPaused && Number.isFinite(pauseStartedAt)
      ? { start: pauseStartedAt, end: Number.POSITIVE_INFINITY }
      : completedPauseIntervals.at(-1)
    for (const { msg, receivedWhilePaused } of pending) {
      const rawOrderEventTime = rawMessageOrderTime(msg)
      const wasObservedDuringRelevantPause = receivedWhilePaused && relevantPause &&
        rawOrderEventTime >= relevantPause.start && rawOrderEventTime <= relevantPause.end
      if (!wasObservedDuringRelevantPause) appendInjectedMessage(msg)
    }
  }

  const completeActivePause = (rawEndEventTime = Date.now()) => {
    if (!isPaused || !Number.isFinite(pauseStartedAt)) return false
    const interval = {
      start: pauseStartedAt,
      end: Math.max(pauseStartedAt, rawEndEventTime)
    }
    completedPauseIntervals.push(interval)
    pauseStartedAt = null
    isPaused = false
    reclassifyLifecycleEventsForPause(interval)
    return true
  }

  events.on('message', (msg) => {
    if (msg.control) {
      handleControlMessage(msg)
      return
    }

    if (isPaused) {
      pendingInjectedMessages.push({ msg, receivedWhilePaused: true })
      return
    }
    appendInjectedMessage(msg)
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
          appendRecordingEvent({
            selector: undefined,
            value: { width: parseInt(viewportWidth), height: parseInt(viewportHeight) },
            action: 'VIEWPORT',
            eventTime: recordingEventTime()
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
        if (!isPaused) {
          appendRecordingEvent({
            selector: undefined,
            value,
            action: 'SCREENSHOT',
            eventTime: recordingEventTime()
          })
        }
        break
    }
  }

  function handleOverlayAction(msg) {
    const { action } = msg
    const controlEventTime = Number.isFinite(msg.eventTime) ? msg.eventTime : Date.now()

    switch (action) {
      case 'STOP':
        completeActivePause(controlEventTime)
        flushPendingInjectedMessages()
        finishRecording()
        break
      case 'PAUSE':
        if (!isPaused) {
          pauseStartedAt = controlEventTime
          isPaused = true
          // A message from another tab can overtake the pause control's socket.
          // Pull those future-source events back out until UNPAUSE gives us the
          // complete interval and we can classify them accurately.
          for (let index = recording.length - 1; index >= 0; index--) {
            const recordedEvent = recording[index]
            if (recordedEvent.__sourceMessage &&
                recordedEvent.__rawOrderEventTime >= pauseStartedAt) {
              pendingInjectedMessages.unshift({
                msg: recordedEvent.__sourceMessage,
                receivedWhilePaused: false
              })
              recording.splice(index, 1)
            }
          }
        }
        console.log(chalk.yellow('  ⏸  Recording paused'))
        break
      case 'UNPAUSE':
        if (completeActivePause(controlEventTime)) {
          flushPendingInjectedMessages()
        }
        console.log(chalk.green('  ▶  Recording resumed'))
        break
      case 'RESTART':
        recording.length = 0
        hasGoto = false
        hasViewPort = false
        isPaused = false
        pauseStartedAt = null
        completedPauseIntervals.length = 0
        pendingInjectedMessages.length = 0
        hasHandledInitialNavigation = false
        console.log(chalk.blue('  🔄 Recording restarted'))
        break
    }
  }

  async function finishRecording() {
    if (isFinishing) return
    isFinishing = true
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

    // Save device-identity cookies (sfdc_lv2, BrowserId) for MFA bypass on playback.
    // We strip session cookies (sid, oid, etc.) so the login steps still execute
    // but Salesforce skips the identity verification screen.
    if (saveAuth) {
      try {
        const authPath = resolveAuthStatePath(saveAuth, recording, recordedUrl)
        fs.mkdirSync(path.dirname(authPath), { recursive: true })
        const fullState = await context.storageState()
        const deviceState = stripSessionCookies(fullState)
        fs.writeFileSync(authPath, JSON.stringify(deviceState, null, 2))

        const keptCookies = deviceState.cookies.map(c => c.name)
        if (keptCookies.length > 0) {
          console.log(chalk.green(`  ✓ Device identity cookies saved to: ${authPath}`))
          console.log(chalk.gray(`    Kept: ${keptCookies.join(', ')}`))
          console.log(chalk.gray(`    (Session cookies stripped — login steps will still replay)`))
        } else {
          console.log(chalk.yellow(`  ⚠ No device identity cookies found to save.`))
          console.log(chalk.gray(`    The auth file was saved but may not bypass MFA.`))
        }
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
    if (isFinishing) return
    isFinishing = true
    completeActivePause(Date.now())
    flushPendingInjectedMessages()
    if (recording.length > 0) {
      console.log(chalk.yellow('\n  Browser closed. Saving recording...'))

      // Try to save device-identity cookies before context is fully destroyed
      if (saveAuth) {
        try {
          const authPath = resolveAuthStatePath(saveAuth, recording, recordedUrl)
          fs.mkdirSync(path.dirname(authPath), { recursive: true })
          const fullState = await context.storageState()
          const deviceState = stripSessionCookies(fullState)
          fs.writeFileSync(authPath, JSON.stringify(deviceState, null, 2))
          console.log(chalk.green(`  ✓ Device identity cookies saved to: ${authPath}`))
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

  // Resolve where to navigate. With --org, log in via the Salesforce CLI's
  // org session instead of the login form — no credentials or MFA prompt,
  // since the CLI already holds a valid OAuth token for that org. The
  // frontdoor URL carries a live session token (sid), so it's used only
  // for the actual page.goto() — the recording (and every log line) gets
  // the sanitized destination instead, never the token.
  let navigationUrl = url
  let recordedUrl = url
  if (org) {
    console.log(chalk.gray(`  Logging in via Salesforce CLI org: ${org}...`))
    let orgPath
    if (url && url !== 'about:blank') {
      try {
        const parsedUrl = new URL(url)
        orgPath = parsedUrl.pathname + parsedUrl.search + parsedUrl.hash
      } catch {
        orgPath = url // not a full URL — treat as a bare path
      }
    }
    const frontdoorUrl = await getFrontdoorUrl(org, orgPath ? { path: orgPath } : {})
    navigationUrl = frontdoorUrl
    recordedUrl = sanitizeFrontdoor(frontdoorUrl)
    console.log(chalk.green(`  ✓ Logged in as ${org} (no password or MFA prompt needed)`))
  }

  // Navigate to the starting URL
  if (navigationUrl && navigationUrl !== 'about:blank') {
    // Pre-record the GOTO before navigation triggers the injected script
    const gotoEvent = {
      selector: undefined,
      title: '',
      action: 'GOTO',
      href: recordedUrl,
      tabId: mainTabId,
      eventTime: recordingEventTime()
    }
    appendRecordingEvent(gotoEvent, { orderEventTime: gotoEvent.eventTime })
    hasGoto = true

    await page.goto(navigationUrl)
    gotoEvent.endEventTime = recordingEventTime()

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

  isRecordingReady = true
  console.log(chalk.green('  ✓ Recording started! Interact with the page.'))
  console.log(chalk.gray('  Use the overlay controls or close the browser to stop.\n'))

  // Keep the process alive
  await new Promise(() => {})
}

function orderRecordedEvents(events) {
  if (!events.some(event => Number.isFinite(event?.__orderEventTime))) return events

  const indexedEvents = events.map((event, index) => ({ event, index }))
  const sequenceFor = ({ event, index }) => Number.isFinite(event.__recordingSequence)
    ? event.__recordingSequence
    : index
  const compareOrderedEntries = (left, right) => {
    const leftTime = left.event.__orderEventTime
    const rightTime = right.event.__orderEventTime
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime
    }
    return sequenceFor(left) - sequenceFor(right)
  }

  // Each page has its own WebSocket, so arrival order is authoritative only
  // within that tab. Merge the per-tab FIFO streams by their shared epoch
  // timestamps; this lets a delayed popup message move ahead of a newer main-
  // page message without ever reordering two actions from the same page.
  const untabbedEvents = Symbol('untabbed-events')
  const capturedQueues = new Map()
  for (const entry of indexedEvents.filter(({ event }) => event.__orderPriority !== 1)) {
    const key = entry.event.__streamId ?? entry.event.tabId ?? untabbedEvents
    if (!capturedQueues.has(key)) capturedQueues.set(key, [])
    capturedQueues.get(key).push(entry)
  }
  const capturedEntries = []
  while (capturedQueues.size > 0) {
    let selectedKey
    let selectedEntry
    for (const [key, queue] of capturedQueues) {
      const candidate = queue[0]
      if (!selectedEntry || compareOrderedEntries(candidate, selectedEntry) < 0) {
        selectedKey = key
        selectedEntry = candidate
      }
    }
    capturedEntries.push(selectedEntry)
    const selectedQueue = capturedQueues.get(selectedKey)
    selectedQueue.shift()
    if (selectedQueue.length === 0) capturedQueues.delete(selectedKey)
  }
  const capturedEvents = capturedEntries.map(({ event }) => event)
  const lifecycleEntries = indexedEvents
    .filter(({ event }) => event.__orderPriority === 1)
    .sort(compareOrderedEntries)
  const lifecycleBySlot = Array.from({ length: capturedEvents.length + 1 }, () => [])

  for (const lifecycleEntry of lifecycleEntries) {
    const lifecycleEvent = lifecycleEntry.event
    let slot = 0
    // Lifecycle markers occupy their global chronological position. In
    // particular, a popup close at t=400 must remain after an opener action at
    // t=300 even when the popup's own last action happened at t=200.
    for (let index = 0; index < capturedEvents.length; index++) {
      const capturedTime = capturedEvents[index].__orderEventTime
      if (Number.isFinite(capturedTime) && capturedTime <= lifecycleEvent.__orderEventTime) {
        slot = index + 1
      }
    }
    if (slot === 0) {
      // Partially annotated test/legacy events fall back to capture sequence.
      for (let index = 0; index < capturedEntries.length; index++) {
        if (sequenceFor(capturedEntries[index]) <= sequenceFor(lifecycleEntry)) {
          slot = index + 1
        }
      }
    }
    lifecycleBySlot[slot].push(lifecycleEvent)
  }

  const orderedEvents = [...lifecycleBySlot[0]]
  capturedEvents.forEach((event, index) => {
    orderedEvents.push(event, ...lifecycleBySlot[index + 1])
  })
  return orderedEvents
}

function navigationTargetTabId(assertedEvent) {
  return assertedEvent?.__targetTabId
}

function setNavigationTargetTabId(assertedEvent, targetTabId) {
  Object.defineProperty(assertedEvent, '__targetTabId', {
    value: targetTabId,
    configurable: true,
    enumerable: false,
    writable: true
  })
  return assertedEvent
}

// Exported as a pure normalization seam for the isolated exploratory-testing
// harness. The normal recorder still owns collection and persistence.
export function generateUserFlow(events, options) {
  // TODO: Replace with full Playwright script generation later
  const steps = []
  const openTabIds = new Set()
  const orderedEvents = orderRecordedEvents(events)
  let activeTabId

  const findLastStepForTab = (targetTabId, { includePopupOwner = false } = {}) => {
    for (let index = steps.length - 1; index >= 0; index--) {
      const step = steps[index]
      if (step.type === 'setViewport') continue
      if (step.__tabId === targetTabId) return index
      if (includePopupOwner && step.assertedEvents?.some(assertedEvent =>
        assertedEvent.type === 'navigation' && navigationTargetTabId(assertedEvent) === targetTabId
      )) return index
    }
    return -1
  }
  const findLastReplayableStep = () => {
    for (let index = steps.length - 1; index >= 0; index--) {
      if (steps[index].type !== 'setViewport' &&
          steps[index].type !== 'screenshot' &&
          steps[index].type !== 'close') return index
    }
    return -1
  }

  for (let i = 0; i < orderedEvents.length; i++) {
    const event = orderedEvents[i]
    const { action, selectors, value, href, keyCode, tagName, frameSelectors, parentSelectors, componentType, key, type, inputType, isContentEditable, coordinates, title, tabId, openerTabId, recordingTargetId } = event
    const timing = Number.isFinite(event.eventTime) ? { __eventTime: event.eventTime } : {}
    const endTiming = Number.isFinite(event.endEventTime) ? { __endEventTime: event.endEventTime } : {}
    const effectiveTabId = tabId ?? activeTabId
    const sourceTab = { __tabId: effectiveTabId }
    if (tabId !== undefined &&
        action !== 'GOTO' && action !== 'NAVIGATION' && action !== 'WINDOW_OR_TAB_CLOSED') {
      activeTabId = tabId
    }
    const hasContentEditableValue = isContentEditable && value !== undefined && value !== null
    const hasCheckableValue = tagName === 'INPUT' &&
      (inputType === 'checkbox' || inputType === 'radio') &&
      typeof value === 'boolean'

    switch (action) {
      case 'GOTO': {
        const isNewTabOrWindow = openTabIds.size > 0 && !openTabIds.has(effectiveTabId)
        const navigation = setNavigationTargetTabId(
          { type: 'navigation', url: href, title: title || '' },
          effectiveTabId
        )
        if (isNewTabOrWindow) navigation.isNewTabOrWindow = true
        const step = {
          type: 'navigate',
          target: 'main',
          url: href,
          ...sourceTab,
          ...timing,
          ...endTiming,
          ...(!Number.isFinite(event.endEventTime) && { __timingBoundaryIncomplete: true }),
          __timingBoundaryAfter: true,
          assertedEvents: [navigation]
        }
        openTabIds.add(effectiveTabId)
        activeTabId = effectiveTabId
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
        const isNewTabOrWindow = !openTabIds.has(effectiveTabId)
        let ownerIndex = isNewTabOrWindow && openerTabId !== undefined
          ? findLastStepForTab(openerTabId)
          : findLastStepForTab(effectiveTabId, { includePopupOwner: true })
        if (ownerIndex === -1) ownerIndex = findLastReplayableStep()

        // Attach the navigation to the action on the page that caused it, even
        // if another tab's WebSocket message was delivered in between.
        if (ownerIndex !== -1) {
          const prevStep = steps[ownerIndex]
          if (prevStep.type !== 'setViewport') {
            const previousAssertedEvents = Array.isArray(prevStep.assertedEvents)
              ? prevStep.assertedEvents
              : []
            const existingNavigation = previousAssertedEvents.find(assertedEvent =>
              assertedEvent.type === 'navigation'
            )
            const navigation = setNavigationTargetTabId(
              { type: 'navigation', url: value, title: title || '' },
              effectiveTabId
            )
            if (existingNavigation?.isNewTabOrWindow === true) {
              navigation.isNewTabOrWindow = true
            }
            prevStep.__timingBoundaryAfter = true
            if (isNewTabOrWindow) {
              navigation.isNewTabOrWindow = true
            }
            prevStep.assertedEvents = [
              navigation,
              ...previousAssertedEvents.filter(assertedEvent => assertedEvent.type !== 'navigation')
            ]
            prevStep.__timingBoundaryIncomplete = !Number.isFinite(event.eventTime)
            if (Number.isFinite(event.eventTime)) {
              prevStep.__endEventTime = Number.isFinite(prevStep.__endEventTime)
                ? Math.max(prevStep.__endEventTime, event.eventTime)
                : event.eventTime
            }
            openTabIds.add(effectiveTabId)
            if (!isNewTabOrWindow || openerTabId !== undefined) activeTabId = effectiveTabId
          }
        }
        break
      }
      case 'RELOAD':
        steps.push({
          type: 'reload',
          target: 'main',
          ...sourceTab,
          ...timing,
          ...endTiming,
          ...(!Number.isFinite(event.endEventTime) && { __timingBoundaryIncomplete: true }),
          __timingBoundaryAfter: true,
          assertedEvents: [{ type: 'navigation', url: '', title: '' }]
        })
        break
      case 'WINDOW_OR_TAB_CLOSED':
        if (findLastReplayableStep() !== -1 &&
            (openTabIds.size === 0 || openTabIds.has(effectiveTabId))) {
          // A manual close is its own replayable action. Keeping it as a step
          // preserves global chronology across tabs, survives intervening
          // screenshots, and represents consecutive closes without collapsing
          // one target or timestamp into another.
          steps.push({
            type: 'close',
            target: 'main',
            ...sourceTab,
            ...timing
          })
          openTabIds.delete(effectiveTabId)
          if (activeTabId === effectiveTabId) activeTabId = [...openTabIds].at(-1)
        }
        break
      case 'click':
        steps.push({
          type: 'click',
          target: 'main',
          ...sourceTab,
          selectors: selectors || [],
          ...(frameSelectors && { frameSelectors }),
          ...(coordinates && { offsetX: coordinates.x, offsetY: coordinates.y }),
          tagName,
          inputType,
          ...timing,
          ...(parentSelectors && { parentSelectors, componentType }),
          ...(event.frameIndex && { frame: event.frameIndex })
        })
        break
      case 'dblclick':
        steps.push({
          type: 'doubleClick',
          target: 'main',
          ...sourceTab,
          selectors: selectors || [],
          ...(frameSelectors && { frameSelectors }),
          ...(coordinates && { offsetX: coordinates.x, offsetY: coordinates.y }),
          tagName,
          inputType,
          ...timing,
          ...(event.frameIndex && { frame: event.frameIndex })
        })
        break
      case 'change':
        if (tagName === 'SELECT') {
          steps.push({
            type: 'change',
            target: 'main',
            ...sourceTab,
            selectors: selectors || [],
            ...(frameSelectors && { frameSelectors }),
            value,
            tagName,
            inputType,
            ...(isContentEditable && { isContentEditable: true }),
            recordingTargetId,
            ...timing,
            ...(event.frameIndex && { frame: event.frameIndex })
          })
        } else if (value || hasContentEditableValue || hasCheckableValue) {
          steps.push({
            type: 'change',
            target: 'main',
            ...sourceTab,
            selectors: selectors || [],
            ...(frameSelectors && { frameSelectors }),
            value,
            tagName,
            inputType,
            ...(isContentEditable && { isContentEditable: true }),
            recordingTargetId,
            ...timing,
            ...(event.frameIndex && { frame: event.frameIndex })
          })
        }
        break
      case 'keydown':
        if (isSpecialKey(key)) {
          steps.push({ type: 'keyDown', target: 'main', ...sourceTab, key, ...timing })
        } else if (keyCode === 9 && (value || hasContentEditableValue)) {
          steps.push({
            type: 'change',
            target: 'main',
            ...sourceTab,
            selectors: selectors || [],
            ...(frameSelectors && { frameSelectors }),
            value,
            tagName,
            inputType,
            ...(isContentEditable && { isContentEditable: true }),
            recordingTargetId,
            ...timing,
            ...(event.frameIndex && { frame: event.frameIndex })
          })
        }
        break
      case 'keyup':
        if (isSpecialKey(key)) {
          steps.push({ type: 'keyUp', target: 'main', ...sourceTab, key, ...timing })
        } else if (value || hasContentEditableValue) {
          steps.push({
            type: 'change',
            target: 'main',
            ...sourceTab,
            selectors: selectors || [],
            ...(frameSelectors && { frameSelectors }),
            value,
            tagName,
            inputType,
            ...(isContentEditable && { isContentEditable: true }),
            recordingTargetId,
            ...timing,
            ...(event.frameIndex && { frame: event.frameIndex })
          })
        }
        break
      case 'input':
        if (((tagName === 'INPUT' || tagName === 'TEXTAREA') && value) || hasContentEditableValue) {
          steps.push({
            type: 'change',
            target: 'main',
            ...sourceTab,
            selectors: selectors || [],
            ...(frameSelectors && { frameSelectors }),
            value,
            tagName,
            inputType,
            ...(isContentEditable && { isContentEditable: true }),
            recordingTargetId,
            ...timing,
            ...(event.frameIndex && { frame: event.frameIndex })
          })
        }
        break
      case 'assert':
        steps.push({
          type: 'assert',
          target: 'main',
          ...sourceTab,
          selectors: selectors || [],
          assertionType: event.assertionType || 'visible',
          textContent: event.textContent || null,
          tagName,
          ...timing
        })
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

  // Calculate replay timing only after duplicate/keyboard filtering. This
  // keeps discarded raw events from shortening the gaps between real actions.
  const filteredSteps = applyStepDurations(filterSteps(steps))

  return {
    title: `Recording - ${new Date().toISOString()}`,
    timingVersion: 2,
    steps: filteredSteps
  }
}

const TIMED_STEP_TYPES = new Set([
  'navigate',
  'reload',
  'click',
  'doubleClick',
  'change',
  'keyDown',
  'keyUp',
  'assert',
  'close'
])

function applyStepDurations(steps) {
  let previousEventTime = null
  let startsNewTimingSegment = true

  return steps.map(step => {
    const {
      recordingTargetId,
      __tabId: tabId,
      __eventTime: eventTime,
      __endEventTime: endEventTime,
      __closeEventTime: closeEventTime,
      __closeDelay: legacyCloseDelay,
      __explicitClose: explicitClose,
      __timingBoundaryIncomplete: timingBoundaryIncomplete,
      __timingBoundaryAfter: timingBoundaryAfter,
      ...publicStep
    } = step

    if (explicitClose === true) publicStep.explicitClose = true
    if (tabId !== undefined) publicStep.tabId = tabId
    if (Array.isArray(publicStep.assertedEvents)) {
      publicStep.assertedEvents = publicStep.assertedEvents.map(assertedEvent => {
        const targetTabId = navigationTargetTabId(assertedEvent)
        if (assertedEvent.isNewTabOrWindow !== true || targetTabId === undefined) {
          return assertedEvent
        }
        return { ...assertedEvent, targetTabId }
      })
    }

    let stepCompletionTime = null
    if (TIMED_STEP_TYPES.has(step.type)) {
      if (Number.isFinite(eventTime)) {
        const monotonicEventTime = Number.isFinite(previousEventTime)
          ? Math.max(previousEventTime, eventTime)
          : eventTime
        publicStep.duration = startsNewTimingSegment || !Number.isFinite(previousEventTime)
          ? 0
          : Math.round(monotonicEventTime - previousEventTime)
        stepCompletionTime = Number.isFinite(endEventTime)
          ? Math.max(monotonicEventTime, endEventTime)
          : monotonicEventTime
        previousEventTime = stepCompletionTime
        startsNewTimingSegment = false
      } else {
        // A missing/malformed timestamp must not let an unrelated older event
        // become the baseline for a later action.
        publicStep.duration = 0
        previousEventTime = null
        startsNewTimingSegment = true
      }
    }

    if (Number.isFinite(closeEventTime)) {
      // A close is a separate user action. Calculate its dwell only after
      // keyboard folding so navigation completion wins over an earlier keyup.
      // If lifecycle completion is unavailable, omit the dwell rather than
      // replaying load time as a giant explicit delay.
      if (!timingBoundaryIncomplete && Number.isFinite(stepCompletionTime)) {
        const closeDelay = Math.max(0, Math.round(closeEventTime - stepCompletionTime))
        if (closeDelay > 0) publicStep.closeDelay = closeDelay
      }
      previousEventTime = Number.isFinite(previousEventTime)
        ? Math.max(previousEventTime, closeEventTime)
        : closeEventTime
      startsNewTimingSegment = false
    } else if (Number.isFinite(legacyCloseDelay) && legacyCloseDelay > 0) {
      publicStep.closeDelay = Math.round(legacyCloseDelay)
    }

    if (timingBoundaryAfter && !Number.isFinite(closeEventTime)) {
      if (timingBoundaryIncomplete) {
        previousEventTime = null
        startsNewTimingSegment = true
      } else if (Number.isFinite(endEventTime)) {
        previousEventTime = Number.isFinite(previousEventTime)
          ? Math.max(previousEventTime, endEventTime)
          : endEventTime
        startsNewTimingSegment = false
      } else {
        previousEventTime = null
        startsNewTimingSegment = true
      }
    }

    return publicStep
  })
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

/**
 * Strip session cookies from storageState, keeping only device-identity cookies
 * that allow Salesforce to skip the identity verification screen on login.
 *
 * Keeps: sfdc_lv2 (device verified), BrowserId, CookieConsentPolicy, LSKey-c$CookieConsentPolicy
 * Strips: sid, oid, JSESSIONID, inst, login, and all other session-specific cookies
 *
 * Also clears localStorage and sessionStorage origins (which contain session data).
 */
function stripSessionCookies(storageState) {
  // Cookies to KEEP — these identify the device, not the session
  const DEVICE_COOKIE_NAMES = new Set([
    'sfdc_lv2',           // Device verified — the key one for MFA bypass
    'BrowserId',          // Browser identifier
    'BrowserId_sec',      // Secure browser identifier
    'CookieConsentPolicy', // Cookie consent
    'LSKey-c$CookieConsentPolicy', // Lightning cookie consent
  ])

  const filteredCookies = (storageState.cookies || []).filter(
    (cookie) => DEVICE_COOKIE_NAMES.has(cookie.name)
  )

  return {
    cookies: filteredCookies,
    origins: [] // Clear localStorage/sessionStorage — only cookies matter for device identity
  }
}

/**
 * Resolve the auth state file path based on the URL hostname and the username
 * found in the recording events. Auth states are stored as:
 *   <saveAuth>/<hostname>---<username>.json
 *
 * If no username can be extracted from the recording, falls back to:
 *   <saveAuth>/<hostname>---default.json
 */
function resolveAuthStatePath(saveAuth, recording, url) {
  const authDir = path.resolve(saveAuth)

  let hostname = 'unknown'
  try {
    hostname = new URL(url).hostname
  } catch {}

  // Find the username from recorded events — look for a fill/change on an email/username input
  let username = 'default'
  for (const event of recording) {
    if ((event.action === 'change' || event.action === 'input') &&
        event.tagName === 'INPUT' &&
        (event.inputType === 'email' || event.inputType === 'text') &&
        event.value) {
      // Check if the selector hints at a username/email field
      const selectorStr = JSON.stringify(event.selectors || []).toLowerCase()
      if (selectorStr.includes('email') || selectorStr.includes('username') || selectorStr.includes('login') ||
          event.inputType === 'email') {
        username = event.value
        break
      }
    }
  }

  const sanitizedUsername = username.replace(/[/\\:*?"<>|]/g, '_')
  return path.join(authDir, `${hostname}---${sanitizedUsername}.json`)
}

function filterSteps(steps) {
  const filteredSteps = []
  let lastChangeIndex = -1

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]

    if (step.type === 'change') {
      const previousChange = filteredSteps[lastChangeIndex]
      const sameSelector = JSON.stringify(previousChange?.selectors) === JSON.stringify(step.selectors)
      const sameFieldShape = lastChangeIndex !== -1 &&
        previousChange?.type === step.type &&
        previousChange?.target === step.target &&
        previousChange?.__tabId === step.__tabId &&
        previousChange?.tagName === step.tagName &&
        previousChange?.inputType === step.inputType &&
        previousChange?.isContentEditable === step.isContentEditable &&
        JSON.stringify(previousChange?.frameSelectors) === JSON.stringify(step.frameSelectors) &&
        previousChange?.frame === step.frame
      const sameRecordedElement = previousChange?.recordingTargetId != null &&
        previousChange.recordingTargetId === step.recordingTargetId
      const isAdjacentChange = lastChangeIndex === filteredSteps.length - 1
      const previousSelectorAlternatives = new Set(
        (previousChange?.selectors || [])
          .filter(selector => selector?.some(Boolean))
          .map(selector => JSON.stringify(selector))
      )
      const hasStableSelectorAlternative = (step.selectors || [])
        .filter(selector => selector?.some(Boolean))
        .some(selector => previousSelectorAlternatives.has(JSON.stringify(selector)))
      const isTransientSelectorDuplicate = sameFieldShape && !sameSelector &&
        previousChange?.value === step.value &&
        sameRecordedElement &&
        isAdjacentChange &&
        hasStableSelectorAlternative
      const crossesLifecycleBoundary = previousChange?.__timingBoundaryAfter ||
        previousChange?.assertedEvents?.length > 0
      const shouldCollapseTransientSelector = isTransientSelectorDuplicate && !crossesLifecycleBoundary
      const isDuplicate = !crossesLifecycleBoundary &&
        ((sameFieldShape && sameSelector && isAdjacentChange) || shouldCollapseTransientSelector)
      if (isDuplicate) {
        // Remove the previous change and any intermediate keyboard events after it
        filteredSteps.splice(lastChangeIndex)
        lastChangeIndex = filteredSteps.length
      } else {
        lastChangeIndex = filteredSteps.length
      }

      let retainedStep = step
      if (isDuplicate && previousChange?.value === step.value &&
          Number.isFinite(previousChange.__eventTime) && Number.isFinite(step.__eventTime)) {
        // Reactive inputs can emit a delayed duplicate after the final value
        // already existed. Preserve that first occurrence so the user's wait
        // for results is measured from the fill, not the trailing duplicate.
        retainedStep = {
          ...retainedStep,
          __eventTime: Math.min(previousChange.__eventTime, step.__eventTime)
        }
      }

      // When a component changes its DOM while typing, the earlier selector is
      // the one that exists before replay fills the field.
      if (shouldCollapseTransientSelector) {
        retainedStep = { ...retainedStep, selectors: previousChange.selectors }
      }
      filteredSteps.push(retainedStep)
      continue
    }

    // Skip standalone keyUp events (e.g., Backspace between change events)
    if (step.type === 'keyUp') {
      filteredSteps.push(step)
      continue
    }

    if (step.type === 'keyDown' && i < steps.length - 1) {
      const nextStep = steps[i + 1]
      if (nextStep.type === 'keyUp' && step.key === nextStep.key &&
          step.__tabId === nextStep.__tabId) {
        const keyPressDuration = Number.isFinite(step.__eventTime) && Number.isFinite(nextStep.__eventTime)
          ? Math.max(0, Math.round(nextStep.__eventTime - step.__eventTime))
          : 0
        const foldedEndEventTimes = [
          step.__endEventTime,
          nextStep.__endEventTime,
          nextStep.__eventTime
        ].filter(Number.isFinite)
        const foldedEndEventTime = foldedEndEventTimes.length > 0
          ? Math.max(...foldedEndEventTimes)
          : undefined
        const foldedAssertedEvents = [
          ...(step.assertedEvents || []),
          ...(nextStep.assertedEvents || [])
        ]
        const stepNavigationEvents = (step.assertedEvents || []).filter(assertedEvent =>
          assertedEvent.type === 'navigation'
        )
        const nextNavigationEvents = (nextStep.assertedEvents || []).filter(assertedEvent =>
          assertedEvent.type === 'navigation'
        )
        const foldedNavigationEvents = foldedAssertedEvents.filter(assertedEvent =>
          assertedEvent.type === 'navigation'
        )
        const latestFoldedNavigation = foldedNavigationEvents.at(-1)
        const collapsedFoldedNavigation = latestFoldedNavigation
          ? setNavigationTargetTabId({
              ...latestFoldedNavigation,
              ...(foldedNavigationEvents.some(assertedEvent =>
                assertedEvent.isNewTabOrWindow === true
              ) && { isNewTabOrWindow: true })
            }, navigationTargetTabId(latestFoldedNavigation))
          : null
        const collapsedFoldedAssertedEvents = [
          ...(collapsedFoldedNavigation ? [collapsedFoldedNavigation] : []),
          ...foldedAssertedEvents.filter(assertedEvent => assertedEvent.type !== 'navigation')
        ]
        const foldedCloseEventTimes = [
          step.__closeEventTime,
          nextStep.__closeEventTime
        ].filter(Number.isFinite)
        const foldedCloseEventTime = foldedCloseEventTimes.length > 0
          ? Math.max(...foldedCloseEventTimes)
          : undefined
        const latestNavigationStep = nextNavigationEvents.length > 0
          ? nextStep
          : (stepNavigationEvents.length > 0 ? step : null)
        const foldedTimingBoundaryIncomplete = latestNavigationStep
          ? latestNavigationStep.__timingBoundaryIncomplete === true
          : (step.__timingBoundaryIncomplete === true || nextStep.__timingBoundaryIncomplete === true)
        filteredSteps.push({
          ...step,
          ...(keyPressDuration > 0 && { keyPressDuration }),
          ...(Number.isFinite(foldedEndEventTime) && { __endEventTime: foldedEndEventTime }),
          ...(Number.isFinite(foldedCloseEventTime) && { __closeEventTime: foldedCloseEventTime }),
          ...((step.__explicitClose || nextStep.__explicitClose) && { __explicitClose: true }),
          __timingBoundaryIncomplete: foldedTimingBoundaryIncomplete,
          ...(collapsedFoldedAssertedEvents.length > 0 && {
            assertedEvents: collapsedFoldedAssertedEvents
          }),
          ...((step.__timingBoundaryAfter || nextStep.__timingBoundaryAfter) && {
            __timingBoundaryAfter: true
          })
        })
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
