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

const EDITABLE_BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL',
  'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2',
  'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'LI', 'MAIN', 'NAV', 'OL',
  'P', 'PRE', 'SEARCH', 'SECTION', 'SUMMARY', 'UL'
])
const NON_RENDERED_EDITABLE_TAGS = new Set(['NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE'])

function isHiddenEditableElement(element) {
  if (element.hidden || NON_RENDERED_EDITABLE_TAGS.has(element.tagName)) return true

  const view = element.ownerDocument?.defaultView
  if (!view?.getComputedStyle) return false

  const style = view.getComputedStyle(element)
  return style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.contentVisibility === 'hidden'
}

/**
 * Convert editable DOM into the text accepted by Playwright's Locator.fill().
 * Browser innerText inserts different numbers of newlines for P, DIV and blank
 * blocks, so feeding it back to fill is not idempotent. This serializer models
 * block children as logical lines and treats one trailing BR as the browser's
 * caret placeholder.
 */
function getContentEditableFillText(root) {
  function serializeContainer(container) {
    const parts = []
    let inlineTokens = []

    const flushInline = () => {
      if (!inlineTokens.length) return

      if (inlineTokens[inlineTokens.length - 1].kind === 'br') inlineTokens.pop()
      parts.push({
        kind: 'inline',
        text: inlineTokens
          .map(token => token.kind === 'br' ? '\n' : token.text)
          .join('')
      })
      inlineTokens = []
    }

    const visit = node => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.data) {
          inlineTokens.push({ kind: 'text', text: node.data.replace(/\r\n?/g, '\n') })
        }
        return
      }
      if (!(node instanceof Element) || isHiddenEditableElement(node)) return
      if (node.tagName === 'BR') {
        inlineTokens.push({ kind: 'br' })
        return
      }
      if (EDITABLE_BLOCK_TAGS.has(node.tagName)) {
        flushInline()
        parts.push({ kind: 'block', text: serializeContainer(node) })
        return
      }

      for (const child of node.childNodes) visit(child)
    }

    for (const child of container.childNodes) visit(child)
    flushInline()

    return parts
      .filter((part, index) => {
        if (part.kind !== 'inline' || !/^[ \t\r\n]*$/.test(part.text)) return true
        return parts[index - 1]?.kind !== 'block' && parts[index + 1]?.kind !== 'block'
      })
      .map(part => part.text)
      .join('\n')
  }

  return serializeContainer(root)
}

function getExplicitContentEditableState(element) {
  const reflectedState = element.contentEditable
  if (reflectedState === 'true' || reflectedState === 'plaintext-only') return true
  if (reflectedState === 'false') return false
  if (reflectedState === 'inherit') return null

  // JSDOM and older engines may not expose the reflected property. Mirror the
  // enumerated-attribute keywords without trimming: whitespace makes a keyword
  // invalid and therefore inherited in browsers.
  const attribute = element.getAttribute('contenteditable')
  if (attribute === null) return null
  if (attribute === '') return true
  const normalized = attribute.toLowerCase()
  if (normalized === 'true' || normalized === 'plaintext-only') return true
  if (normalized === 'false') return false
  return null
}

export class Recorder {
  constructor({ state, sendMessage }) {
    this._eventLog = []
    this._previousEvent = null
    this._lastRecordedEvent = null
    this._isTopFrame = (window.location === window.parent.location)
    this._isRecordingClicks = true
    this._state = state
    this._sendMessageFn = sendMessage
    this._debounceTimer = null
    this._hasPendingContentEditableInput = false
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
    // Native composedPath() is cleared after dispatch. Resolve the deep target
    // now so deferred input/key events do not collapse to a shadow host.
    const target = getClickableTargetFromEvent(e) || e.target
    const contentEditableHost = this._getContentEditableHost(target)
    const occurrenceTime = this._eventOccurrenceTime(e)

    if (e.type === eventsToRecord.KEYDOWN) {
      this._hasPendingContentEditableInput = false
    } else if (contentEditableHost && e.type === eventsToRecord.INPUT) {
      // Contenteditable mutations are represented by the input event. Keep it
      // authoritative by suppressing the same gesture's trailing keyup
      // (notably Enter or Backspace).
      clearTimeout(this._debounceTimer)
      this._hasPendingContentEditableInput = true
      this._recordEvent(e, contentEditableHost, occurrenceTime)
      return
    } else if (e.type === eventsToRecord.KEYUP && this._hasPendingContentEditableInput) {
      // A reactive component may replace the editing host between input and
      // keyup. The input snapshot is still authoritative for that gesture.
      this._hasPendingContentEditableInput = false
      return
    }

    clearTimeout(this._debounceTimer)
    this._debounceTimer = setTimeout(() => this._recordEvent(e, target, occurrenceTime), 0)
  }

