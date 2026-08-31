/**
 * @jest-environment jsdom
 */
jest.mock('../../src/injected/finder.js', () => ({
  finder: jest.fn(),
  finderOptions: { seedMinLength: 5, optimizedMinLength: 3, slotCheck: false }
}))
jest.mock('../../src/injected/vendor/SelectorComputer.js', () => ({
  SelectorComputer: jest.fn().mockImplementation(() => ({ getSelectors: jest.fn().mockReturnValue([]) }))
}))

import { finder } from '../../src/injected/finder.js'
import { SelectorComputer } from '../../src/injected/vendor/SelectorComputer.js'
import { OVERLAY_ID } from '../../src/injected/constants.js'
import {
  getSelector, getClickableTargetFromEvent, getMouseEventOffsets, dataAttributes, otherAttributes
} from '../../src/injected/selector.js'

function el(tag, attrs = {}, ns) {
  const node = ns ? document.createElementNS(ns, tag) : document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, value)
  }
  return node
}

function append(...nodes) {
  for (const node of nodes) document.body.appendChild(node)
}

function withText(node, str) {
  node.appendChild(document.createTextNode(str))
  return node
}

function stubTextSelector(value) {
  SelectorComputer.mockImplementation(() => ({ getSelectors: jest.fn().mockReturnValue(value ? [[`text/${value}`]] : []) }))
}

afterEach(() => {
  document.body.replaceChildren()
  jest.clearAllMocks()
  finder.mockReset()
  stubTextSelector(null)
})

