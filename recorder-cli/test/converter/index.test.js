import { convertToPlaywright } from '../../src/converter/index.js'

describe('convertToPlaywright', () => {
  it('formats a full script with prettier and preserves the recorded steps', async () => {
    const data = {
      title: 'My Test',
      timeout: 5000,
      steps: [{ type: 'navigate', url: 'https://example.com' }]
    }

    const output = await convertToPlaywright(data)

    expect(output).toContain("test('My Test'")
    expect(output).toContain('page.setDefaultTimeout(5000)')
    expect(output).toContain("await page.goto('https://example.com')")
    expect(output).toContain('test.afterEach(async ({ page, context })')
    expect(output).toContain("SALESFORCE_UI_SCRIPT_RECORDER_DISABLE_AUTH_PERSIST === '1'")
    expect(output).toContain("import { test, expect } from '@playwright/test'")
  })

  it('falls back to the default timeout duration when the flow has none', async () => {
    const data = { title: 'No timeout', steps: [] }

    const output = await convertToPlaywright(data)

    expect(output).toContain('page.setDefaultTimeout(120000)')
  })

  it('strips verification steps before building the script', async () => {
    const exitEvent = { type: 'navigation', url: 'https://x.com/lightning/page' }
    const data = {
      title: 'Login',
      steps: [
        {
          type: 'click',
          selectors: [['#login-btn']],
          assertedEvents: [{ type: 'navigation', url: 'https://x.com/_ui/identity/verification' }]
        },
        { type: 'click', assertedEvents: [exitEvent] }
      ]
    }

    const output = await convertToPlaywright(data)

    expect(output).toContain("page.waitForNavigation({ waitUntil: 'domcontentloaded' })")
    expect(output).not.toContain('identity/verification')
  })

  it('emits parseable replay code for multiline rich-text values', async () => {
    const data = {
      title: 'Rich text',
      steps: [{
        type: 'change',
        selectors: [['#editor']],
        tagName: 'DIV',
        isContentEditable: true,
        value: "Bob's description\nsecond line"
      }]
    }

    const output = await convertToPlaywright(data)
    const scriptWithoutStaticImports = output.replace(/^\s*import\s.+;$/gm, '')

    expect(output).toContain("await page.fill('#editor'")
    expect(() => new Function(scriptWithoutStaticImports)).not.toThrow()
  })

  it('emits a parseable test title when document text contains JavaScript syntax', async () => {
    const data = {
      title: "'); globalThis.__titleInjected = true; //\nsecond line",
      steps: []
    }

    const output = await convertToPlaywright(data)
    const scriptWithoutStaticImports = output.replace(/^\s*import\s.+;$/gm, '')

    expect(() => new Function(scriptWithoutStaticImports)).not.toThrow()
    expect(output).toContain("\\'")
  })

  it('replays a styled radio through its visible control and deterministic state change', async () => {
    const data = {
      title: 'Styled radio',
      steps: [
        {
          type: 'click',
          selectors: [['#radio-faux']],
          tagName: 'SPAN'
        },
        {
          type: 'change',
          selectors: [['#radio-input']],
          tagName: 'INPUT',
          inputType: 'radio',
          value: true
        }
      ]
    }

    const output = await convertToPlaywright(data)

    expect(output).toContain("await page.click('#radio-faux')")
    expect(output).toContain("page.locator('#radio-input').setChecked(true == true)")
    expect(output).not.toContain("page.click('#radio-input')")
  })

  it('replays an unchecked checkbox state', async () => {
    const data = {
      title: 'Unchecked checkbox',
      steps: [{
        type: 'change',
        selectors: [['#notifications']],
        tagName: 'INPUT',
        inputType: 'checkbox',
        value: false
      }]
    }

    const output = await convertToPlaywright(data)

    expect(output).toContain("page.locator('#notifications').setChecked(false == true)")
  })

  it('reopens a searchable combobox only when needed before filling its stable selector', async () => {
    const data = {
      title: 'Lookup search',
      steps: [{
        type: 'change',
        selectors: [['input[aria-label="Team"]'], ['aria/Team[role="combobox"]']],
        tagName: 'INPUT',
        inputType: 'text',
        ensureComboboxOpen: true,
        comboboxActivationSelector: '#team-closed',
        value: 'Scale Testing'
      }]
    }

    const output = await convertToPlaywright(data)
    const scriptWithoutStaticImports = output.replace(/^\s*import\s.+;$/gm, '')

    expect(output).toContain("page.locator('#team-closed').first().isVisible()")
    expect(output).toContain("getAttribute('aria-expanded')) === 'false'")
    expect(output).toContain("await page.fill('input[aria-label=\"Team\"]', 'Scale Testing')")
    expect(output).not.toContain('slds-is-open')
    expect(() => new Function(scriptWithoutStaticImports)).not.toThrow()
  })
})
