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

  it('resolves a retargeted component event from its first visible composed-path element', () => {
    const wrapper = el('x-product-tag', { id: 'retargeted-wrapper' })
    const shadow = wrapper.attachShadow({ mode: 'open' })
    const option = el('div', { role: 'option', 'data-testid': 'product-tag-option' })
    shadow.appendChild(option)
    wrapper.getBoundingClientRect = () => ({ width: 100, height: 40 })
    option.getBoundingClientRect = () => ({ width: 80, height: 20 })
    append(wrapper)
    finder.mockImplementation((element) => element === option ? '[data-testid="product-tag-option"]' : '#retargeted-wrapper')

    let selectors
    document.addEventListener('click', (event) => {
      expect(event.target).toBe(wrapper)
      expect(event.composedPath()[0]).toBe(option)
      selectors = getSelector(event, {})
    }, { capture: true, once: true })

    option.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }))

    expect(finder).toHaveBeenCalledWith(option, expect.anything())
    expect(selectors[0]).toEqual(['[data-testid="product-tag-option"]'])
  })

  it('keeps a configured host data attribute in shadow finder options and its slot retry', () => {
    const host = el('x-product-tag', { 'data-qa': 'product-tag' })
    const shadow = host.attachShadow({ mode: 'open' })
    const option = el('span')
    option.getBoundingClientRect = () => ({ width: 80, height: 20 })
    shadow.appendChild(option)
    append(host)
    finder
      .mockImplementationOnce((_element, options) => {
        expect(options.attr('data-qa', 'product-tag')).toBe(true)
        return ''
      })
      .mockImplementationOnce((_element, options) => {
        expect(options.attr('data-qa', 'product-tag')).toBe(true)
        expect(options.slotCheck).toBe(true)
        return 'x-product-tag[data-qa="product-tag"] span'
      })

    let selectors
    document.addEventListener('click', (event) => {
      selectors = getSelector(event, { dataAttribute: 'data-qa' })
    }, { capture: true, once: true })

    option.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }))

    expect(finder).toHaveBeenCalledTimes(2)
    expect(selectors[0]).toEqual(['x-product-tag[data-qa="product-tag"] span'])
  })

  it('borrows unique text from an option ancestor path when the clicked child has none', () => {
    const list = el('ul', { role: 'listbox' })
    const item = el('li')
    const option = el('a', { role: 'option' })
    const body = el('span', { class: 'slds-media__body' })
    const label = withText(el('span', { class: 'slds-listbox__option-text' }), 'Scale Testing Eng')
    const metadata = withText(el('span', { class: 'slds-listbox__option-meta' }), 'Scale')
    body.append(label, metadata)
    option.appendChild(body)
    item.appendChild(option)
    list.appendChild(item)
    append(list)
    finder.mockReturnValue('ul[role="listbox"] li:nth-child(3) span.slds-listbox__option-meta')
    SelectorComputer.mockImplementation(() => ({
      getSelectors: jest.fn((node) => node === body ? [['text/Scale Testing EngScale']] : [])
    }))

    const selectors = getSelector({ target: metadata }, {}, metadata)

    expect(selectors).toEqual([
      ['ul[role="listbox"] li:nth-child(3) span.slds-listbox__option-meta'],
      ['text/Scale Testing EngScale']
    ])
  })

  it('does not borrow option text for a nested interactive control', () => {
    const list = el('ul', { role: 'listbox' })
    const option = el('a', { role: 'option' })
    const body = el('span', { class: 'slds-media__body' })
    const nestedButton = el('button')
    const icon = el('span', { class: 'delete-icon' })
    nestedButton.appendChild(icon)
    body.appendChild(nestedButton)
    option.appendChild(body)
    list.appendChild(option)
    append(list)
    finder.mockReturnValue('#delete-icon')
    SelectorComputer.mockImplementation(() => ({
      getSelectors: jest.fn((node) => node === body ? [['text/Whole option text']] : [])
    }))

    const selectors = getSelector({ target: icon }, {}, icon)

    expect(selectors).toEqual([['#delete-icon']])
  })

  it.each([
    ['an empty contenteditable attribute', { contenteditable: '' }],
    ['a combobox role', { role: 'combobox' }],
    ['a treeitem role', { role: 'treeitem' }],
    ['a keyboard-focusable custom control', { tabindex: '0' }]
  ])('does not borrow option text through %s', (_description, interactiveAttributes) => {
    const option = el('a', { role: 'option' })
    const body = el('span', { class: 'slds-media__body' })
    const nestedControl = el('div', interactiveAttributes)
    const child = el('span', { class: 'control-child' })
    nestedControl.appendChild(child)
    body.appendChild(nestedControl)
    option.appendChild(body)
    append(option)
    finder.mockReturnValue('#control-child')
    SelectorComputer.mockImplementation(() => ({
      getSelectors: jest.fn((node) => node === body ? [['text/Whole option text']] : [])
    }))

    const selectors = getSelector({ target: child }, {}, child)

    expect(selectors).toEqual([['#control-child']])
  })

  it('borrows unique descendant text when the option surface itself is clicked', () => {
    const list = el('ul', { role: 'listbox' })
    const option = el('a', { role: 'option' })
    const body = withText(el('span', { class: 'slds-media__body' }), 'Scale Testing EngScale')
    option.appendChild(body)
    list.appendChild(option)
    append(list)
    finder.mockReturnValue('ul[role="listbox"] li:nth-child(3) a[role="option"]')
    SelectorComputer.mockImplementation(() => ({
      getSelectors: jest.fn((node) => node === body ? [['text/Scale Testing EngScale']] : [])
    }))

    const selectors = getSelector({ target: option }, {}, option)

    expect(selectors).toEqual([
      ['ul[role="listbox"] li:nth-child(3) a[role="option"]'],
      ['text/Scale Testing EngScale']
    ])
  })

  it('bounds document-wide text uniqueness checks for a direct option click', () => {
    const option = el('a', { role: 'option' })
    for (let index = 0; index < 30; index++) {
      option.appendChild(withText(el('span'), `Duplicate candidate ${index}`))
    }
    append(option)
    finder.mockReturnValue('a[role="option"]:nth-child(1)')
    const getSelectors = jest.fn().mockReturnValue([])
    SelectorComputer.mockImplementation(() => ({ getSelectors }))

    getSelector({ target: option }, {}, option)

    // One check for the clicked option plus one ranked descendant.
    expect(getSelectors.mock.calls.length).toBeLessThanOrEqual(2)
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

    it('excludes the changing text selector for a contenteditable editor', () => {
      stubTextSelector('Description text changes while typing')
      const target = el('div', { contenteditable: 'true' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors).toEqual([['#target']])
    })

    it('keeps a text selector when the contenteditable keyword is invalid', () => {
      stubTextSelector('Ordinary visible text')
      const target = el('div', { contenteditable: ' true ' })
      append(target)

      const selectors = getSelector({ target }, {})

      expect(selectors).toContainEqual(['text/Ordinary visible text'])
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

  it('prefers the first visible element in composedPath over a retargeted event.target', () => {
    const host = el('x-product-tag')
    const shadow = host.attachShadow({ mode: 'open' })
    host.getBoundingClientRect = () => ({ width: 100, height: 40 })
    const innerOption = el('div', { role: 'option' })
    innerOption.getBoundingClientRect = () => ({ width: 80, height: 20 })
    shadow.appendChild(innerOption)
    append(host)

    let resolvedTarget
    document.addEventListener('click', (event) => {
      resolvedTarget = getClickableTargetFromEvent(event)
    }, { capture: true, once: true })

    innerOption.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }))

    expect(resolvedTarget).toBe(innerOption)
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
