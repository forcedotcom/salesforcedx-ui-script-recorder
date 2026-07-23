/**
 * Overlay - renders recording UI and element selector highlight directly in the page.
 * Ported from fpsx-ui-recorder/src/modules/overlay/ (Vue components replaced with vanilla DOM).
 *
 * Note: All HTML content here is static/trusted (no user input), since this overlay
 * is built from constants. This is safe from XSS as no external or user-provided
 * strings are interpolated into the markup.
 */
import { getSelector } from './selector.js'
import { OVERLAY_ID, SELECTOR_ID } from './constants.js'

export class Overlay {
  constructor({ state, sendOverlayAction }) {
    this._state = state
    this._sendOverlayAction = sendOverlayAction

    this._overlayEl = null
    this._selectorEl = null
    this._selectorBox = null

    this._mouseOverHandler = null
    this._scrollHandler = null
    this._keyDownHandler = null
    this._scrollTimeout = null
    this._isVisible = true
    this._currentElement = null
  }

  mount() {
    if (this._overlayEl) return

    // --- Create the selector highlight element ---
    this._selectorEl = document.createElement('div')
    this._selectorEl.id = SELECTOR_ID
    this._selectorBox = document.createElement('div')
    this._selectorBox.className = 'sf-recorder-selector-box'
    this._selectorEl.appendChild(this._selectorBox)
    this._injectSelectorStyles()
    document.body.appendChild(this._selectorEl)

    // --- Create the overlay bar ---
    this._overlayEl = document.createElement('div')
    this._overlayEl.id = OVERLAY_ID
    this._buildOverlayDOM(this._overlayEl)
    this._injectOverlayStyles()
    document.body.appendChild(this._overlayEl)

    // --- Bind overlay button actions ---
    this._bindActions()

    // --- Element highlight on hover ---
    this._mouseOverHandler = (e) => {
      if (this._state.isStopped) return

      // Don't highlight overlay elements
      if (e.target.closest && (e.target.closest('#' + OVERLAY_ID) || e.target.closest('#' + SELECTOR_ID))) return

      const selectors = getSelector(e, { dataAttribute: this._state.dataAttribute })
      this._updateCurrentSelector(selectors?.toString() || '')
      this._moveSelector(e)
    }

    this._scrollHandler = () => {
      if (this._selectorBox) {
        this._selectorBox.style.display = 'none'
      }
      clearTimeout(this._scrollTimeout)
      this._scrollTimeout = setTimeout(() => {
        if (this._selectorBox) {
          this._selectorBox.style.display = ''
        }
      }, 66)
    }

    this._keyDownHandler = (e) => {
      // Alt+K to toggle overlay visibility
      if (e.altKey && e.keyCode === 75) {
        this._toggleVisibility()
      }
      // Shift held — switch to assert mode
      if (e.key === 'Shift') {
        if (this._selectorBox) this._selectorBox.classList.add('sf-assert-mode')
        this._setAssertMode(true)
      }
    }

    this._keyUpHandler = (e) => {
      if (e.key === 'Shift') {
        if (this._selectorBox) this._selectorBox.classList.remove('sf-assert-mode')
        this._setAssertMode(false)
      }
    }

    this._assertFlashInterval = setInterval(() => {
      if (this._state.hasAsserted) {
        this._flashAssert()
        this._state.hasAsserted = false
      }
    }, 50)

    window.document.addEventListener('mouseover', this._mouseOverHandler, true)
    window.addEventListener('scroll', this._scrollHandler, false)
    window.document.addEventListener('keydown', this._keyDownHandler, false)
    window.document.addEventListener('keyup', this._keyUpHandler, false)
  }

  unmount() {
    if (this._overlayEl) {
      document.body.removeChild(this._overlayEl)
      this._overlayEl = null
    }
    if (this._selectorEl) {
      document.body.removeChild(this._selectorEl)
      this._selectorEl = null
      this._selectorBox = null
    }

    window.document.removeEventListener('mouseover', this._mouseOverHandler, true)
    window.removeEventListener('scroll', this._scrollHandler, false)
    window.document.removeEventListener('keydown', this._keyDownHandler, false)
    window.document.removeEventListener('keyup', this._keyUpHandler, false)
    clearInterval(this._assertFlashInterval)
  }

