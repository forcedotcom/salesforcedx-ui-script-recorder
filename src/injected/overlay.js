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
    this._selectorBox.className = 'fresh-recorder-selector-box'
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
    }

    window.document.addEventListener('mouseover', this._mouseOverHandler, true)
    window.addEventListener('scroll', this._scrollHandler, false)
    window.document.addEventListener('keydown', this._keyDownHandler, false)
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

      const shortcut = document.createElement('span')
      shortcut.className = 'fr-shortcut'
      shortcut.textContent = 'alt + k to hide'
      nav.appendChild(shortcut)

      const closeBtn = document.createElement('span')
      closeBtn.className = 'fr-close-btn'
      closeBtn.setAttribute('data-action', 'close')
      closeBtn.textContent = '×'
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

    // Shortcut hint
    const shortcut = document.createElement('span')
    shortcut.className = 'fr-shortcut'
    shortcut.textContent = 'alt + k to hide'
    nav.appendChild(shortcut)

    // Close button
    const closeBtn = document.createElement('span')
    closeBtn.className = 'fr-close-btn'
    closeBtn.setAttribute('data-action', 'close')
    closeBtn.title = 'Hide overlay'
    closeBtn.textContent = '×'
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
        nav.style.transform = this._isVisible ? '' : 'translateY(100px)'
      }
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
      .fresh-recorder-selector-box {
        position: fixed;
        background: rgba(73, 149, 255, 0.1);
        border: 2px dashed #1f2d3d;
        pointer-events: none;
        transition: top 0.05s, left 0.05s, width 0.05s, height 0.05s;
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
        padding-right: 12px;
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

      #${OVERLAY_ID} .fr-shortcut {
        font-size: 10px;
        color: #64748b;
        white-space: nowrap;
      }

      #${OVERLAY_ID} .fr-close-btn {
        cursor: pointer;
        font-size: 18px;
        color: #94a3b8;
        padding: 0 4px;
        transition: color 0.15s;
      }

      #${OVERLAY_ID} .fr-close-btn:hover {
        color: #fff;
      }

      #${OVERLAY_ID} .fr-success-message h3 {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
        color: #4ade80;
      }
    `
    document.head.appendChild(style)
  }
}