describe('getSelector', () => {
  it('returns null when there is no target element at all', () => {
    expect(getSelector({}, {}, undefined)).toBeNull()
    expect(getSelector(undefined, {}, undefined)).toBeNull()
  })

  it('returns null when the resolved target is not an Element', () => {
    const textNode = document.createTextNode('hi')

    expect(getSelector({ target: textNode }, {})).toBeNull()
  })

  it('resolves the element from targetElement when provided, ignoring e.target', () => {
    finder.mockReturnValue('#from-target')
    const wrong = el('div', { id: 'wrong' })
    const right = el('div', { id: 'right' })
    append(wrong, right)

    const selectors = getSelector({ target: wrong }, {}, right)

    expect(finder).toHaveBeenCalledWith(right, expect.anything())
    expect(selectors[0]).toEqual(['#from-target'])
  })

  it('uses a data-attribute shortcut selector when configured and present, skipping finder entirely', () => {
    const target = el('div', { 'data-recordid': 'rec-1' })
    append(target)

    const selectors = getSelector({ target }, { dataAttribute: 'data-recordid' })

    expect(finder).not.toHaveBeenCalled()
    expect(selectors[0]).toEqual(['[data-recordid="rec-1"]'])
  })

  it('falls through to finder when the configured data-attribute is absent', () => {
    finder.mockReturnValue('#via-finder')
    const target = el('div', { id: 'no-data-attr' })
    append(target)

    const selectors = getSelector({ target }, { dataAttribute: 'data-recordid' })

    expect(finder).toHaveBeenCalled()
    expect(selectors[0]).toEqual(['#via-finder'])
  })

  it('retries with getClickableTargetFromEvent + slotCheck when finder returns empty', () => {
    finder.mockReturnValueOnce('').mockReturnValueOnce('#retried')
    const inner = el('span')
    inner.getBoundingClientRect = () => ({ width: 10, height: 10 })
    const outer = el('div', {}, undefined)
    outer.appendChild(inner)
    append(outer)

    const selectors = getSelector({ target: inner }, {})

    expect(finder).toHaveBeenCalledTimes(2)
    expect(finder.mock.calls[1][1]).toMatchObject({ slotCheck: true })
    expect(selectors[0]).toEqual(['#retried'])
  })

  it('retries with getClickableTargetFromEvent + slotCheck when finder returns a slot-containing selector', () => {
    finder.mockReturnValueOnce('slot[name="x"]').mockReturnValueOnce('#after-slot')
    const target = el('div')
    target.getBoundingClientRect = () => ({ width: 5, height: 5 })
    append(target)

    const selectors = getSelector({ target }, {})

    expect(finder).toHaveBeenCalledTimes(2)
    expect(selectors[0]).toEqual(['#after-slot'])
  })

  it('returns null when the resolved css selector targets the overlay itself', () => {
    finder.mockReturnValue(`#${OVERLAY_ID}`)
    const target = el('div', { id: OVERLAY_ID })
    append(target)

    expect(getSelector({ target }, {})).toBeNull()
  })

  it('drops the css contribution when finder yields nothing on both attempts, but keeps other selectors', () => {
    finder.mockReturnValue('')
    stubTextSelector('Some unique long enough text')
    const target = el('div')
    withText(target, 'Some unique long enough text')
    append(target)

    const selectors = getSelector({ target }, {})

    expect(selectors.some((s) => s[0].startsWith('text/'))).toBe(true)
    expect(selectors.some((s) => s[0].startsWith('#') || s[0].startsWith('['))).toBe(false)
  })

  describe('fallback selector construction when finder throws', () => {
    beforeEach(() => {
      finder.mockImplementation(() => { throw new Error('finder exploded') })
    })

    it('uses the element id directly, bypassing attribute/class checks', () => {
      const target = el('div', { id: 'fallback-id', 'data-testid': 'ignored', class: 'ignored-too' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['#fallback-id'])
    })

    it('skips a numeric-only data attribute and matches the next valid one in the Set', () => {
      const target = el('div', { 'data-recordid': '12345', 'data-testid': 'widget-1' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['div[data-testid="widget-1"]'])
    })

    it('skips a data attribute containing unwanted characters', () => {
      const target = el('div', { 'data-recordid': 'a:b', 'data-testid': 'widget-2' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['div[data-testid="widget-2"]'])
    })

    it('falls back to an otherAttributes match when no dataAttributes match', () => {
      const target = el('div', { name: 'bad:name', 'aria-label': 'Good Label' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['div[aria-label="Good Label"]'])
    })

    it('falls back to a class-based selector, filtering disallowed SLDS classes and keeping at most two', () => {
      const target = el('button', { class: 'slds-is-active real-one real-two real-three' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['button.real-one.real-two'])
    })

    it('falls back to a bare tag name when className is empty after filtering', () => {
      const target = el('button', { class: 'slds-is-active slds-has-focus' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['button'])
    })

    it('falls back to a bare tag name when there is no id, matching attribute, or class at all', () => {
      const target = el('span')
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['span'])
    })

    it('falls back to a bare tag name for SVG elements whose className is not a plain string', () => {
      const target = el('svg', { class: 'some-class' }, 'http://www.w3.org/2000/svg')
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['svg'])
    })
  })

  describe('aria selector composition', () => {
    beforeEach(() => {
      finder.mockReturnValue('')
    })

    it('prioritizes aria-label over everything else', () => {
      const target = el('div', { 'aria-label': ' Padded Label ', title: 'Ignored title' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Padded Label'])
    })

    it('uses aria-labelledby text content when aria-label is absent', () => {
      const label = el('span', { id: 'lbl-1' })
      withText(label, ' Labelled By Text ')
      const target = el('div', { 'aria-labelledby': 'lbl-1' })
      append(label, target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Labelled By Text'])
    })

    it('falls through when aria-labelledby points at a non-existent id', () => {
      const target = el('div', { 'aria-labelledby': 'does-not-exist', title: 'Title Fallback' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Title Fallback'])
    })

    it('uses an associated label[for] element for form fields', () => {
      const label = el('label', { for: 'field-1' })
      withText(label, 'Field Label')
      const target = el('input', { id: 'field-1' })
      append(label, target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Field Label[role="textbox"]'])
    })

    it('falls through when the input has an id but no matching label element', () => {
      const target = el('input', { id: 'lonely-field', title: 'Lonely Field Title' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Lonely Field Title[role="textbox"]'])
    })

    it('uses the title attribute when nothing else matches', () => {
      const target = el('div', { title: ' Titled Element ' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Titled Element'])
    })

    it('uses text content for an implicit button role under 100 characters', () => {
      const target = el('button')
      withText(target, 'Click Me')
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Click Me[role="button"]'])
    })

    it('uses text content for an explicit role attribute', () => {
      const target = el('div', { role: 'tab' })
      withText(target, 'Tab One')
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Tab One[role="tab"]'])
    })

    it('ignores text content longer than 100 characters for role-based naming', () => {
      const target = el('button')
      withText(target, 'x'.repeat(101))
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors).toBeNull()
    })

    it('strips the literal word "required" out of the accessible name', () => {
      const target = el('div', { 'aria-label': 'Email required' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Email'])
    })

    it('produces no aria selector for an element with no name at all', () => {
      const target = el('div')
      append(target)

      expect(getSelector({ target }, {})).toBeNull()
    })

    it('maps an anchor without href to an empty implicit role', () => {
      const target = el('a', { title: 'Anchor Title' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Anchor Title'])
    })

    it('maps an anchor with href to the link role for text-content naming', () => {
      const target = el('a', { href: '#' })
      withText(target, 'Go somewhere')
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Go somewhere[role="link"]'])
    })

    it('maps input types to their implicit ARIA role via the explicit role attribute path', () => {
      const target = el('div', { role: 'menuitem' })
      withText(target, 'Menu Item One')
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors[0]).toEqual(['aria/Menu Item One[role="menuitem"]'])
    })
  })

  describe('text selector inclusion rules', () => {
    beforeEach(() => {
      finder.mockReturnValue('#target')
    })

    it('includes a text selector for a plain element', () => {
      stubTextSelector('Some visible text here')
      const target = el('div')
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors.some((s) => s[0] === 'text/Some visible text here')).toBe(true)
    })

    it('excludes the text selector for an INPUT element', () => {
      stubTextSelector('should not appear')
      const target = el('input')
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors.some((s) => s[0].startsWith('text/'))).toBe(false)
    })

    it('excludes the text selector for a TEXTAREA element', () => {
      stubTextSelector('should not appear')
      const target = el('textarea')
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors.some((s) => s[0].startsWith('text/'))).toBe(false)
    })

    it('excludes the text selector for a SELECT element', () => {
      stubTextSelector('should not appear')
      const target = el('select')
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors.some((s) => s[0].startsWith('text/'))).toBe(false)
    })

    it('excludes the text selector for a password-type input', () => {
      stubTextSelector('should not appear')
      const target = el('input', { type: 'password' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors.some((s) => s[0].startsWith('text/'))).toBe(false)
    })
  })
})

describe('getClickableTargetFromEvent', () => {
  it('returns event?.target when there is no event at all', () => {
    expect(getClickableTargetFromEvent(undefined)).toBeUndefined()
    expect(getClickableTargetFromEvent(null)).toBeUndefined()
  })

  it('returns the target itself when it already has visible dimensions', () => {
    const target = el('div')
    target.getBoundingClientRect = () => ({ width: 20, height: 20 })
    append(target)

    expect(getClickableTargetFromEvent({ target })).toBe(target)
  })

  it('walks up to the first ancestor with visible dimensions', () => {
    const grandparent = el('div')
    grandparent.getBoundingClientRect = () => ({ width: 50, height: 50 })
    const parent = el('div')
    parent.getBoundingClientRect = () => ({ width: 0, height: 0 })
    const target = el('span')
    target.getBoundingClientRect = () => ({ width: 0, height: 0 })
    parent.appendChild(target)
    grandparent.appendChild(parent)
    append(grandparent)

    expect(getClickableTargetFromEvent({ target })).toBe(grandparent)
  })

  it('returns the original target when no ancestor (including root) has visible dimensions', () => {
    const parent = el('div')
    parent.getBoundingClientRect = () => ({ width: 0, height: 0 })
    const target = el('span')
    target.getBoundingClientRect = () => ({ width: 0, height: 0 })
    parent.appendChild(target)
    append(parent)

    expect(getClickableTargetFromEvent({ target })).toBe(target)
  })

  it('returns event.target unchanged when it is not an Element instance', () => {
    const target = document.createTextNode('not an element')

    expect(getClickableTargetFromEvent({ target })).toBe(target)
  })
})

describe('getMouseEventOffsets', () => {
  it('returns zeroed offsets when there is no target', () => {
    expect(getMouseEventOffsets({ clientX: 10, clientY: 10 }, null)).toEqual({ offsetX: 0, offsetY: 0 })
  })

  it('computes offsets relative to the target bounding rect', () => {
    const target = el('div')
    target.getBoundingClientRect = () => ({ x: 5, y: 8 })
    append(target)

    expect(getMouseEventOffsets({ clientX: 25, clientY: 30 }, target)).toEqual({ offsetX: 20, offsetY: 22 })
  })
})

describe('exported attribute sets', () => {
  it('exposes the expected dataAttributes and otherAttributes members', () => {
    expect(dataAttributes.has('data-testid')).toBe(true)
    expect(otherAttributes.has('aria-label')).toBe(true)
  })
})

describe('getSelector edge cases', () => {
  it('uses the default {} options object when none is provided', () => {
    finder.mockReturnValue('#no-options-arg')
    const target = el('div')
    append(target)

    const selectors = getSelector({ target })

    expect(selectors[0]).toEqual(['#no-options-arg'])
  })

  it('returns an empty accessible name when an aria-labelledby target has no text content', () => {
    finder.mockReturnValue('')
    const label = el('span', { id: 'empty-lbl' })
    const target = el('div', { 'aria-labelledby': 'empty-lbl' })
    append(label, target)

    expect(getSelector({ target }, {})).toBeNull()
  })

  it('returns an empty accessible name when an associated label[for] has no text content', () => {
    finder.mockReturnValue('')
    const label = el('label', { for: 'empty-field' })
    const target = el('input', { id: 'empty-field' })
    append(label, target)

    expect(getSelector({ target }, {})).toBeNull()
  })

  it('produces no css or aria selector when the slot-retry resolves to no element at all', () => {
    finder.mockReturnValueOnce('').mockImplementationOnce(() => { throw new Error('boom') })
    const target = el('div')
    append(target)

    expect(getSelector(undefined, {}, target)).toBeNull()
  })
})

// selector.js's `accessibilityBindings.getAccessibleName`/`getAccessibleRole` and the
// module-private `getImplicitRole` each guard with `!(node instanceof Element)`, but
// that guard is structurally dead in this codebase: `getAriaSelector()` is their only
// caller, and it is only ever invoked from `getSelector()` with the same `element`
// that already passed an `instanceof Element` check earlier in that function. These
// bindings are also handed to `SelectorComputer`, whose ARIA path is the only other
// consumer that could call them with an arbitrary (non-Element) node during a tree
// walk - but `selectorTypesToRecord` here is `['text']` only (ARIA is intentionally
// commented out), so that path is filtered out of `SelectorComputer`'s selector
// functions and never runs. No call path ever reaches these guards with a non-Element.