  showStopped() {
    this._state.isStopped = true
    const nav = this._overlayEl?.querySelector('.fr-nav')
    if (nav) {
      // Clear existing children
      while (nav.firstChild) nav.removeChild(nav.firstChild)

      // Build stopped UI
      const msg = document.createElement('div')
      msg.className = 'fr-success-message'
      const h3 = document.createElement('h3')
      h3.textContent = 'Recording finished!'
      msg.appendChild(h3)
      nav.appendChild(msg)

      const shortcuts = document.createElement('span')
      shortcuts.className = 'fr-shortcuts'
      const shortcut = document.createElement('span')
      shortcut.className = 'fr-shortcut'
      shortcut.textContent = 'alt + k to hide'
      shortcuts.appendChild(shortcut)
      nav.appendChild(shortcuts)

      const closeBtn = document.createElement('span')
      closeBtn.className = 'fr-close-btn'
      closeBtn.setAttribute('data-action', 'close')
      closeBtn.title = 'Hide overlay'
      const eyeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      eyeSvg.setAttribute('width', '16')
      eyeSvg.setAttribute('height', '16')
      eyeSvg.setAttribute('viewBox', '0 0 24 24')
      eyeSvg.setAttribute('fill', 'none')
      eyeSvg.setAttribute('stroke', 'currentColor')
      eyeSvg.setAttribute('stroke-width', '2')
      eyeSvg.setAttribute('stroke-linecap', 'round')
      eyeSvg.setAttribute('stroke-linejoin', 'round')
      const eyePath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      eyePath.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24')
      eyeSvg.appendChild(eyePath)
      const slashLine = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      slashLine.setAttribute('x1', '1')
      slashLine.setAttribute('y1', '1')
      slashLine.setAttribute('x2', '23')
      slashLine.setAttribute('y2', '23')
      eyeSvg.appendChild(slashLine)
      closeBtn.appendChild(eyeSvg)
      nav.appendChild(closeBtn)

      this._bindActions()
    }
    // Hide selector
    if (this._selectorBox) {
      this._selectorBox.style.display = 'none'
    }
  }

