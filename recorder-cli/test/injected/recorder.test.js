/**
 * @jest-environment jsdom
 */
jest.mock('../../src/injected/selector.js', () => ({
  getSelector: jest.fn(),
  getClickableTargetFromEvent: jest.fn(),
  getMouseEventOffsets: jest.fn().mockReturnValue({ offsetX: 0, offsetY: 0 })
}))
jest.mock('../../src/injected/finder.js', () => ({
  finder: jest.fn().mockReturnValue('#mock-iframe-selector'),
  finderOptions: { seedMinLength: 5 }
}))

import { getSelector, getClickableTargetFromEvent, getMouseEventOffsets } from '../../src/injected/selector.js'
import { finder } from '../../src/injected/finder.js'
import { Recorder } from '../../src/injected/recorder.js'

function makeRecorder(stateOverrides = {}) {
  const sendMessage = jest.fn()
  const state = { dataAttribute: '', assertNextClick: false, hasRecorded: false, hasAsserted: false, ...stateOverrides }
  const recorder = new Recorder({ state, sendMessage })
  return { recorder, sendMessage, state }
}

function textNode(str) {
  return document.createTextNode(str)
}

afterEach(() => {
  jest.clearAllMocks()
  delete window.__sfRecorderListenersAdded
})

describe('Recorder', () => {
  describe('init', () => {
    let addSpy

    beforeEach(() => {
      addSpy = jest.spyOn(window, 'addEventListener').mockImplementation(() => {})
    })

    afterEach(() => {
      addSpy.mockRestore()
    })

    it('registers a listener for every recorded event type, only once across instances', () => {
      const { recorder } = makeRecorder()
      recorder.init()

      expect(addSpy).toHaveBeenCalledTimes(10)
      const callCountAfterFirst = addSpy.mock.calls.length

      const { recorder: recorder2 } = makeRecorder()
      recorder2.init()

      expect(addSpy).toHaveBeenCalledTimes(callCountAfterFirst)
    })

    it('uses a debounced handler for input/keyup/keydown and a direct bound handler for everything else', () => {
      const { recorder } = makeRecorder()
      recorder.init()

      const handlerFor = (type) => addSpy.mock.calls.find(([t]) => t === type)[1]

      expect(handlerFor('input')).toBe(handlerFor('keyup'))
      expect(handlerFor('keyup')).toBe(handlerFor('keydown'))
      expect(handlerFor('click')).toBe(handlerFor('change'))
      expect(handlerFor('click')).not.toBe(handlerFor('input'))

      for (const [, , capture] of addSpy.mock.calls) {
        expect(capture).toBe(true)
      }
    })

    it('sends the three startup control messages when running in the top frame', () => {
      const { recorder, sendMessage } = makeRecorder()
      recorder.init()

      expect(sendMessage).toHaveBeenCalledWith({ control: 'EVENT_RECORDER_STARTED' })
      expect(sendMessage).toHaveBeenCalledWith({ control: 'GET_VIEWPORT_SIZE' })
      expect(sendMessage).toHaveBeenCalledWith({ control: 'GET_CURRENT_URL' })
      expect(sendMessage).toHaveBeenCalledTimes(3)
    })

    it('sends no startup control messages when constructed inside a non-top frame', () => {
      const originalParent = window.parent
      Object.defineProperty(window, 'parent', { value: { location: {} }, configurable: true })

      try {
        const { recorder, sendMessage } = makeRecorder()
        recorder.init()

        expect(sendMessage).not.toHaveBeenCalled()
      } finally {
        Object.defineProperty(window, 'parent', { value: originalParent, configurable: true })
      }
    })
  })

  describe('_sendMessage', () => {
    it('does not forward a click message while click recording is disabled', () => {
      const { recorder, sendMessage } = makeRecorder()
      recorder.disableClickRecording()

      recorder._sendMessage({ action: 'click' })

      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('forwards a click message again once click recording is re-enabled', () => {
      const { recorder, sendMessage } = makeRecorder()
      recorder.disableClickRecording()
      recorder.enableClickRecording()

      recorder._sendMessage({ action: 'click' })

      expect(sendMessage).toHaveBeenCalledWith({ action: 'click' })
    })

    it('buffers the message into the event log when the send function throws', () => {
      const { recorder } = makeRecorder()
      recorder._sendMessageFn = jest.fn(() => { throw new Error('socket not ready') })

      recorder._sendMessage({ action: 'change' })

      expect(recorder._eventLog).toEqual([{ action: 'change' }])
    })
  })

  describe('_debounceRecordEvent', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('only records the most recent event when fired in quick succession', () => {
      const { recorder } = makeRecorder()
      recorder._recordEvent = jest.fn()
      const first = { timeStamp: 1 }
      const second = { timeStamp: 2 }

      recorder._debounceRecordEvent(first)
      recorder._debounceRecordEvent(second)
      jest.runAllTimers()

      expect(recorder._recordEvent).toHaveBeenCalledTimes(1)
      expect(recorder._recordEvent).toHaveBeenCalledWith(second)
    })
  })

  describe('_recordEvent', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('ignores events that were not user-initiated', () => {
      const { recorder, sendMessage } = makeRecorder()

      recorder._recordEvent({ isTrusted: false, type: 'click' })

      expect(sendMessage).not.toHaveBeenCalled()
    })

    describe('assert mode', () => {
      it('stays armed and sends nothing when the click target has no usable selector', () => {
        getSelector.mockReturnValue(null)
        const { recorder, sendMessage, state } = makeRecorder({ assertNextClick: true })
        const target = document.createElement('div')

        recorder._recordEvent({
          isTrusted: true, type: 'click', target, preventDefault: jest.fn(), stopPropagation: jest.fn()
        })

        expect(state.assertNextClick).toBe(true)
        expect(sendMessage).not.toHaveBeenCalled()
      })

      it('captures direct text node content and disarms after a successful assertion', () => {
        getSelector.mockReturnValue([['#target']])
        const { recorder, sendMessage, state } = makeRecorder({ assertNextClick: true })
        const target = document.createElement('div')
        target.appendChild(textNode('  Hello World  '))
        target.appendChild(document.createElement('span'))
        const preventDefault = jest.fn()
        const stopPropagation = jest.fn()

        recorder._recordEvent({ isTrusted: true, type: 'dblclick', target, preventDefault, stopPropagation })

        expect(preventDefault).toHaveBeenCalled()
        expect(stopPropagation).toHaveBeenCalled()
        expect(state.assertNextClick).toBe(false)
        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
          action: 'assert', assertionType: 'containsText', textContent: 'Hello World', tagName: 'DIV'
        }))

        expect(state.hasAsserted).toBe(true)
        jest.advanceTimersByTime(400)
        expect(state.hasAsserted).toBe(false)
      })

      it('falls back to the first line of innerText when there is no direct text node', () => {
        getSelector.mockReturnValue([['#target']])
        const { recorder, sendMessage } = makeRecorder({ assertNextClick: true })
        const target = document.createElement('div')
        Object.defineProperty(target, 'innerText', { value: 'First Line\nSecond Line', configurable: true })

        recorder._recordEvent({
          isTrusted: true, type: 'click', target, preventDefault: jest.fn(), stopPropagation: jest.fn()
        })

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
          assertionType: 'containsText', textContent: 'First Line'
        }))
      })

      it('uses a visible-only assertion when there is no text at all', () => {
        getSelector.mockReturnValue([['#target']])
        const { recorder, sendMessage } = makeRecorder({ assertNextClick: true })
        const target = document.createElement('div')

        recorder._recordEvent({
          isTrusted: true, type: 'click', target, preventDefault: jest.fn(), stopPropagation: jest.fn()
        })

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
          assertionType: 'visible', textContent: null
        }))
      })

      it('uses a visible-only assertion when the captured text exceeds 200 characters', () => {
        getSelector.mockReturnValue([['#target']])
        const { recorder, sendMessage } = makeRecorder({ assertNextClick: true })
        const target = document.createElement('div')
        target.appendChild(textNode('x'.repeat(201)))

        recorder._recordEvent({
          isTrusted: true, type: 'click', target, preventDefault: jest.fn(), stopPropagation: jest.fn()
        })

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
          assertionType: 'visible', textContent: null
        }))
      })
    })

    it('deduplicates a repeated event that shares the same timeStamp as the previous one', () => {
      getSelector.mockReturnValue([['#target']])
      const { recorder, sendMessage } = makeRecorder()
      const target = document.createElement('button')

      recorder._recordEvent({ isTrusted: true, type: 'click', target, timeStamp: 100 })
      sendMessage.mockClear()
      recorder._recordEvent({ isTrusted: true, type: 'click', target, timeStamp: 100 })

      expect(sendMessage).not.toHaveBeenCalled()
    })

    describe('INPUT change/input filtering', () => {
      it('skips a plain INPUT "input" event (change will carry it)', () => {
        getSelector.mockReturnValue([['#target']])
        const { recorder, sendMessage } = makeRecorder()
        const target = document.createElement('input')

        recorder._recordEvent({ isTrusted: true, type: 'input', target, timeStamp: 1 })

        expect(sendMessage).not.toHaveBeenCalled()
      })

      it('skips a combobox-role INPUT "change" event', () => {
        getSelector.mockReturnValue([['#target']])
        const { recorder, sendMessage } = makeRecorder()
        const target = document.createElement('input')
        target.setAttribute('role', 'combobox')

        recorder._recordEvent({ isTrusted: true, type: 'change', target, timeStamp: 1 })

        expect(sendMessage).not.toHaveBeenCalled()
      })

      it('skips a search-type INPUT "change" event', () => {
        getSelector.mockReturnValue([['#target']])
        const { recorder, sendMessage } = makeRecorder()
        const target = document.createElement('input')
        target.type = 'search'

        recorder._recordEvent({ isTrusted: true, type: 'change', target, timeStamp: 1 })

        expect(sendMessage).not.toHaveBeenCalled()
      })

      it('records a plain (non-combobox, non-search) INPUT "change" event', () => {
        getSelector.mockReturnValue([['#target']])
        const { recorder, sendMessage } = makeRecorder()
        const target = document.createElement('input')

        recorder._recordEvent({ isTrusted: true, type: 'change', target, timeStamp: 1 })

        expect(sendMessage).toHaveBeenCalled()
      })

      it('records a combobox INPUT "input" event (only "change" is filtered for comboboxes)', () => {
        getSelector.mockReturnValue([['#target']])
        const { recorder, sendMessage } = makeRecorder()
        const target = document.createElement('input')
        target.setAttribute('role', 'combobox')

        recorder._recordEvent({ isTrusted: true, type: 'input', target, timeStamp: 1 })

        expect(sendMessage).toHaveBeenCalled()
      })
    })

    it('returns without sending when the main path finds no usable selector', () => {
      getSelector.mockReturnValue(null)
      const { recorder, sendMessage } = makeRecorder()
      const target = document.createElement('button')

      recorder._recordEvent({ isTrusted: true, type: 'click', target, timeStamp: 1 })

      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('swallows unexpected errors thrown while building the event payload', () => {
      getSelector.mockImplementation(() => { throw new Error('boom') })
      const { recorder, sendMessage } = makeRecorder()
      const target = document.createElement('button')

      expect(() => recorder._recordEvent({ isTrusted: true, type: 'click', target, timeStamp: 1 })).not.toThrow()
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('builds a full event payload, flashes hasRecorded, and includes iframe selectors when nested', () => {
      getSelector.mockReturnValue([['#target']])
      const { recorder, sendMessage, state } = makeRecorder()
      recorder._getIframeSelectors = jest.fn().mockReturnValue(['#frame-1'])
      const originalSelf = window.self
      // window.top is non-configurable in jsdom and always equals the real window,
      // so faking window.self to differ from it is enough to enter the "nested frame" branch.
      Object.defineProperty(window, 'self', { value: {}, configurable: true })

      const target = document.createElement('a')
      target.href = 'https://example.com/'

      try {
        recorder._recordEvent({ isTrusted: true, type: 'click', target, timeStamp: 1, keyCode: 13, key: 'Enter' })
      } finally {
        Object.defineProperty(window, 'self', { value: originalSelf, configurable: true })
      }

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        selectors: [['#target']],
        frameSelectors: ['#frame-1'],
        tagName: 'A',
        action: 'click',
        keyCode: 13,
        href: 'https://example.com/',
        key: 'Enter'
      }))
      expect(state.hasRecorded).toBe(true)
      jest.advanceTimersByTime(250)
      expect(state.hasRecorded).toBe(false)
    })

    it('omits keyCode and href when neither is present on the event/target', () => {
      getSelector.mockReturnValue([['#target']])
      const { recorder, sendMessage } = makeRecorder()
      const target = document.createElement('div')

      recorder._recordEvent({ isTrusted: true, type: 'click', target, timeStamp: 1 })

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ keyCode: null, href: null }))
    })
  })

  describe('_getParentSelectors', () => {
    it('identifies a table component via the closest tbody', () => {
      getSelector.mockReturnValue([['tbody-selector']])
      const { recorder } = makeRecorder()
      const tbody = document.createElement('tbody')
      const cell = document.createElement('td')
      tbody.appendChild(cell)

      const result = recorder._getParentSelectors({ target: cell })

      expect(result).toEqual({ parentSelectors: [['tbody-selector']], componentType: 'table' })
    })

    it('identifies a list component via the closest ul when there is no tbody', () => {
      getSelector.mockReturnValue([['ul-selector']])
      const { recorder } = makeRecorder()
      const ul = document.createElement('ul')
      const li = document.createElement('li')
      ul.appendChild(li)

      const result = recorder._getParentSelectors({ target: li })

      expect(result).toEqual({ parentSelectors: [['ul-selector']], componentType: 'list' })
    })

    it('returns null/null when neither a tbody nor a ul ancestor exists', () => {
      const { recorder } = makeRecorder()
      const div = document.createElement('div')

      const result = recorder._getParentSelectors({ target: div })

      expect(result).toEqual({ parentSelectors: null, componentType: null })
      expect(getSelector).not.toHaveBeenCalled()
    })
  })

  describe('_getValue', () => {
    it('masks password field values', () => {
      const { recorder } = makeRecorder()
      const target = document.createElement('input')
      target.type = 'password'
      target.value = 'secret'

      expect(recorder._getValue({ target })).toBe('******')
    })

    it('returns the checked state for a checkbox', () => {
      const { recorder } = makeRecorder()
      const target = document.createElement('input')
      target.type = 'checkbox'
      target.checked = true

      expect(recorder._getValue({ target })).toBe(true)
    })

    it('returns the checked state for a radio button', () => {
      const { recorder } = makeRecorder()
      const target = document.createElement('input')
      target.type = 'radio'
      target.checked = false

      expect(recorder._getValue({ target })).toBe(false)
    })

    it('returns the target value for a plain text field', () => {
      const { recorder } = makeRecorder()
      const target = document.createElement('input')
      target.value = 'typed text'

      expect(recorder._getValue({ target })).toBe('typed text')
    })

    it('falls back to event.detail.value when the target value is empty', () => {
      const { recorder } = makeRecorder()
      const target = document.createElement('input')

      expect(recorder._getValue({ target, detail: { value: 'from-detail' } })).toBe('from-detail')
    })
  })

  describe('_getCoordinates', () => {
    it('returns offsets for an event type that carries coordinates', () => {
      getClickableTargetFromEvent.mockReturnValue('some-element')
      getMouseEventOffsets.mockReturnValue({ offsetX: 12, offsetY: 34 })
      const { recorder } = makeRecorder()

      expect(recorder._getCoordinates({ type: 'click' })).toEqual({ x: 12, y: 34 })
    })

    it('returns null for an event type that does not carry coordinates', () => {
      getClickableTargetFromEvent.mockReturnValue('some-element')
      getMouseEventOffsets.mockReturnValue({ offsetX: 12, offsetY: 34 })
      const { recorder } = makeRecorder()

      expect(recorder._getCoordinates({ type: 'keyup' })).toBeNull()
    })
  })

  describe('_getIframeSelectors', () => {
    it('returns an empty array immediately when already at the top frame', () => {
      const { recorder } = makeRecorder()

      expect(recorder._getIframeSelectors({ target: { ownerDocument: document } })).toEqual([])
    })

    it('_getIframeCssSelector builds a selector scoped to the given ancestor document', () => {
      const { recorder } = makeRecorder()
      const iframeElement = {}
      const currentDocument = {}

      const result = recorder._getIframeCssSelector(iframeElement, currentDocument)

      expect(result).toBe('#mock-iframe-selector')
      expect(finder).toHaveBeenCalledWith(iframeElement, expect.objectContaining({ root: currentDocument }))
    })

    // _getIframeSelectors' while-loop only runs when `currentWindow !== window.top`.
    // `currentWindow` starts as the literal global `window`, and jsdom defines
    // `window.top` as a non-configurable getter that always returns that same
    // `window` - so this comparison is unconditionally false and the loop body
    // (climbing to find matching <iframe>/<frame> ancestors) can never execute
    // in a single-realm jsdom unit test, regardless of what `window.parent`/
    // `window.self` are overridden to. Exercising it would require an actual
    // nested browsing context (a real iframe's contentWindow), which is outside
    // the scope of a jsdom-based unit test for this module.
  })

  describe('disableClickRecording / enableClickRecording', () => {
    it('toggles the internal recording-clicks flag', () => {
      const { recorder } = makeRecorder()

      recorder.disableClickRecording()
      expect(recorder._isRecordingClicks).toBe(false)

      recorder.enableClickRecording()
      expect(recorder._isRecordingClicks).toBe(true)
    })
  })
})
