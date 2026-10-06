/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

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

const POINTER_SNAPSHOT_MAX_AGE_MS = 2000

export class Recorder {
  constructor({ state, sendMessage }) {
    this._eventLog = []
    this._previousEvent = null
    this._isTopFrame = (window.location === window.parent.location)
    this._isRecordingClicks = true
    this._state = state
    this._sendMessageFn = sendMessage
    this._debounceTimer = null
    this._pointerDownSnapshot = null
    this._recordingTargetIds = new WeakMap()
    this._recordingTargetIdPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    this._nextRecordingTargetId = 1
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
    const capturePointerDown = this._capturePointerDown.bind(this)

    // A component can replace the pressed option before the browser dispatches
    // click, causing click.target to become a shared ancestor. Capture the
    // selector while the original pointer target is still in the DOM.
    window.addEventListener('pointerdown', capturePointerDown, true)

    events.forEach(type => {
      if (type === eventsToRecord.INPUT || type === eventsToRecord.KEYUP || type === eventsToRecord.KEYDOWN) {
        window.addEventListener(type, debouncedRecordEvent, true)
      } else {
        window.addEventListener(type, boundedRecordEvent, true)
      }
    })
  }

  _capturePointerDown(e) {
    if (!e?.isTrusted || e.isPrimary === false || e.button !== 0) return

    this._pointerDownSnapshot = null

    try {
      const target = getClickableTargetFromEvent(e)
      if (!target || !(target instanceof Element)) return

      const selectors = getSelector(e, { dataAttribute: this._state.dataAttribute }, target)
      if (!selectors) return

      let frameSelectors
      if (window.self !== window.top) {
        frameSelectors = this._getIframeSelectors(e, target)
      }

      const { parentSelectors, componentType } = this._getParentSelectors(e, target)
      const rect = target.getBoundingClientRect()
      const pointerPath = typeof e.composedPath === 'function'
        ? e.composedPath().filter(element => element instanceof Element)
        : [target]
      if (!pointerPath.includes(target)) pointerPath.unshift(target)

      this._pointerDownSnapshot = {
        capturedAt: Date.now(),
        pointerId: Number.isFinite(e.pointerId) ? e.pointerId : null,
        button: e.button,
        target,
        pointerPath,
        targetBounds: {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom
        },
        selectors,
        frameSelectors,
        parentSelectors,
        componentType,
        tagName: target.tagName,
        inputType: target.type,
        href: target.href || null
      }
    } catch (err) {
      this._pointerDownSnapshot = null
    }
  }

  _consumePointerDownSnapshot(e, currentTarget) {
    const snapshot = this._pointerDownSnapshot
    this._pointerDownSnapshot = null

    if (!snapshot || e.type !== eventsToRecord.CLICK || e.detail === 0) return null

    const age = Date.now() - snapshot.capturedAt
    if (age < 0 || age > POINTER_SNAPSHOT_MAX_AGE_MS) return null
    if (Number.isFinite(e.button) && e.button !== snapshot.button) return null
    if (Number.isFinite(e.pointerId) && e.pointerId > 0 &&
      snapshot.pointerId > 0 && e.pointerId !== snapshot.pointerId) return null

    if (currentTarget !== snapshot.target) {
      if (!snapshot.pointerPath.includes(currentTarget)) return null

      const { left, top, right, bottom } = snapshot.targetBounds
      if (![e.clientX, e.clientY, left, top, right, bottom].every(Number.isFinite)) return null
      if (e.clientX < left || e.clientX >= right || e.clientY < top || e.clientY >= bottom) return null
    }

    return snapshot
  }

