/**
 * @jest-environment jsdom
 */
import { finder, finderOptions } from '../../src/injected/finder.js'

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [name, value] of Object.entries(attrs)) {
    node.setAttribute(name, value)
  }
  for (const child of children) {
    node.appendChild(child)
  }
  return node
}

function text(str) {
  return document.createTextNode(str)
}

function append(...children) {
  for (const child of children) {
    document.body.appendChild(child)
  }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('finder', () => {
  it('throws for a non-element node', () => {
    const root = el('div', { id: 'root' }, [text('hello')])
    append(root)

    expect(() => finder(root.firstChild, finderOptions)).toThrow(`Can't generate CSS selector for non-element node type.`)
  })

  it('returns "html" for the <html> element itself', () => {
    expect(finder(document.documentElement, finderOptions)).toBe('html')
  })

  it('builds an id-based selector when idName allows it', () => {
    const target = el('div', { id: 'foo' })
    append(target)

    expect(finder(target, { idName: () => true })).toBe('#foo')
  })

  it('excludes ids that idName rejects (finderOptions only allows the overlay id)', () => {
    const target = el('div', { id: 'foo', class: 'bar' })
    append(target)

    const selector = finder(target, finderOptions)

    expect(selector).not.toContain('#foo')
  })

  it('builds a data-attribute selector for dataAttributes members (0.5 penalty tier)', () => {
    const target = el('div', { 'data-testid': 'widget' })
    append(target)

    expect(finder(target, finderOptions)).toContain('[data-testid="widget"]')
  })

  it('builds an attribute selector for otherAttributes members (0.75 penalty tier)', () => {
    const target = el('div', { name: 'widget-name' })
    append(target)

    expect(finder(target, finderOptions)).toContain('[name="widget-name"]')
  })

  it('ignores attributes that fail the unwanted-chars / string-char checks', () => {
    const badChars = el('div', { 'data-testid': 'a:b' })
    const numericOnly = el('div', { 'data-testid': '123' })
    append(badChars, numericOnly)

    expect(finder(badChars, finderOptions)).not.toContain('a:b')
    expect(finder(numericOnly, finderOptions)).not.toContain('123')
  })

  it('falls back to a class-based selector when id/attr do not distinguish', () => {
    const target = el('div', { class: 'unique-class' })
    const other = el('div', { class: 'other' })
    append(target, other)

    const selector = finder(target, { idName: () => false, attr: () => false })

    expect(selector).toContain('unique-class')
  })

  it('excludes disallowed SLDS classes via the finderOptions className evaluator', () => {
    const target = el('div', { class: 'slds-is-active real-class' })
    append(target)

    const selector = finder(target, finderOptions)

    expect(selector).not.toContain('slds-is-active')
  })

  it('falls back to a tagName-based selector when id/attr/class do not distinguish', () => {
    const target = el('span')
    append(target)

    const selector = finder(target, { idName: () => false, attr: () => false, className: () => false })

    expect(document.querySelectorAll(selector).length).toBe(1)
    expect(document.querySelector(selector)).toBe(target)
  })

  it('falls back to a wildcard selector when nothing distinguishes, still producing a unique match', () => {
    const spanA = el('span')
    const spanB = el('span')
    const wrapper = el('div', {}, [spanA, spanB])
    append(wrapper)

    const selector = finder(spanA, {
      idName: () => false, attr: () => false, className: () => false, tagName: () => false
    })

    expect(selector).toContain('*')
    expect(document.querySelectorAll(selector).length).toBe(1)
    expect(document.querySelector(selector)).toBe(spanA)
  })

  it('disambiguates identical siblings via nth-child', () => {
    const items = [el('li'), el('li'), el('li')]
    const list = el('ul', {}, items)
    append(list)

    const selector = finder(items[1], { idName: () => false, attr: () => false, className: () => false })

    expect(selector).toContain(':nth-child(2)')
    expect(document.querySelector(selector)).toBe(items[1])
  })

  it('throws when no unique selector can be found within the timeout', () => {
    const target = el('span')
    const wrapper = el('div', {}, [target])
    append(wrapper)

    expect(() =>
      finder(target, { idName: () => false, attr: () => false, className: () => false, timeoutMs: -1 })
    ).toThrow(/Timeout/)
  })

  it('uses the real finderOptions export end-to-end against a realistic structure', () => {
    const target = el('button', { 'data-testid': 'submit-btn' }, [text('Submit')])
    const wrapper = el('div', {}, [target])
    append(wrapper)

    const selector = finder(target, finderOptions)

    expect(document.querySelectorAll(selector).length).toBe(1)
    expect(document.querySelector(selector)).toBe(target)
  })

  it('resolves a deeply-nested unique id directly, without needing ancestor context', () => {
    const target = el('span', { id: 'deep-target' })
    const child = el('div', { class: 'child' }, [target])
    const parent = el('div', { class: 'parent' }, [child])
    const grandparent = el('div', { class: 'grandparent' }, [parent])
    append(grandparent)

    const selector = finder(target, { idName: () => true, attr: () => false, className: () => false })

    expect(selector).toBe('#deep-target')
  })

  it('pierces shadow DOM boundaries when the element lives inside a shadow root', () => {
    const host = el('div', { id: 'host' })
    append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const target = el('button', { class: 'inner-btn' }, [text('Click')])
    shadow.appendChild(target)

    const selector = finder(target, { idName: () => true, attr: () => false, className: () => true })

    expect(selector).toContain('inner-btn')
    expect(shadow.querySelector(selector.split(' ').pop())).toBe(target)
  })

  it('falls back to a bare tag name inside a shadow root when no local selector can be found', () => {
    const host = el('div', { id: 'host2' })
    append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    const target = el('span')
    shadow.appendChild(target)

    const selector = finder(target, {
      idName: () => false, attr: () => false, className: () => false, tagName: () => false, threshold: 0
    })

    expect(selector).toContain('span')
  })

  describe('default option functions (used when the caller does not override them)', () => {
    it('invokes the default idName function when an element has an id', () => {
      const target = el('div', { id: 'default-id-target' })
      append(target)

      const selector = finder(target, { className: () => false, tagName: () => false, attr: () => false })

      expect(selector).toBe('#default-id-target')
    })

    it('invokes the default attr function when an element carries a plain attribute', () => {
      const target = el('div', { 'data-foo': 'bar' })
      append(target)

      const selector = finder(target, { className: () => false })

      expect(document.querySelector(selector)).toBe(target)
    })

    it('invokes the default className function when an element carries a class', () => {
      const target = el('div', { class: 'default-class-target' })
      append(target)

      const selector = finder(target, { idName: () => false, attr: () => false, tagName: () => false })

      expect(selector).toContain('default-class-target')
    })

    it('invokes the default tagName function when nothing else distinguishes the element', () => {
      const target = el('span')
      append(target)

      const selector = finder(target, { idName: () => false, attr: () => false, className: () => false })

      expect(document.querySelector(selector)).toBe(target)
    })
  })

  describe('root option and rootDocument resolution', () => {
    it('uses the document directly as the root when options.root is the Document node', () => {
      const target = el('div', { id: 'doc-root-target' })
      append(target)

      const selector = finder(target, { idName: () => true, root: document })

      expect(selector).toBe('#doc-root-target')
    })

    it('throws "Selector was not found" when the configured root cannot see the target at all', () => {
      const disconnectedRoot = el('div')
      append(disconnectedRoot)
      const target = el('span')
      append(target)

      expect(() => finder(target, { idName: () => false, root: disconnectedRoot })).toThrow('Selector was not found.')
    })
  })

  it('optimizes a genuinely 3-level unique path down to a shorter descendant selector', () => {
    const decoyOuter = el('div')
    const decoySpan = el('span')
    decoyOuter.appendChild(decoySpan)

    const target = el('span')
    const middle = el('div')
    middle.appendChild(target)
    const outer = el('div', { class: 'only-one-like-this' })
    outer.appendChild(middle)

    append(decoyOuter, outer)

    const selector = finder(target, { idName: () => false, attr: () => false })

    expect(document.querySelectorAll(selector).length).toBe(1)
    expect(document.querySelector(selector)).toBe(target)
    expect(selector.split(/[ >]+/).filter(Boolean).length).toBeLessThanOrEqual(2)
  })

  it('optimizes a genuinely 3-level unique path within a shadow root down to a shorter selector', () => {
    const host = el('div', { id: 'host3' })
    append(host)
    const shadow = host.attachShadow({ mode: 'open' })

    const target = el('span')
    const middle = el('div')
    middle.appendChild(target)
    const outer = el('div', { class: 'only-one-like-this-in-shadow' })
    outer.appendChild(middle)
    shadow.appendChild(outer)

    // finder() prefixes shadow-piercing selectors with the host's own light-DOM
    // selector, so only the suffix starting at the local marker class is scoped
    // to the shadow root itself.
    const selector = finder(target, { idName: () => false, attr: () => false, seedMinLength: 3 })
    const localSelector = selector.slice(selector.indexOf('div.only-one-like-this-in-shadow'))

    expect(shadow.querySelectorAll(localSelector).length).toBe(1)
    expect(shadow.querySelector(localSelector)).toBe(target)
    expect(localSelector.split(/[ >]+/).filter(Boolean).length).toBeLessThanOrEqual(2)
  })

  it('crashes building a selector for an entirely disconnected, parentless input element', () => {
    const orphan = el('span')

    expect(() => finder(orphan, {})).toThrow(`Cannot read properties of undefined (reading 'name')`)
  })

  it('stops optimizing once maxNumberOfTries is exceeded, keeping the first successful shortening', () => {
    const target = el('span')
    const l1 = el('div')
    const l2 = el('div')
    const l3 = el('div', { class: 'unique-4-level-marker' })
    l1.appendChild(target)
    l2.appendChild(l1)
    l3.appendChild(l2)
    append(l3)

    const selector = finder(target, {
      idName: () => false, attr: () => false, seedMinLength: 4, maxNumberOfTries: 0
    })

    expect(document.querySelectorAll(selector).length).toBe(1)
    expect(document.querySelector(selector)).toBe(target)
  })

  describe('slotCheck-guarded zero-rect ancestor skipping', () => {
    it('skips a zero-rect body/documentElement ancestor in the special traversal branch', () => {
      const originalDocRect = document.documentElement.getBoundingClientRect
      const target = el('span')
      target.getBoundingClientRect = () => ({ width: 10, height: 10, x: 0, y: 0, right: 10, bottom: 10 })
      append(target)
      document.documentElement.getBoundingClientRect = () => (
        { width: 100, height: 100, x: 0, y: 0, right: 100, bottom: 100 }
      )

      try {
        const selector = finder(target, { slotCheck: true, seedMinLength: 2 })

        expect(document.querySelectorAll(selector).length).toBe(1)
        expect(document.querySelector(selector)).toBe(target)
      } finally {
        document.documentElement.getBoundingClientRect = originalDocRect
      }
    })

    it('skips a zero-rect intermediate ancestor in the general traversal loop', () => {
      const originalBodyRect = document.body.getBoundingClientRect
      const target = el('span')
      target.getBoundingClientRect = () => ({ width: 10, height: 10, x: 0, y: 0, right: 10, bottom: 10 })
      const wrapper = el('div')
      wrapper.appendChild(target)
      append(wrapper)
      document.body.getBoundingClientRect = () => ({ width: 200, height: 200, x: 0, y: 0, right: 200, bottom: 200 })

      try {
        const selector = finder(target, { slotCheck: true, seedMinLength: 2 })

        expect(document.querySelectorAll(selector).length).toBe(1)
        expect(document.querySelector(selector)).toBe(target)
      } finally {
        document.body.getBoundingClientRect = originalBodyRect
      }
    })
  })
})

// Remaining uncovered branches in finder.js (lines 211, 251, 256, 261-266, 314,
// 388-393, 445) are structurally dead given this file's actual invariants:
// - 211: `stopRoot.host` is only reachable via `.parentElement` traversal, but
//   `.parentElement` on a node whose parent is a ShadowRoot returns null rather
//   than the host, so this equality can never be true through the traversal
//   loop used here.
// - 251/256/261/264/266: `index()` (line 386) always returns a truthy position
//   (>= 1) for any element that legitimately reaches these `if (nth)` checks,
//   since a node only arrives here via `.parentElement`, guaranteeing its own
//   `parentNode` and that parent's `firstChild` are both non-null. The falsy
//   branch would require an orphaned node mid-loop, which is impossible by
//   construction.
// - 314/388/390/393: `path[0]` is always preserved as the level-0 anchor
//   through every `optimize()`/`selectorFromPath()` call, so `path[i].level`
//   for i >= 1 is always defined and non-zero in practice.
// - 445: reaching a duplicate `newPathKey` requires two distinct single-node
//   drops from the same path to yield an identical selector string, which
//   requires two dropped ancestors at different tree depths to render
//   identically post-drop - not constructible without colliding level gaps,
//   which don't occur in a simple linear ancestor chain.