  _eventOccurrenceTime(e) {
    if (Number.isFinite(e?.timeStamp)) {
      // CDP lifecycle callbacks are timestamped with Date.now(), while DOM
      // event timestamps can contain sub-millisecond fractions. Keep both
      // transports on the same integer epoch-millisecond clock so an action
      // from 1000.8 ms cannot be sorted after a lifecycle event captured in
      // the same 1000 ms tick.
      if (e.timeStamp > 1e12) return Math.floor(e.timeStamp)
      if (Number.isFinite(globalThis.performance?.timeOrigin)) {
        return Math.floor(globalThis.performance.timeOrigin + e.timeStamp)
      }
    }
    return Date.now()
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

  _recordEvent(e, capturedTarget, occurrenceTime = this._eventOccurrenceTime(e)) {
    // Only record user-initiated actions
    if (!e.isTrusted) return

    const currentTarget = capturedTarget || getClickableTargetFromEvent(e) || e.target
    const pointerSnapshot = e.type === eventsToRecord.CLICK
      ? this._consumePointerDownSnapshot(e, currentTarget)
      : null
    const contentEditableHost = this._getContentEditableHost(currentTarget)
    const shouldUseContentEditableHost = contentEditableHost &&
      (e.type === eventsToRecord.INPUT ||
       e.type === eventsToRecord.CHANGE ||
       e.type === eventsToRecord.KEYDOWN ||
       e.type === eventsToRecord.KEYUP)
    const target = pointerSnapshot?.target ||
      (shouldUseContentEditableHost ? contentEditableHost : currentTarget)

    // Activating a label dispatches the user's click on the visible label
    // content, then Chromium forwards a second detail-zero click to the
    // associated checkbox/radio. Replaying both clicks targets a commonly
    // covered native input and can also toggle a control twice. Suppress only
    // that exact forwarding sequence; direct pointer and keyboard activations
    // remain recordable.
    if (this._isForwardedCheckableLabelClick(e, target)) return

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
        eventTime: occurrenceTime,
        orderEventTime: occurrenceTime
      })
      this._lastRecordedEvent = this._snapshotRecordedEvent(e, target)

      this._state.hasAsserted = true
      setTimeout(() => { this._state.hasAsserted = false }, 400)
      return
    }

    // The same Event object can occasionally be delivered twice. Distinct
    // events may legitimately share a timestamp when timer precision is low.
    if (this._previousEvent === e) return

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
        isContentEditable: Boolean(this._getContentEditableHost(target)),
        tagName: pointerSnapshot ? pointerSnapshot.tagName : target.tagName,
        inputType: pointerSnapshot ? pointerSnapshot.inputType : target.type,
        action: e.type,
        keyCode: e.keyCode || null,
        href: pointerSnapshot ? pointerSnapshot.href : (target.href || null),
        coordinates: pointerSnapshot
          ? this._getPointerSnapshotCoordinates(e, pointerSnapshot, currentTarget)
          : this._getCoordinates(e, target),
        eventTime: occurrenceTime,
        orderEventTime: occurrenceTime,
        type: e.type,
        key: e.key,
        recordingTargetId: this._getRecordingTargetId(target)
      })
      this._lastRecordedEvent = this._snapshotRecordedEvent(e, target)
    } catch (err) {
      // Swallow errors from non-element events
    }
  }

  _isForwardedCheckableLabelClick(e, target) {
    const previous = this._lastRecordedEvent
    const previousTimeStamp = previous?.event?.timeStamp
    if (e.type !== eventsToRecord.CLICK ||
      e.detail !== 0 ||
      target?.tagName !== 'INPUT' ||
      (target.type !== 'checkbox' && target.type !== 'radio') ||
      previous?.event?.type !== eventsToRecord.CLICK ||
      !Number.isFinite(e.timeStamp) ||
      !Number.isFinite(previousTimeStamp) ||
      previousTimeStamp !== e.timeStamp ||
      !(previous.target instanceof Element)) {
      return false
    }

    const previousPath = previous.path?.length ? previous.path : [previous.target]
    return Array.from(target.labels || []).some(label =>
      previousPath.some(element => label === element || label.contains(element))
    )
  }

  _snapshotRecordedEvent(e, target) {
    let path = []
    try {
      // The browser clears composedPath() after dispatch, before a label's
      // default action emits the forwarded input click.
      if (typeof e.composedPath === 'function') {
        path = e.composedPath().filter(element => element instanceof Element)
      }
    } catch (err) {
      // Some event shims expose composedPath but cannot be read after dispatch.
    }

    if (target instanceof Element && !path.includes(target)) path.unshift(target)
    return { event: e, target, path }
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
    if (target.type === 'password') return '******'
    if (target.type === 'checkbox' || target.type === 'radio') return target.checked

    const contentEditableHost = this._getContentEditableHost(target)
    if (contentEditableHost) {
      return getContentEditableFillText(contentEditableHost)
    }

    return target.value || e?.detail?.value
  }

  _getContentEditableHost(element) {
    if (!(element instanceof Element)) return null
    if (element.matches('input, textarea, select')) return null

    if (typeof element.isContentEditable === 'boolean') {
      if (!element.isContentEditable) return null

      let current = element
      while (current.parentElement?.isContentEditable) current = current.parentElement
      return current
    }

    let current = element
    let editingHost = null
    while (current instanceof Element) {
      const state = getExplicitContentEditableState(current)
      if (state === false) {
        if (!editingHost) return null
        break
      }
      if (state === true) editingHost = current

      if (current.parentElement) {
        current = current.parentElement
      } else {
        // The contenteditable state does not inherit from a shadow host into
        // its shadow tree. Stop here rather than treating unrelated shadow
        // controls as part of an editor on the host.
        current = null
      }
    }

    return editingHost
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