  _buildOverlayDOM(container) {
    const nav = document.createElement('nav')
    nav.className = 'fr-nav'

    // REC indicator
    const rec = document.createElement('div')
    rec.className = 'fr-rec'
    const redDot = document.createElement('span')
    redDot.className = 'fr-red-dot'
    rec.appendChild(redDot)
    rec.appendChild(document.createTextNode(' REC'))
    nav.appendChild(rec)

    // Stop button
    const stopBtn = document.createElement('span')
    stopBtn.className = 'fr-stop-btn'
    stopBtn.setAttribute('data-action', 'stop')
    stopBtn.title = 'Stop recording'
    const stopSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    stopSvg.setAttribute('width', '16')
    stopSvg.setAttribute('height', '16')
    stopSvg.setAttribute('viewBox', '0 0 16 16')
    const stopRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    stopRect.setAttribute('x', '3')
    stopRect.setAttribute('y', '3')
    stopRect.setAttribute('width', '10')
    stopRect.setAttribute('height', '10')
    stopRect.setAttribute('rx', '1')
    stopRect.setAttribute('fill', '#ff4949')
    stopSvg.appendChild(stopRect)
    stopBtn.appendChild(stopSvg)
    nav.appendChild(stopBtn)

    // Pause button
    const pauseBtn = document.createElement('span')
    pauseBtn.className = 'fr-pause-btn'
    pauseBtn.setAttribute('data-action', 'pause')
    pauseBtn.title = 'Pause/Resume'
    this._buildPauseIcon(pauseBtn, false)
    nav.appendChild(pauseBtn)

    // Current selector display
    const selectorDisplay = document.createElement('span')
    selectorDisplay.className = 'fr-current-selector'
    nav.appendChild(selectorDisplay)

    // Assert mode indicator (hidden by default, shown when Shift held)
    const assertIndicator = document.createElement('span')
    assertIndicator.className = 'fr-assert-indicator'
    assertIndicator.textContent = 'ASSERT'
    nav.appendChild(assertIndicator)

    // Shortcut hints (stacked vertically)
    const shortcuts = document.createElement('span')
    shortcuts.className = 'fr-shortcuts'

    const shortcutAssert = document.createElement('span')
    shortcutAssert.className = 'fr-shortcut fr-shortcut-assert'
    const shiftKbd = document.createElement('kbd')
    shiftKbd.textContent = 'shift'
    shortcutAssert.appendChild(shiftKbd)
    shortcutAssert.appendChild(document.createTextNode(' + '))
    shortcutAssert.appendChild(this._buildClickIcon())
    shortcutAssert.appendChild(document.createTextNode(' to assert'))

    const shortcutHide = document.createElement('span')
    shortcutHide.className = 'fr-shortcut'
    const altKbd = document.createElement('kbd')
    altKbd.textContent = 'alt'
    const kKbd = document.createElement('kbd')
    kKbd.textContent = 'k'
    shortcutHide.appendChild(altKbd)
    shortcutHide.appendChild(document.createTextNode(' + '))
    shortcutHide.appendChild(kKbd)
    shortcutHide.appendChild(document.createTextNode(' to hide'))

    shortcuts.appendChild(shortcutAssert)
    shortcuts.appendChild(shortcutHide)
    nav.appendChild(shortcuts)

    // Hide button (eye-slash icon)
    const closeBtn = document.createElement('span')
    closeBtn.className = 'fr-close-btn'
    closeBtn.setAttribute('data-action', 'close')
    closeBtn.title = 'Hide overlay'
    const eyeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    eyeSvg.setAttribute('width', '16')
    eyeSvg.setAttribute('height', '16')
    eyeSvg.setAttribute('viewBox', '0 0 24 24')
    eyeSvg.setAttribute('fill', 'none')
    eyeSvg.setAttribute('stroke', 'currentColor')
    eyeSvg.setAttribute('stroke-width', '2')
    eyeSvg.setAttribute('stroke-linecap', 'round')
    eyeSvg.setAttribute('stroke-linejoin', 'round')
    const eyePath = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    eyePath.setAttribute('d', 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24')
    eyeSvg.appendChild(eyePath)
    const slashLine = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    slashLine.setAttribute('x1', '1')
    slashLine.setAttribute('y1', '1')
    slashLine.setAttribute('x2', '23')
    slashLine.setAttribute('y2', '23')
    eyeSvg.appendChild(slashLine)
    closeBtn.appendChild(eyeSvg)
    nav.appendChild(closeBtn)

    container.appendChild(nav)
  }

  _buildPauseIcon(parent, isPlaying) {
    while (parent.firstChild) parent.removeChild(parent.firstChild)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('viewBox', '0 0 16 16')

    if (isPlaying) {
      // Play triangle icon (means "click to resume")
      const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon')
      polygon.setAttribute('points', '4,3 13,8 4,13')
      polygon.setAttribute('fill', '#fff')
      svg.appendChild(polygon)
    } else {
      // Pause bars icon
      const r1 = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      r1.setAttribute('x', '4')
      r1.setAttribute('y', '3')
      r1.setAttribute('width', '3')
      r1.setAttribute('height', '10')
      r1.setAttribute('rx', '0.5')
      r1.setAttribute('fill', '#fff')
      svg.appendChild(r1)
      const r2 = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      r2.setAttribute('x', '9')
      r2.setAttribute('y', '3')
      r2.setAttribute('width', '3')
      r2.setAttribute('height', '10')
      r2.setAttribute('rx', '0.5')
      r2.setAttribute('fill', '#fff')
      svg.appendChild(r2)
    }

    parent.appendChild(svg)
  }

  _bindActions() {
    if (!this._overlayEl) return

    const stopBtn = this._overlayEl.querySelector('[data-action="stop"]')
    const pauseBtn = this._overlayEl.querySelector('[data-action="pause"]')
    const closeBtn = this._overlayEl.querySelector('[data-action="close"]')

    if (stopBtn) {
      stopBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this._sendOverlayAction('STOP')
        this.showStopped()
      })
    }

