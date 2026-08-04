/**
 * Recorder - captures user interactions on the page.
 * Ported from fpsx-ui-recorder/src/modules/recorder/index.js
 */
import { getSelector, getClickableTargetFromEvent, getMouseEventOffsets } from './selector.js'
import { finder, finderOptions } from './finder.js'

const eventsToRecord = {
  CLICK: 'click',
  DBLCLICK: 'dblclick',
  CHANGE: 'change',
  KEYDOWN: 'keydown',
  KEYUP: 'keyup',
  SELECT: 'select',
  SUBMIT: 'submit',
  LOAD: 'load',
  UNLOAD: 'unload',
  INPUT: 'input',
}

const recordingControls = {
  EVENT_RECORDER_STARTED: 'EVENT_RECORDER_STARTED',
  GET_VIEWPORT_SIZE: 'GET_VIEWPORT_SIZE',
  GET_CURRENT_URL: 'GET_CURRENT_URL',
  GET_SCREENSHOT: 'GET_SCREENSHOT',
}

export class Recorder {
  constructor({ state, sendMessage }) {
    this._eventLog = []
    this._previousEvent = null
    this._isTopFrame = (window.location === window.parent.location)
    this._isRecordingClicks = true
    this._state = state
    this._sendMessageFn = sendMessage
    this._debounceTimer = null
  }

  init() {
    const events = Object.values(eventsToRecord)

    if (!window.__sfRecorderListenersAdded) {
      this._addAllListeners(events)
      window.__sfRecorderListenersAdded = true
    }

    if (this._isTopFrame) {
      this._sendMessage({ control: recordingControls.EVENT_RECORDER_STARTED })
      this._sendMessage({ control: recordingControls.GET_VIEWPORT_SIZE })
      this._sendMessage({ control: recordingControls.GET_CURRENT_URL })
    }
  }

  _addAllListeners(events) {
    const boundedRecordEvent = this._recordEvent.bind(this)
    const debouncedRecordEvent = this._debounceRecordEvent.bind(this)

    events.forEach(type => {
      if (type === eventsToRecord.INPUT || type === eventsToRecord.KEYUP || type === eventsToRecord.KEYDOWN) {
        window.addEventListener(type, debouncedRecordEvent, true)
      } else {
        window.addEventListener(type, boundedRecordEvent, true)
      }
    })
  }

  _debounceRecordEvent(e) {
    clearTimeout(this._debounceTimer)
    this._debounceTimer = setTimeout(() => this._recordEvent(e), 0)
  }

  _sendMessage(msg) {
    if (msg.action === 'click' && !this._isRecordingClicks) {
      return
    }

    try {
      this._sendMessageFn(msg)
    } catch (err) {
      this._eventLog.push(msg)
    }
  }