  _debounceRecordEvent(e) {
    clearTimeout(this._debounceTimer)
    // Native composedPath() is cleared after dispatch. Resolve the deep target
    // now so deferred input/key events do not collapse to a shadow host.
    const target = getClickableTargetFromEvent(e) || e.target
    this._debounceTimer = setTimeout(() => this._recordEvent(e, target), 0)
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

  _recordEvent(e, capturedTarget) {
    // Only record user-initiated actions
    if (!e.isTrusted) return

    const currentTarget = capturedTarget || getClickableTargetFromEvent(e) || e.target
    const pointerSnapshot = e.type === eventsToRecord.CLICK
      ? this._consumePointerDownSnapshot(e, currentTarget)
      : null
    const target = pointerSnapshot?.target || currentTarget

    // Assert mode: next click captures an assertion, then resets
    if ((e.type === 'click' || e.type === 'dblclick') && this._state.assertNextClick) {
      e.preventDefault()
      e.stopPropagation()

      const selectors = pointerSnapshot?.selectors ||
        getSelector(e, { dataAttribute: this._state.dataAttribute }, target)
      if (!selectors) return // stay armed — element wasn't selectable

      this._state.assertNextClick = false

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

    // Skip certain input events that are handled by change
    if (target.tagName === 'INPUT' &&
      ((target.role !== 'combobox' && e.type === 'input') ||
       ((target.role === 'combobox' || target.type === 'search') && e.type === 'change'))) {
      return
    }

    this._previousEvent = e

    try {
      let iframeSelectors = pointerSnapshot?.frameSelectors
      if (!pointerSnapshot && window.self !== window.top) {
        iframeSelectors = this._getIframeSelectors(e, target)
      }

      const selectors = pointerSnapshot?.selectors ||
        getSelector(e, { dataAttribute: this._state.dataAttribute }, target)
      if (!selectors) return

      const { parentSelectors, componentType } = pointerSnapshot || this._getParentSelectors(e, target)

      // Flash the overlay to indicate a recorded event
      this._state.hasRecorded = true
      setTimeout(() => { this._state.hasRecorded = false }, 250)

      this._sendMessage({
        selectors,
        frameSelectors: iframeSelectors,
        parentSelectors,
        componentType,
        value: this._getValue(e, target),
        tagName: pointerSnapshot ? pointerSnapshot.tagName : target.tagName,
        inputType: pointerSnapshot ? pointerSnapshot.inputType : target.type,
        action: e.type,
        keyCode: e.keyCode || null,
        href: pointerSnapshot ? pointerSnapshot.href : (target.href || null),
        coordinates: pointerSnapshot
          ? this._getPointerSnapshotCoordinates(e, pointerSnapshot, currentTarget)
          : this._getCoordinates(e, target),
        eventTime: Date.now(),
        type: e.type,
        key: e.key,
        recordingTargetId: this._getRecordingTargetId(target)
      })
    } catch (err) {
      // Swallow errors from non-element events
    }
  }

  _getParentSelectors(e, targetElement) {
    const element = targetElement || e.target
    let parentSelectors = null
    let componentType = null

    const tableBody = this._closestAcrossShadowRoots(element, 'tbody')
    if (tableBody) {
      parentSelectors = getSelector(null, { dataAttribute: this._state.dataAttribute }, tableBody)
      componentType = 'table'
    } else {
      const unorderedList = this._closestAcrossShadowRoots(element, 'ul')
      if (unorderedList) {
        parentSelectors = getSelector(null, { dataAttribute: this._state.dataAttribute }, unorderedList)
        componentType = 'list'
      }
    }

    return { parentSelectors, componentType }
  }

  _closestAcrossShadowRoots(element, selector) {
    let current = element

    while (current instanceof Element) {
      const match = current.closest(selector)
      if (match) return match

      const root = current.getRootNode()
      current = root?.host instanceof Element ? root.host : null
    }

    return null
  }

  _getValue(e, targetElement) {
    const target = targetElement || e.target
    if (target.type !== 'password') {
      return target.type === 'checkbox' || target.type === 'radio'
        ? target.checked
        : (target.value || e?.detail?.value)
    }
    return '******'
  }

  _getRecordingTargetId(target) {
    if (!(target instanceof Element)) return null

    let id = this._recordingTargetIds.get(target)
    if (!id) {
      id = `${this._recordingTargetIdPrefix}:${this._nextRecordingTargetId++}`
      this._recordingTargetIds.set(target, id)
    }

    return id
  }

  _getCoordinates(evt, targetElement) {
    const eventsWithCoordinates = {
      mouseup: true,
      mousedown: true,
      mousemove: true,
      mouseover: true,
      click: true,
    }

    const element = targetElement || getClickableTargetFromEvent(evt)
    const { offsetX, offsetY } = getMouseEventOffsets(evt, element)

    return eventsWithCoordinates[evt.type] ? { x: offsetX, y: offsetY } : null
  }

  _getPointerSnapshotCoordinates(evt, snapshot, currentTarget) {
    if (currentTarget === snapshot.target) {
      return this._getCoordinates(evt, snapshot.target)
    }

    return {
      x: evt.clientX - snapshot.targetBounds.left,
      y: evt.clientY - snapshot.targetBounds.top
    }
  }

  _getIframeSelectors(event, targetElement) {
    let ownerDocument = (targetElement || event.target).ownerDocument
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
