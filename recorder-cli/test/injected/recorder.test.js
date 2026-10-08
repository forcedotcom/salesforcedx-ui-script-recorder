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
  getSelector.mockReset()
  getClickableTargetFromEvent.mockReset()
  getMouseEventOffsets.mockReset().mockReturnValue({ offsetX: 0, offsetY: 0 })
  finder.mockReset().mockReturnValue('#mock-iframe-selector')
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

      expect(addSpy).toHaveBeenCalledTimes(11)
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
      expect(handlerFor('pointerdown')).not.toBe(handlerFor('click'))

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
      expect(recorder._recordEvent).toHaveBeenCalledWith(second, undefined, expect.any(Number))
    })

    it('keeps the source occurrence time when deferred handling runs later', () => {
      const { recorder, sendMessage } = makeRecorder()
      const input = document.createElement('input')
      input.id = 'deferred-input'
      input.setAttribute('role', 'combobox')
      input.value = 'ready'
      document.body.append(input)
      getSelector.mockReturnValue([['#deferred-input']])

      jest.setSystemTime(new Date('2026-01-01T00:00:01.000Z'))
      recorder._debounceRecordEvent({
        isTrusted: true,
        type: 'input',
        target: input,
        timeStamp: Number.NaN
      })
      jest.setSystemTime(new Date('2026-01-01T00:00:05.000Z'))
      jest.runAllTimers()

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        eventTime: Date.parse('2026-01-01T00:00:01.000Z'),
        orderEventTime: Date.parse('2026-01-01T00:00:01.000Z')
      }))
      input.remove()
    })

    it('normalizes fractional DOM timestamps to integer epoch milliseconds', () => {
      const { recorder } = makeRecorder()
      const relativeTimestamp = 123.875

      expect(recorder._eventOccurrenceTime({ timeStamp: relativeTimestamp })).toBe(
        Math.floor(performance.timeOrigin + relativeTimestamp)
      )
      expect(recorder._eventOccurrenceTime({ timeStamp: 1_800_000_000_000.875 })).toBe(
        1_800_000_000_000
      )
    })

    it('snapshots distinct open-shadow input targets before composedPath expires', () => {
      const { recorder, sendMessage } = makeRecorder()
      const host = document.createElement('x-two-fields')
      const shadow = host.attachShadow({ mode: 'open' })
      const first = Object.assign(document.createElement('input'), { id: 'first', value: 'one' })
      const second = Object.assign(document.createElement('input'), { id: 'second', value: 'two' })
      first.setAttribute('role', 'combobox')
      second.setAttribute('role', 'combobox')
      shadow.append(first, second)
      document.body.append(host)

      let dispatchActive = true
      let deepTarget = first
      getClickableTargetFromEvent.mockImplementation((event) =>
        event.composedPath().find((node) => node instanceof Element) || event.target
      )
      getSelector.mockImplementation((_event, _options, target) => [[`#${target.id}`]])
      const event = (timeStamp) => ({
        isTrusted: true,
        type: 'keyup',
        key: 'x',
        keyCode: 88,
        timeStamp,
        target: host,
        composedPath: () => dispatchActive ? [deepTarget, shadow, host] : []
      })

      recorder._debounceRecordEvent(event(1))
      dispatchActive = false
      jest.runOnlyPendingTimers()
      dispatchActive = true
      deepTarget = second
      recorder._debounceRecordEvent(event(2))
      dispatchActive = false
      jest.runOnlyPendingTimers()

      const messages = sendMessage.mock.calls.map(([message]) => message)
      expect(messages.map(({ selectors }) => selectors)).toEqual([[['#first']], [['#second']]])
      expect(messages.map(({ value }) => value)).toEqual(['one', 'two'])
      expect(messages.map(({ tagName }) => tagName)).toEqual(['INPUT', 'INPUT'])
      expect(messages[0].recordingTargetId).not.toBe(messages[1].recordingTargetId)

      host.remove()
    })

    it.each([
      ['Backspace', ''],
      ['Enter', 'first line\nsecond line']
    ])('keeps the contenteditable input value when trailing %s keyup fires', (key, value) => {
      const { recorder, sendMessage } = makeRecorder()
      const editor = document.createElement('div')
      editor.id = 'description-editor'
      editor.setAttribute('contenteditable', 'true')
      editor.innerHTML = value ? '<p>first line<br>second line</p>' : '<p><br></p>'
      getSelector.mockReturnValue([['#description-editor']])

      recorder._debounceRecordEvent({
        isTrusted: true,
        type: 'input',
        target: editor,
        detail: 0,
        timeStamp: 1
      })
      recorder._debounceRecordEvent({
        isTrusted: true,
        type: 'keyup',
        target: editor,
        key,
        keyCode: key === 'Enter' ? 13 : 8,
        timeStamp: 2
      })
      jest.runAllTimers()

      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'input',
        value,
        isContentEditable: true
      }))
    })

    it('suppresses the trailing keyup when Salesforce replaces the editor after input', () => {
      const { recorder, sendMessage } = makeRecorder()
      const originalEditor = document.createElement('div')
      const replacementEditor = document.createElement('div')
      originalEditor.id = 'description-editor-before'
      replacementEditor.id = 'description-editor-after'
      originalEditor.setAttribute('contenteditable', 'true')
      replacementEditor.setAttribute('contenteditable', 'true')
      originalEditor.innerHTML = '<p>first line<br>second line</p>'
      replacementEditor.innerHTML = '<p>first line<br>second line</p>'
      getSelector.mockImplementation((_event, _options, target) => [[`#${target.id}`]])

      recorder._debounceRecordEvent({
        isTrusted: true,
        type: 'input',
        target: originalEditor,
        timeStamp: 1
      })
      recorder._debounceRecordEvent({
        isTrusted: true,
        type: 'keyup',
        target: replacementEditor,
        key: 'Enter',
        keyCode: 13,
        timeStamp: 2
      })
      jest.runAllTimers()

      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'input',
        selectors: [['#description-editor-before']],
        value: 'first line\nsecond line'
      }))
    })

    it('captures contenteditable input synchronously before a component can replace the editor', () => {
      const { recorder, sendMessage } = makeRecorder()
      const editor = document.createElement('div')
      editor.id = 'description-editor'
      editor.setAttribute('contenteditable', 'true')
      editor.textContent = 'captured now'
      getSelector.mockReturnValue([['#description-editor']])

      recorder._debounceRecordEvent({
        isTrusted: true,
        type: 'input',
        target: editor,
        detail: 0,
        timeStamp: 1
      })

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'input',
        value: 'captured now',
        selectors: [['#description-editor']]
      }))
    })
  })

  describe('_capturePointerDown', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    function pointerEvent(target, overrides = {}) {
      return {
        isTrusted: true,
        type: 'pointerdown',
        target,
        button: 0,
        isPrimary: true,
        pointerId: 7,
        clientX: 40,
        clientY: 50,
        composedPath: () => [target],
        ...overrides
      }
    }

    function clickEvent(target, overrides = {}) {
      return {
        isTrusted: true,
        type: 'click',
        target,
        timeStamp: 2,
        button: 0,
        pointerId: 7,
        clientX: 40,
        clientY: 50,
        detail: 1,
        ...overrides
      }
    }

    it('records the pointer-down selector when the later click is retargeted to an ancestor', () => {
      const { recorder, sendMessage } = makeRecorder()
      const option = document.createElement('button')
      const clickAncestor = document.createElement('div')
      clickAncestor.appendChild(option)
      option.getBoundingClientRect = () => ({
        left: 20, top: 30, right: 80, bottom: 70, width: 60, height: 40
      })
      getClickableTargetFromEvent.mockReturnValueOnce(option)
      getSelector.mockReturnValueOnce([['[data-value="scale-testing-eng"]']])
      getMouseEventOffsets.mockReturnValueOnce({ offsetX: 12, offsetY: 8 })

      recorder._capturePointerDown(pointerEvent(option, {
        composedPath: () => [option, clickAncestor]
      }))

      expect(sendMessage).not.toHaveBeenCalled()
      recorder._recordEvent(clickEvent(clickAncestor))

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        selectors: [['[data-value="scale-testing-eng"]']],
        tagName: 'BUTTON',
        coordinates: { x: 20, y: 20 },
        action: 'click'
      }))
      expect(getSelector).toHaveBeenCalledTimes(1)
    })

    it('keeps the pointer-down snapshot when a normal click moves within the same target', () => {
      const { recorder, sendMessage } = makeRecorder()
      const button = document.createElement('button')
      getClickableTargetFromEvent
        .mockReturnValueOnce(button)
        .mockReturnValueOnce(button)
      getSelector
        .mockReturnValueOnce([['#pointer-button']])
        .mockReturnValueOnce([['#click-button']])
      getMouseEventOffsets.mockReturnValue({ offsetX: 21, offsetY: 2 })

      recorder._capturePointerDown(pointerEvent(button))
      recorder._recordEvent(clickEvent(button, { clientX: 60, clientY: 50 }))

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        selectors: [['#pointer-button']],
        tagName: 'BUTTON',
        coordinates: { x: 21, y: 2 }
      }))
    })

    it('keeps click-time control state while reusing a pointer-down selector', () => {
      const { recorder, sendMessage } = makeRecorder()
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.checked = false
      getClickableTargetFromEvent
        .mockReturnValueOnce(checkbox)
        .mockReturnValueOnce(checkbox)
      getSelector.mockReturnValueOnce([['#stable-checkbox']])

      recorder._capturePointerDown(pointerEvent(checkbox))
      checkbox.checked = true
      recorder._recordEvent(clickEvent(checkbox))

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        selectors: [['#stable-checkbox']],
        inputType: 'checkbox',
        value: true
      }))
    })

    it('does not replace a connected sibling-drag click with the pointer-down child', () => {
      const { recorder, sendMessage } = makeRecorder()
      const commonAncestor = document.createElement('div')
      const pressedChild = document.createElement('button')
      const releasedChild = document.createElement('button')
      commonAncestor.append(pressedChild, releasedChild)
      pressedChild.getBoundingClientRect = () => ({
        left: 20, top: 30, right: 42, bottom: 70, width: 22, height: 40
      })
      getClickableTargetFromEvent
        .mockReturnValueOnce(pressedChild)
        .mockReturnValueOnce(commonAncestor)
      getSelector
        .mockReturnValueOnce([['#pressed-child']])
        .mockReturnValueOnce([['#common-ancestor']])

      recorder._capturePointerDown(pointerEvent(pressedChild, {
        composedPath: () => [pressedChild, commonAncestor]
      }))
      recorder._recordEvent(clickEvent(commonAncestor, { clientX: 44, clientY: 50 }))

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        selectors: [['#common-ancestor']],
        tagName: 'DIV'
      }))
    })

    it('falls back to the click selector after the pointer-down snapshot expires', () => {
      const { recorder, sendMessage } = makeRecorder()
      const option = document.createElement('button')
      const clickAncestor = document.createElement('div')
      getClickableTargetFromEvent.mockReturnValueOnce(option)
      getSelector
        .mockReturnValueOnce([['#pointer-option']])
        .mockReturnValueOnce([['#current-click-target']])

      recorder._capturePointerDown(pointerEvent(option))
      jest.advanceTimersByTime(2001)
      recorder._recordEvent(clickEvent(clickAncestor))

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        selectors: [['#current-click-target']],
        tagName: 'DIV'
      }))
    })

    it('falls back to the click selector when the click is far from the pointer-down location', () => {
      const { recorder, sendMessage } = makeRecorder()
      const option = document.createElement('button')
      const clickAncestor = document.createElement('div')
      getClickableTargetFromEvent.mockReturnValueOnce(option)
      getSelector
        .mockReturnValueOnce([['#pointer-option']])
        .mockReturnValueOnce([['#current-click-target']])

      recorder._capturePointerDown(pointerEvent(option))
      recorder._recordEvent(clickEvent(clickAncestor, { clientX: 140, clientY: 150 }))

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        selectors: [['#current-click-target']],
        tagName: 'DIV'
      }))
    })

    it('does not cache secondary or non-primary pointer-down events', () => {
      const { recorder, sendMessage } = makeRecorder()
      const option = document.createElement('button')
      const clickAncestor = document.createElement('div')
      getSelector.mockReturnValue([['#current-click-target']])

      recorder._capturePointerDown(pointerEvent(option, { button: 2, isPrimary: false }))
      expect(getSelector).not.toHaveBeenCalled()
      recorder._recordEvent(clickEvent(clickAncestor))

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        selectors: [['#current-click-target']],
        tagName: 'DIV'
      }))
    })

    it('does not let a secondary pointer-down erase a pending primary click snapshot', () => {
      const { recorder, sendMessage } = makeRecorder()
      const button = document.createElement('button')
      getClickableTargetFromEvent
        .mockReturnValueOnce(button)
        .mockReturnValueOnce(button)
      getSelector
        .mockReturnValueOnce([['#primary-pointer-target']])
        .mockReturnValueOnce([['#click-target']])

      recorder._capturePointerDown(pointerEvent(button))
      recorder._capturePointerDown(pointerEvent(button, {
        button: 2,
        isPrimary: false,
        pointerId: 8
      }))
      recorder._recordEvent(clickEvent(button))

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        selectors: [['#primary-pointer-target']]
      }))
    })

    it('does not reuse a pointer snapshot for a keyboard-generated click', () => {
      const { recorder, sendMessage } = makeRecorder()
      const option = document.createElement('button')
      const keyboardTarget = document.createElement('button')
      getClickableTargetFromEvent.mockReturnValueOnce(option)
      getSelector
        .mockReturnValueOnce([['#pointer-option']])
        .mockReturnValueOnce([['#keyboard-target']])

      recorder._capturePointerDown(pointerEvent(option))
      recorder._recordEvent(clickEvent(keyboardTarget, {
        detail: 0,
        pointerId: undefined,
        clientX: 0,
        clientY: 0
      }))

      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        selectors: [['#keyboard-target']],
        tagName: 'BUTTON'
      }))
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

    it('deduplicates the same event object when it is delivered twice', () => {
      getSelector.mockReturnValue([['#target']])
      const { recorder, sendMessage } = makeRecorder()
      const target = document.createElement('button')
      const event = { isTrusted: true, type: 'click', target, timeStamp: 100 }

      recorder._recordEvent(event)
      sendMessage.mockClear()
      recorder._recordEvent(event)

      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('records distinct contenteditable input events that share a timeStamp', () => {
      getSelector.mockReturnValue([['#description-editor']])
      const { recorder, sendMessage } = makeRecorder()
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      editor.textContent = 'first value'

      recorder._recordEvent({ isTrusted: true, type: 'input', target: editor, timeStamp: 100 })
      editor.textContent = 'second value'
      recorder._recordEvent({ isTrusted: true, type: 'input', target: editor, timeStamp: 100 })

      expect(sendMessage.mock.calls.map(([message]) => message.value)).toEqual([
        'first value',
        'second value'
      ])
    })

    it.each(['radio', 'checkbox'])(
      'suppresses the browser-forwarded %s click from a recorded label activation',
      (inputType) => {
        const { recorder, sendMessage } = makeRecorder()
        const label = document.createElement('label')
        const fauxControl = document.createElement('span')
        const input = document.createElement('input')
        fauxControl.id = `${inputType}-faux`
        input.id = `${inputType}-input`
        input.type = inputType
        input.checked = true
        label.append(input, fauxControl)
        document.body.append(label)
        getSelector.mockImplementation((_event, _options, target) => [[`#${target.id}`]])

        recorder._recordEvent({
          isTrusted: true,
          type: 'click',
          target: fauxControl,
          detail: 1,
          timeStamp: 100
        })
        recorder._recordEvent({
          isTrusted: true,
          type: 'click',
          target: input,
          detail: 0,
          timeStamp: 100
        })
        recorder._recordEvent({
          isTrusted: true,
          type: 'change',
          target: input,
          timeStamp: 101
        })

        expect(sendMessage.mock.calls.map(([message]) => ({
          action: message.action,
          selectors: message.selectors,
          value: message.value
        }))).toEqual([
          { action: 'click', selectors: [[`#${inputType}-faux`]], value: undefined },
          { action: 'change', selectors: [[`#${inputType}-input`]], value: true }
        ])

        label.remove()
      }
    )

    it('suppresses a forwarded input click for an external label association', () => {
      const { recorder, sendMessage } = makeRecorder()
      const label = document.createElement('label')
      const fauxControl = document.createElement('span')
      const input = document.createElement('input')
      label.htmlFor = 'external-radio'
      fauxControl.id = 'external-faux'
      input.id = 'external-radio'
      input.type = 'radio'
      label.append(fauxControl)
      document.body.append(label, input)
      getSelector.mockImplementation((_event, _options, target) => [[`#${target.id}`]])

      recorder._recordEvent({
        isTrusted: true,
        type: 'click',
        target: fauxControl,
        detail: 1,
        timeStamp: 200
      })
      recorder._recordEvent({
        isTrusted: true,
        type: 'click',
        target: input,
        detail: 0,
        timeStamp: 200
      })

      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'click',
        selectors: [['#external-faux']]
      }))

      label.remove()
      input.remove()
    })

    it('suppresses a forwarded input click when the faux control is inside an open shadow root', () => {
      const { recorder, sendMessage } = makeRecorder()
      const label = document.createElement('label')
      const input = document.createElement('input')
      const host = document.createElement('x-radio-faux')
      const shadow = host.attachShadow({ mode: 'open' })
      const fauxControl = document.createElement('span')
      input.id = 'shadow-radio'
      input.type = 'radio'
      fauxControl.id = 'shadow-faux'
      shadow.append(fauxControl)
      label.append(input, host)
      document.body.append(label)
      getSelector.mockImplementation((_event, _options, target) => [[`#${target.id}`]])
      let firstDispatchActive = true

      recorder._recordEvent({
        isTrusted: true,
        type: 'click',
        target: host,
        detail: 1,
        timeStamp: 210,
        composedPath: () => firstDispatchActive
          ? [fauxControl, shadow, host, label, document.body]
          : []
      }, fauxControl)
      // Native Event.composedPath() is cleared once its dispatch completes.
      firstDispatchActive = false
      recorder._recordEvent({
        isTrusted: true,
        type: 'click',
        target: input,
        detail: 0,
        timeStamp: 210,
        composedPath: () => [input, label, document.body]
      })

      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'click',
        selectors: [['#shadow-faux']]
      }))

      label.remove()
    })

    it('suppresses a forwarded input click when the label contains a slotted faux control', () => {
      const { recorder, sendMessage } = makeRecorder()
      const host = document.createElement('x-slotted-radio')
      const shadow = host.attachShadow({ mode: 'open' })
      const label = document.createElement('label')
      const input = document.createElement('input')
      const slot = document.createElement('slot')
      const fauxControl = document.createElement('span')
      input.id = 'slotted-radio'
      input.type = 'radio'
      slot.name = 'faux'
      fauxControl.id = 'slotted-faux'
      fauxControl.slot = 'faux'
      label.append(input, slot)
      shadow.append(label)
      host.append(fauxControl)
      document.body.append(host)
      getSelector.mockImplementation((_event, _options, target) => [[`#${target.id}`]])

      recorder._recordEvent({
        isTrusted: true,
        type: 'click',
        target: fauxControl,
        detail: 1,
        timeStamp: 220,
        composedPath: () => [fauxControl, slot, label, shadow, host, document.body]
      }, fauxControl)
      recorder._recordEvent({
        isTrusted: true,
        type: 'click',
        target: host,
        detail: 0,
        timeStamp: 220,
        composedPath: () => [input, label, shadow, host, document.body]
      }, input)

      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'click',
        selectors: [['#slotted-faux']]
      }))

      host.remove()
    })

    it.each([
      ['direct pointer activation', { detail: 1, timeStamp: 300 }, null],
      ['keyboard activation', { detail: 0, timeStamp: 301 }, 'keyup'],
      ['an unrelated same-timestamp click', { detail: 0, timeStamp: 302 }, 'click']
    ])('keeps a radio click produced by %s', (_description, clickOverrides, previousType) => {
      const { recorder, sendMessage } = makeRecorder()
      const label = document.createElement('label')
      const fauxControl = document.createElement('span')
      const unrelated = document.createElement('button')
      const input = document.createElement('input')
      fauxControl.id = 'preserved-faux'
      unrelated.id = 'unrelated-button'
      input.id = 'preserved-radio'
      input.type = 'radio'
      label.append(input, fauxControl)
      document.body.append(label, unrelated)
      getSelector.mockImplementation((_event, _options, target) => [[`#${target.id}`]])

      if (previousType) {
        const previousTarget = previousType === 'click' ? unrelated : input
        recorder._recordEvent({
          isTrusted: true,
          type: previousType,
          target: previousTarget,
          detail: previousType === 'click' ? 1 : 0,
          timeStamp: clickOverrides.timeStamp
        })
        sendMessage.mockClear()
      }

      recorder._recordEvent({
        isTrusted: true,
        type: 'click',
        target: input,
        ...clickOverrides
      })

      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'click',
        selectors: [['#preserved-radio']]
      }))

      label.remove()
      unrelated.remove()
    })

    it('keeps a later detail-zero radio click after an earlier click on its label', () => {
      const { recorder, sendMessage } = makeRecorder()
      const label = document.createElement('label')
      const fauxControl = document.createElement('span')
      const input = document.createElement('input')
      fauxControl.id = 'earlier-faux'
      input.id = 'later-radio'
      input.type = 'radio'
      label.append(input, fauxControl)
      document.body.append(label)
      getSelector.mockImplementation((_event, _options, target) => [[`#${target.id}`]])

      recorder._recordEvent({
        isTrusted: true,
        type: 'click',
        target: fauxControl,
        detail: 1,
        timeStamp: 400
      })
      sendMessage.mockClear()
      recorder._recordEvent({
        isTrusted: true,
        type: 'click',
        target: input,
        detail: 0,
        timeStamp: 401
      })

      expect(sendMessage).toHaveBeenCalledTimes(1)
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        action: 'click',
        selectors: [['#later-radio']]
      }))

      label.remove()
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

      it('records nested rich-text input against the contenteditable host', () => {
        const { recorder, sendMessage } = makeRecorder()
        const editor = document.createElement('div')
        const paragraph = document.createElement('p')
        editor.id = 'description-editor'
        paragraph.id = 'description-paragraph'
        editor.setAttribute('contenteditable', 'true')
        paragraph.innerHTML = "Bob's description<br>second line"
        editor.appendChild(paragraph)
        getSelector.mockImplementation((_event, _options, target) => [[`#${target.id}`]])

        recorder._recordEvent({
          isTrusted: true,
          type: 'input',
          target: paragraph,
          detail: 0,
          timeStamp: 1
        })

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
          selectors: [['#description-editor']],
          value: "Bob's description\nsecond line",
          tagName: 'DIV',
          isContentEditable: true,
          action: 'input'
        }))
      })

      it('keeps a native input as the target when it is nested inside a contenteditable container', () => {
        const { recorder, sendMessage } = makeRecorder()
        const editor = document.createElement('div')
        const input = document.createElement('input')
        editor.id = 'outer-editor'
        editor.setAttribute('contenteditable', 'true')
        Object.defineProperty(editor, 'innerText', { value: 'outer editor text', configurable: true })
        input.id = 'embedded-input'
        input.value = 'native input value'
        editor.appendChild(input)
        getSelector.mockImplementation((_event, _options, target) => [[`#${target.id}`]])

        recorder._recordEvent({
          isTrusted: true,
          type: 'change',
          target: input,
          timeStamp: 1
        })

        expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
          selectors: [['#embedded-input']],
          value: 'native input value',
          tagName: 'INPUT',
          isContentEditable: false,
          action: 'change'
        }))
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

    it('assigns a stable element id per target for server-side event correlation', () => {
      getSelector.mockReturnValue([['#target']])
      const { recorder, sendMessage } = makeRecorder()
      const firstTarget = document.createElement('div')
      const secondTarget = document.createElement('div')

      recorder._recordEvent({ isTrusted: true, type: 'change', target: firstTarget, timeStamp: 1 })
      recorder._recordEvent({ isTrusted: true, type: 'change', target: firstTarget, timeStamp: 2 })
      recorder._recordEvent({ isTrusted: true, type: 'change', target: secondTarget, timeStamp: 3 })

      const [firstId, repeatedId, secondId] = sendMessage.mock.calls.map(([message]) => message.recordingTargetId)
      expect(firstId).toBeDefined()
      expect(repeatedId).toBe(firstId)
      expect(secondId).not.toBe(firstId)
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

    it('finds a list ancestor outside an open shadow root', () => {
      getSelector.mockReturnValue([['ul-selector']])
      const { recorder } = makeRecorder()
      const ul = document.createElement('ul')
      const li = document.createElement('li')
      const host = document.createElement('x-list-item')
      const shadow = host.attachShadow({ mode: 'open' })
      const innerButton = document.createElement('button')
      shadow.appendChild(innerButton)
      li.appendChild(host)
      ul.appendChild(li)

      const result = recorder._getParentSelectors({ target: innerButton }, innerButton)

      expect(result).toEqual({ parentSelectors: [['ul-selector']], componentType: 'list' })
      expect(getSelector).toHaveBeenCalledWith(null, expect.anything(), ul)
    })

    it('finds a table ancestor outside an open shadow root', () => {
      getSelector.mockReturnValue([['tbody-selector']])
      const { recorder } = makeRecorder()
      const tbody = document.createElement('tbody')
      const row = document.createElement('tr')
      const cell = document.createElement('td')
      const host = document.createElement('x-table-cell')
      const shadow = host.attachShadow({ mode: 'open' })
      const innerButton = document.createElement('button')
      shadow.appendChild(innerButton)
      host.appendChild(document.createElement('span'))
      cell.appendChild(host)
      row.appendChild(cell)
      tbody.appendChild(row)

      const result = recorder._getParentSelectors({ target: innerButton }, innerButton)

      expect(result).toEqual({ parentSelectors: [['tbody-selector']], componentType: 'table' })
      expect(getSelector).toHaveBeenCalledWith(null, expect.anything(), tbody)
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

    it('returns visible multiline text from a nested contenteditable target', () => {
      const { recorder } = makeRecorder()
      const editor = document.createElement('div')
      const paragraph = document.createElement('p')
      editor.setAttribute('contenteditable', 'true')
      paragraph.innerHTML = 'first line<br>second line'
      editor.appendChild(paragraph)

      expect(recorder._getValue({ target: paragraph, detail: 0 }, paragraph)).toBe('first line\nsecond line')
    })

    it.each([
      ['adjacent paragraphs', '<p>a</p><p>b</p>', 'a\nb'],
      ['adjacent divs', '<div>a</div><div>b</div>', 'a\nb'],
      ['an intentional blank line', '<div>a</div><div><br></div><div>b</div>', 'a\n\nb'],
      ['a trailing blank line', '<p>a</p><p><br></p>', 'a\n'],
      ['two empty lines', '<div><br></div><div><br></div>', '\n'],
      ['mixed inline breaks and blocks', 'a<br><br><div>b</div>', 'a\n\nb'],
      ['nested inline formatting', '<p><span>Hello</span> <strong>world</strong></p>', 'Hello world'],
      ['formatting whitespace around blocks', '<div>\n  <p>a</p>\n  <p>b</p>\n</div>', 'a\nb'],
      ['hidden helper content', '<p>Hello<span hidden> secret</span><span style="display:none"> also hidden</span><span style="visibility:hidden"> invisible</span></p>', 'Hello']
    ])('serializes %s into replay-stable fill text', (_name, html, expected) => {
      const { recorder } = makeRecorder()
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      editor.innerHTML = html

      expect(recorder._getValue({ target: editor, detail: 0 }, editor)).toBe(expected)
    })

    it('normalizes an empty rich-text paragraph to an empty value', () => {
      const { recorder } = makeRecorder()
      const editor = document.createElement('div')
      editor.setAttribute('contenteditable', 'true')
      editor.innerHTML = '<p><br></p>'
      Object.defineProperty(editor, 'innerText', { value: '\n', configurable: true })

      expect(recorder._getValue({ target: editor, detail: 0 }, editor)).toBe('')
    })

    it('does not inherit contenteditable through a shadow-root boundary', () => {
      const { recorder } = makeRecorder()
      const host = document.createElement('div')
      host.setAttribute('contenteditable', 'true')
      Object.defineProperty(host, 'innerText', { value: 'outer editor text', configurable: true })
      const shadow = host.attachShadow({ mode: 'open' })
      const innerControl = document.createElement('input')
      shadow.appendChild(innerControl)

      expect(recorder._getValue({ target: innerControl, detail: 0 }, innerControl)).toBeUndefined()
    })

    it('does not treat a whitespace-padded contenteditable keyword as valid', () => {
      const { recorder } = makeRecorder()
      const target = document.createElement('div')
      target.setAttribute('contenteditable', ' true ')
      target.textContent = 'ordinary div text'

      expect(recorder._getValue({ target, detail: 0 }, target)).toBeUndefined()
    })

    it('lets an invalid contenteditable=false keyword inherit from its editable parent', () => {
      const { recorder } = makeRecorder()
      const editor = document.createElement('div')
      const invalidOverride = document.createElement('div')
      const paragraph = document.createElement('p')
      editor.setAttribute('contenteditable', 'true')
      invalidOverride.setAttribute('contenteditable', ' false ')
      paragraph.textContent = 'inherited editor text'
      invalidOverride.appendChild(paragraph)
      editor.appendChild(invalidOverride)

      expect(recorder._getValue({ target: paragraph, detail: 0 }, paragraph)).toBe('inherited editor text')
    })

    it('uses the highest continuously editable ancestor as the editing host', () => {
      const { recorder } = makeRecorder()
      const outerEditor = document.createElement('div')
      const nestedEditable = document.createElement('div')
      const paragraph = document.createElement('p')
      const outerSibling = document.createElement('div')
      outerEditor.setAttribute('contenteditable', 'true')
      nestedEditable.setAttribute('contenteditable', 'true')
      paragraph.textContent = 'nested fragment'
      outerSibling.textContent = 'outer suffix'
      nestedEditable.appendChild(paragraph)
      outerEditor.append(nestedEditable, outerSibling)

      expect(recorder._getValue({ target: paragraph, detail: 0 }, paragraph)).toBe('nested fragment\nouter suffix')
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