  _recordEvent(e) {
    // Only record user-initiated actions
    if (!e.isTrusted) return

    // Assert mode: next click captures an assertion, then resets
    if ((e.type === 'click' || e.type === 'dblclick') && this._state.assertNextClick) {
      e.preventDefault()
      e.stopPropagation()

      const selectors = getSelector(e, { dataAttribute: this._state.dataAttribute })
      if (!selectors) return // stay armed — element wasn't selectable

      this._state.assertNextClick = false

      const target = e.target
      const directText = Array.from(target.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim())
        .join(' ')
        .trim()
      const rawText = directText || (target.innerText?.split('\n')[0]?.trim() || '')
      const textContent = rawText.length > 0 && rawText.length <= 200 ? rawText : ''

      this._sendMessage({
        selectors,
        action: 'assert',
        assertionType: textContent ? 'containsText' : 'visible',
        textContent: textContent || null,
        tagName: target.tagName,
        eventTime: Date.now()
      })

      this._state.hasAsserted = true
      setTimeout(() => { this._state.hasAsserted = false }, 400)
      return
    }

    // Deduplicate by timestamp
    if (this._previousEvent && this._previousEvent.timeStamp === e.timeStamp) return

    // In the ISOLATED world, event.target IS the deep target — no retargeting
    const target = e.target

    // Skip certain input events that are handled by change
    if (target.tagName === 'INPUT' &&
      ((target.role !== 'combobox' && e.type === 'input') ||
       ((target.role === 'combobox' || target.type === 'search') && e.type === 'change'))) {
      return
    }

    this._previousEvent = e

    try {
      let iframeSelectors
      if (window.self !== window.top) {
        iframeSelectors = this._getIframeSelectors(e)
      }

      const selectors = getSelector(e, { dataAttribute: this._state.dataAttribute })
      if (!selectors) return

      const { parentSelectors, componentType } = this._getParentSelectors(e)

      // Flash the overlay to indicate a recorded event
      this._state.hasRecorded = true
      setTimeout(() => { this._state.hasRecorded = false }, 250)

      this._sendMessage({
        selectors,
        frameSelectors: iframeSelectors,
        parentSelectors,
        componentType,
        value: this._getValue(e),
        tagName: target.tagName,
        inputType: target.type,
        action: e.type,
        keyCode: e.keyCode || null,
        href: target.href || null,
        coordinates: this._getCoordinates(e),
        eventTime: Date.now(),
        type: e.type,
        key: e.key
      })
    } catch (err) {
      // Swallow errors from non-element events
    }
  }

  _getParentSelectors(e) {
    const element = e.target
    let parentSelectors = null
    let componentType = null

    // In ISOLATED world, closest() works across open shadow DOM boundaries
    const tableBody = element.closest('tbody')
    if (tableBody) {
      parentSelectors = getSelector(null, { dataAttribute: this._state.dataAttribute }, tableBody)
      componentType = 'table'
    } else {
      const unorderedList = element.closest('ul')
      if (unorderedList) {
        parentSelectors = getSelector(null, { dataAttribute: this._state.dataAttribute }, unorderedList)
        componentType = 'list'
      }
    }

    return { parentSelectors, componentType }
  }

  _getValue(e) {
    const target = e.target
    if (target.type !== 'password') {
      return target.type === 'checkbox' || target.type === 'radio'
        ? target.checked
        : (target.value || e?.detail?.value)
    }
    return '******'
  }

  _getCoordinates(evt) {
    const eventsWithCoordinates = {
      mouseup: true,
      mousedown: true,
      mousemove: true,
      mouseover: true,
      click: true,
    }

    const element = getClickableTargetFromEvent(evt)
    const { offsetX, offsetY } = getMouseEventOffsets(evt, element)

    return eventsWithCoordinates[evt.type] ? { x: offsetX, y: offsetY } : null
  }

  _getIframeSelectors(event) {
    let ownerDocument = event.target.ownerDocument
    let frameSelectors = []
    let currentWindow = window

    while (currentWindow !== window.top) {
      try {
        currentWindow = currentWindow.parent
        let iframes = []
        let iframeElements = currentWindow.document.querySelectorAll('iframe')
        let frameElements = currentWindow.document.querySelectorAll('frame')
        if (iframeElements && iframeElements.length > 0) {
          iframes = [...iframeElements]
        }
        if (frameElements && frameElements.length > 0) {
          iframes = iframes.concat(Array.from(frameElements))
        }
        for (const iframe of iframes) {
          if (iframe.contentDocument === ownerDocument) {
            const selector = this._getIframeCssSelector(iframe, currentWindow.document)
            frameSelectors.unshift(selector)
            ownerDocument = currentWindow.document
            break
          }
        }
      } catch (e) {
        break
      }
    }

    return frameSelectors
  }

  _getIframeCssSelector(iframeElement, currentDocument) {
    const opt = { ...finderOptions, root: currentDocument }
    return finder(iframeElement, opt)
  }

  disableClickRecording() {
    this._isRecordingClicks = false
  }

  enableClickRecording() {
    this._isRecordingClicks = true
  }
}
