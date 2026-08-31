const { getStepLabel, getStepDescription, getParamStatusLabel } = require('../step-labels')

describe('getStepLabel', () => {
  it('falls back to the step type when there are no selectors', () => {
    expect(getStepLabel({ type: 'click' })).toBe('Step (click)')
  })

  it('falls back to the step type when selectors is an empty array', () => {
    expect(getStepLabel({ type: 'click', selectors: [] })).toBe('Step (click)')
  })

  it('prioritizes an aria selector, trimming the captured name', () => {
    expect(getStepLabel({ selectors: [['aria/  Submit Button  [role="button"]']] })).toBe('Submit Button')
  })

  it('falls through to the css selector logic when the aria capture group is empty', () => {
    expect(getStepLabel({ selectors: [['aria/']] })).toBe('aria/')
  })

  it('extracts a name attribute from the css selector', () => {
    expect(getStepLabel({ selectors: [['input[name="firstName"]']] })).toBe('firstName')
  })

  it('extracts an id from the css selector', () => {
    expect(getStepLabel({ selectors: [['#my-field_1']] })).toBe('my-field_1')
  })

  it('extracts a placeholder from the css selector', () => {
    expect(getStepLabel({ selectors: [['input[placeholder="Enter text"]']] })).toBe('Enter text')
  })

  it('truncates a long css selector with no name/id/placeholder match', () => {
    const long = 'div.some-really-long-class-name-that-goes-on'
    expect(getStepLabel({ selectors: [[long]] })).toBe(`${long.substring(0, 37)}...`)
  })

  it('returns a short css selector unchanged when nothing else matches', () => {
    expect(getStepLabel({ selectors: [['button.primary']] })).toBe('button.primary')
  })

  it('skips selector entries whose first element is falsy to find the first usable one', () => {
    expect(getStepLabel({ selectors: [[undefined], ['#real-target']] })).toBe('real-target')
  })
})

describe('getStepDescription', () => {
  it('describes a change step, including the input type and a truncated value', () => {
    const value = 'x'.repeat(35)
    const step = { type: 'change', inputType: 'text', value, selectors: [['#field']] }

    expect(getStepDescription(step)).toBe(`text field = "${value.substring(0, 27)}..."`)
  })

  it('describes a change step with no inputType and a short value', () => {
    const step = { type: 'change', value: 'hi', selectors: [['#field']] }

    expect(getStepDescription(step)).toBe('field = "hi"')
  })

  it('describes a change step with no value at all', () => {
    const step = { type: 'change', selectors: [['#field']] }

    expect(getStepDescription(step)).toBe('field = ""')
  })

  it('describes a click step', () => {
    expect(getStepDescription({ type: 'click', selectors: [['#btn']] })).toBe('click btn')
  })

  it('describes a text-content assertion', () => {
    expect(getStepDescription({ type: 'assert', assertionType: 'containsText', selectors: [['#el']] })).toBe('assert text: el')
  })

  it('describes a visibility assertion', () => {
    expect(getStepDescription({ type: 'assert', assertionType: 'visible', selectors: [['#el']] })).toBe('assert visible: el')
  })

  it('falls back to the bare label for any other step type', () => {
    expect(getStepDescription({ type: 'navigate', selectors: [['#el']] })).toBe('el')
  })
})

describe('getParamStatusLabel', () => {
  it('returns null when params is missing entirely', () => {
    expect(getParamStatusLabel({})).toBeNull()
  })

  it('returns null when parameterise is falsy', () => {
    expect(getParamStatusLabel({ params: { parameterise: false } })).toBeNull()
  })

  it('returns a config label when a paramName is set', () => {
    expect(getParamStatusLabel({ params: { parameterise: true, paramName: 'username' } })).toBe('Config: username')
  })

  it('returns a generic "Parameterized" label when there is no paramName', () => {
    expect(getParamStatusLabel({ params: { parameterise: true } })).toBe('Parameterized')
  })
})