    if (pauseBtn) {
      pauseBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (this._state.isPaused) {
          this._state.isPaused = false
          this._sendOverlayAction('UNPAUSE')
          this._buildPauseIcon(pauseBtn, false)
          pauseBtn.title = 'Pause'
        } else {
          this._state.isPaused = true
          this._sendOverlayAction('PAUSE')
          this._buildPauseIcon(pauseBtn, true)
          pauseBtn.title = 'Resume'
        }
        this._updateRecIndicator()
      })
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        this._toggleVisibility()
      })
    }
  }

  _updateRecIndicator() {
    const recEl = this._overlayEl?.querySelector('.fr-rec')
    if (recEl) {
      recEl.style.opacity = this._state.isPaused ? '0.3' : '1'
    }
  }

  _updateCurrentSelector(text) {
    const el = this._overlayEl?.querySelector('.fr-current-selector')
    if (el) {
      el.textContent = text.length > 80 ? text.substring(0, 80) + '...' : text
    }
  }

  _moveSelector(e) {
    if (!this._selectorBox || this._state.isStopped) return
    if (this._currentElement === e.target) return

    this._currentElement = e.target
    const rect = e.target.getBoundingClientRect()

    this._selectorBox.style.position = 'fixed'
    this._selectorBox.style.top = (rect.top - 2) + 'px'
    this._selectorBox.style.left = (rect.left - 2) + 'px'
    this._selectorBox.style.width = (rect.width + 4) + 'px'
    this._selectorBox.style.height = (rect.height + 4) + 'px'
    this._selectorBox.style.display = ''
  }

  _toggleVisibility() {
    this._isVisible = !this._isVisible
    if (this._overlayEl) {
      const nav = this._overlayEl.querySelector('.fr-nav')
      if (nav) {
        nav.style.transform = this._isVisible ? 'translateX(-50%)' : 'translateX(-50%) translateY(100px)'
      }
      if (!this._isVisible) {
        this._showRestoreHint()
      } else {
        this._dismissRestoreHint()
      }
    }
  }

  _showRestoreHint() {
    this._dismissRestoreHint()

    const hint = document.createElement('div')
    hint.className = 'fr-restore-hint'
    const altKbd = document.createElement('kbd')
    altKbd.textContent = 'alt'
    const kKbd = document.createElement('kbd')
    kKbd.textContent = 'k'
    hint.appendChild(altKbd)
    hint.appendChild(document.createTextNode(' + '))
    hint.appendChild(kKbd)
    hint.appendChild(document.createTextNode(' to show overlay'))
    this._overlayEl.appendChild(hint)
    this._restoreHintEl = hint

    this._restoreHintFadeTimeout = setTimeout(() => {
      hint.classList.add('fr-restore-hint-fade')
    }, 2000)
    this._restoreHintRemoveTimeout = setTimeout(() => {
      if (hint.parentNode) hint.parentNode.removeChild(hint)
      this._restoreHintEl = null
    }, 2500)
  }

  _dismissRestoreHint() {
    if (this._restoreHintFadeTimeout) {
      clearTimeout(this._restoreHintFadeTimeout)
      this._restoreHintFadeTimeout = null
    }
    if (this._restoreHintRemoveTimeout) {
      clearTimeout(this._restoreHintRemoveTimeout)
      this._restoreHintRemoveTimeout = null
    }
    if (this._restoreHintEl && this._restoreHintEl.parentNode) {
      this._restoreHintEl.parentNode.removeChild(this._restoreHintEl)
    }
    this._restoreHintEl = null
  }

  _flashAssert() {
    const nav = this._overlayEl?.querySelector('.fr-nav')
    if (!nav) return
    nav.classList.add('fr-assert-flash')
    setTimeout(() => nav.classList.remove('fr-assert-flash'), 350)

    const selectorEl = this._overlayEl?.querySelector('.fr-current-selector')
    if (selectorEl) {
      const prev = selectorEl.textContent
      selectorEl.textContent = 'Assertion added'
      selectorEl.classList.add('fr-assert-confirmed')
      setTimeout(() => {
        selectorEl.textContent = prev
        selectorEl.classList.remove('fr-assert-confirmed')
      }, 1200)
    }
  }

  _buildClickIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'fr-click-icon')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', '#fff')
    svg.setAttribute('stroke', '#fff')
    svg.setAttribute('stroke-width', '1.6')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')

    // Arrow cursor (filled), tip at (8, 8), pointing down-right.
    const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    cursor.setAttribute('d',
      'M8 8 L8 19 L11 16 L13.5 21 L15.5 20 L13 15 L17 14 Z'
    )
    svg.appendChild(cursor)

    // Motion lines — six short rays of equal length, evenly fanned around
    // the cursor's upper region. All ~1.75 units long for visual consistency.
    const motionAttrs = [
      { x1: 4,    y1: 8,    x2: 2.25, y2: 8    }, // straight left
      { x1: 4.75, y1: 4.75, x2: 3.5,  y2: 3.5  }, // diagonal upper-left
      { x1: 8,    y1: 4,    x2: 8,    y2: 2.25 }, // straight up
      { x1: 11.25, y1: 4.75, x2: 12.5, y2: 3.5  }, // diagonal upper-right
      { x1: 12,   y1: 8,    x2: 13.75, y2: 8    }, // straight right
      { x1: 4.75, y1: 11.25, x2: 3.5,  y2: 12.5 }  // diagonal lower-left
    ]
    motionAttrs.forEach(({ x1, y1, x2, y2 }) => {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', String(x1))
      line.setAttribute('y1', String(y1))
      line.setAttribute('x2', String(x2))
      line.setAttribute('y2', String(y2))
      line.setAttribute('stroke', '#fff')
      line.setAttribute('stroke-width', '2')
      line.setAttribute('stroke-linecap', 'round')
      line.setAttribute('fill', 'none')
      svg.appendChild(line)
    })

    return svg
  }

  _setAssertMode(active) {
    if (!this._overlayEl) return
    const indicator = this._overlayEl.querySelector('.fr-assert-indicator')
    if (indicator) {
      indicator.style.display = active ? 'inline-flex' : 'none'
    }
    const shortcut = this._overlayEl.querySelector('.fr-shortcut-assert')
    if (shortcut) {
      while (shortcut.firstChild) shortcut.removeChild(shortcut.firstChild)
      if (active) {
        shortcut.appendChild(this._buildClickIcon())
        shortcut.appendChild(document.createTextNode(' to assert element'))
      } else {
        const shiftKbd = document.createElement('kbd')
        shiftKbd.textContent = 'shift'
        shortcut.appendChild(shiftKbd)
        shortcut.appendChild(document.createTextNode(' + '))
        shortcut.appendChild(this._buildClickIcon())
        shortcut.appendChild(document.createTextNode(' to assert'))
      }
    }
    const hideShortcut = this._overlayEl.querySelector('.fr-shortcuts .fr-shortcut:not(.fr-shortcut-assert)')
    if (hideShortcut) {
      hideShortcut.style.display = active ? 'none' : ''
    }
  }

  _injectSelectorStyles() {
    const style = document.createElement('style')
    style.textContent = `
      #${SELECTOR_ID} {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 2147483646;
      }
      .sf-recorder-selector-box {
        position: fixed;
        background: rgba(73, 149, 255, 0.1);
        border: 2px dashed #1f2d3d;
        pointer-events: none;
        transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s;
      }
      .sf-recorder-selector-box.sf-assert-mode {
        border-color: #4ade80;
        border-style: solid;
        background: rgba(74, 222, 128, 0.15);
      }
    `
    document.head.appendChild(style)
  }

  _injectOverlayStyles() {
    const style = document.createElement('style')
    style.textContent = `
      #${OVERLAY_ID} {
        all: initial;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        z-index: 2147483647;
        pointer-events: none;
      }

      #${OVERLAY_ID} * {
        box-sizing: border-box;
      }

      #${OVERLAY_ID} .fr-nav {
        pointer-events: all;
        display: flex;
        align-items: center;
        gap: 12px;
        position: fixed;
        bottom: 12px;
        left: 50%;
        transform: translateX(-50%);
        width: 720px;
        max-width: calc(100vw - 24px);
        height: 56px;
        padding: 12px 16px;
        background: #032d60;
        border: 2px solid #03234d;
        border-radius: 8px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
        color: #fff;
        font-size: 12px;
        transition: transform 0.3s ease, border-color 0.15s ease;
        animation: fr-slideup 0.3s ease-out;
      }

      #${OVERLAY_ID} .fr-nav.fr-event-flash {
        border-color: #45c8f1 !important;
      }

      #${OVERLAY_ID} .fr-nav.fr-assert-flash {
        border-color: #4ade80 !important;
      }

      @keyframes fr-slideup {
        from { transform: translateX(-50%) translateY(80px); }
        to   { transform: translateX(-50%) translateY(0); }
      }

      @keyframes fr-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }

      #${OVERLAY_ID} .fr-rec {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        font-weight: 700;
        color: #ff4949;
        text-transform: uppercase;
        animation: fr-pulse 2s infinite;
        white-space: nowrap;
      }

      #${OVERLAY_ID} .fr-red-dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ff4949;
      }

      #${OVERLAY_ID} .fr-stop-btn,
      #${OVERLAY_ID} .fr-pause-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 4px;
        border-radius: 4px;
        transition: background 0.15s;
      }

      #${OVERLAY_ID} .fr-stop-btn:hover,
      #${OVERLAY_ID} .fr-pause-btn:hover {
        background: rgba(255, 255, 255, 0.15);
      }

      #${OVERLAY_ID} .fr-stop-btn {
        padding: 4px 6px;
        border-right: 1px solid rgba(255, 255, 255, 0.3);
        margin-right: 4px;
      }

      #${OVERLAY_ID} .fr-current-selector {
        flex: 1;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 10px;
        color: #94a3b8;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #${OVERLAY_ID} .fr-assert-indicator {
        display: none;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        font-weight: 700;
        color: #4ade80;
        text-transform: uppercase;
        padding: 2px 6px;
        border: 1px solid #4ade80;
        border-radius: 3px;
        white-space: nowrap;
      }

      #${OVERLAY_ID} .fr-current-selector.fr-assert-confirmed {
        color: #4ade80 !important;
        font-weight: 600;
      }

      #${OVERLAY_ID} .fr-shortcuts {
        display: flex;
        flex-direction: column;
        gap: 2px;
        white-space: nowrap;
      }

      #${OVERLAY_ID} .fr-shortcut {
        display: flex;
        align-items: center;
        gap: 3px;
        font-size: 10px;
        color: #64748b;
        white-space: nowrap;
      }

      #${OVERLAY_ID} .fr-shortcut kbd {
        display: inline-block;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 9px;
        font-weight: 600;
        color: #cbd5e1;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-bottom-width: 2px;
        border-radius: 3px;
        padding: 1px 4px;
        line-height: 1.2;
      }

      #${OVERLAY_ID} .fr-click-icon {
        flex-shrink: 0;
        vertical-align: middle;
        margin: 0 1px;
        color: #fff;
      }

      #${OVERLAY_ID} .fr-close-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        color: #94a3b8;
        padding: 4px;
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
      }

      #${OVERLAY_ID} .fr-close-btn:hover {
        color: #fff;
        background: rgba(255, 255, 255, 0.15);
      }

      #${OVERLAY_ID} .fr-success-message h3 {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
        color: #4ade80;
      }

      #${OVERLAY_ID} .fr-restore-hint {
        pointer-events: none;
        position: fixed;
        bottom: 16px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        align-items: center;
        gap: 3px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 11px;
        color: rgba(148, 163, 184, 0.85);
        background: rgba(3, 45, 96, 0.7);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        border: 1px solid rgba(3, 35, 77, 0.5);
        border-radius: 6px;
        padding: 8px 12px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
        opacity: 0.9;
        transition: opacity 0.5s ease;
      }

      #${OVERLAY_ID} .fr-restore-hint.fr-restore-hint-fade {
        opacity: 0;
      }

      #${OVERLAY_ID} .fr-restore-hint kbd {
        display: inline-block;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 9px;
        font-weight: 600;
        color: #cbd5e1;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-bottom-width: 2px;
        border-radius: 3px;
        padding: 1px 4px;
        line-height: 1.2;
      }
    `
    document.head.appendChild(style)
  }
}
