/**
 * @jest-environment jsdom
 */
jest.mock('../../src/injected/selector.js', () => ({ getSelector: jest.fn() }))

import { getSelector } from '../../src/injected/selector.js'
import { Overlay } from '../../src/injected/overlay.js'
import { OVERLAY_ID, SELECTOR_ID } from '../../src/injected/constants.js'

function makeOverlay(stateOverrides = {}) {
  const sendOverlayAction = jest.fn()
  const state = { isStopped: false, isPaused: false, assertNextClick: false, hasAsserted: false, dataAttribute: '', ...stateOverrides }
  const overlay = new Overlay({ state, sendOverlayAction })
  return { overlay, sendOverlayAction, state }
}

function click(el) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

function stubRect(el, rect) {
  el.getBoundingClientRect = () => ({ top: 0, left: 0, width: 0, height: 0, ...rect })
}

let currentOverlay

afterEach(() => {
  if (currentOverlay) currentOverlay.unmount()
  currentOverlay = null
  document.head.querySelectorAll('style').forEach((s) => s.remove())
  document.body.replaceChildren()
  getSelector.mockReset()
  jest.clearAllTimers()
  jest.useRealTimers()
})

describe('Overlay', () => {
  describe('mount / unmount', () => {
    it('creates the selector and overlay DOM, and is a no-op on a second call', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay

      overlay.mount()

      expect(document.getElementById(SELECTOR_ID)).not.toBeNull()
      expect(document.getElementById(OVERLAY_ID)).not.toBeNull()

      const overlayElBefore = document.getElementById(OVERLAY_ID)
      overlay.mount()
      expect(document.getElementById(OVERLAY_ID)).toBe(overlayElBefore)
    })

    it('injects selector and overlay styles referencing their element ids', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      const styles = [...document.head.querySelectorAll('style')].map((s) => s.textContent).join('\n')
      expect(styles).toContain(`#${SELECTOR_ID}`)
      expect(styles).toContain(`#${OVERLAY_ID}`)
    })

    it('unmount removes both elements, listeners, and is safe to call when never mounted', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay

      expect(() => overlay.unmount()).not.toThrow()

      overlay.mount()
      overlay.unmount()

      expect(document.getElementById(SELECTOR_ID)).toBeNull()
      expect(document.getElementById(OVERLAY_ID)).toBeNull()

      expect(() => overlay.unmount()).not.toThrow()
    })
  })

  describe('mouseover highlight handler', () => {
    it('does nothing while the recording is stopped', () => {
      const { overlay, state } = makeOverlay({ isStopped: true })
      currentOverlay = overlay
      overlay.mount()
      const target = document.createElement('div')
      document.body.appendChild(target)

      document.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
      Object.defineProperty(document.querySelector('body'), 'lastEventTarget', { value: target, configurable: true })

      target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))

      expect(getSelector).not.toHaveBeenCalled()
    })

    it('ignores hovering over the overlay bar or selector box itself', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      const overlayEl = document.getElementById(OVERLAY_ID)
      overlayEl.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))

      expect(getSelector).not.toHaveBeenCalled()
    })

    it('updates the current-selector display and moves the selector box for a normal hover target', () => {
      getSelector.mockReturnValue(['#hovered'])
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const target = document.createElement('div')
      stubRect(target, { top: 10, left: 20, width: 30, height: 40 })
      document.body.appendChild(target)

      target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))

      expect(getSelector).toHaveBeenCalled()
      const display = document.getElementById(OVERLAY_ID).querySelector('.fr-current-selector')
      expect(display.textContent).toBe('#hovered')
      const selectorBox = document.getElementById(SELECTOR_ID).firstChild
      expect(selectorBox.style.top).toBe('8px')
      expect(selectorBox.style.left).toBe('18px')
    })

    it('clears the current-selector display when getSelector finds nothing for the hover target', () => {
      getSelector.mockReturnValue(null)
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const target = document.createElement('div')
      stubRect(target, {})
      document.body.appendChild(target)

      target.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))

      const display = document.getElementById(OVERLAY_ID).querySelector('.fr-current-selector')
      expect(display.textContent).toBe('')
    })
  })

  describe('scroll handler', () => {
    beforeEach(() => jest.useFakeTimers())

    it('hides the selector box while scrolling and restores it after the debounce window', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const selectorBox = document.getElementById(SELECTOR_ID).firstChild

      window.dispatchEvent(new window.Event('scroll'))
      expect(selectorBox.style.display).toBe('none')

      jest.advanceTimersByTime(65)
      expect(selectorBox.style.display).toBe('none')
      jest.advanceTimersByTime(1)
      expect(selectorBox.style.display).toBe('')
    })

    it('restarts the debounce timer on repeated scroll events', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const selectorBox = document.getElementById(SELECTOR_ID).firstChild

      window.dispatchEvent(new window.Event('scroll'))
      jest.advanceTimersByTime(50)
      window.dispatchEvent(new window.Event('scroll'))
      jest.advanceTimersByTime(50)

      expect(selectorBox.style.display).toBe('none')
      jest.advanceTimersByTime(16)
      expect(selectorBox.style.display).toBe('')
    })

    it('is a no-op on both sides of the debounce when there is no selector box', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      overlay._selectorBox = null

      expect(() => overlay._scrollHandler()).not.toThrow()
      expect(() => jest.advanceTimersByTime(66)).not.toThrow()
    })
  })

  describe('keydown handler (Alt+K toggles visibility)', () => {
    it('toggles visibility on Alt+K', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const nav = document.getElementById(OVERLAY_ID).querySelector('.fr-nav')

      document.dispatchEvent(new window.KeyboardEvent('keydown', { altKey: true, keyCode: 75 }))

      expect(nav.style.transform).toContain('translateY(100px)')
    })

    it('ignores other key combinations', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const nav = document.getElementById(OVERLAY_ID).querySelector('.fr-nav')
      const before = nav.style.transform

      document.dispatchEvent(new window.KeyboardEvent('keydown', { altKey: false, keyCode: 75 }))
      document.dispatchEvent(new window.KeyboardEvent('keydown', { altKey: true, keyCode: 65 }))

      expect(nav.style.transform).toBe(before)
    })

    it('does not throw on keyup', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      expect(() => document.dispatchEvent(new window.KeyboardEvent('keyup'))).not.toThrow()
    })
  })

  describe('assert-flash interval', () => {
    beforeEach(() => jest.useFakeTimers())

    it('flashes the assert indicator and clears hasAsserted when set', () => {
      const { overlay, state } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      state.hasAsserted = true

      jest.advanceTimersByTime(50)

      const nav = document.getElementById(OVERLAY_ID).querySelector('.fr-nav')
      expect(nav.classList.contains('fr-assert-flash')).toBe(true)
      expect(state.hasAsserted).toBe(false)
    })

    it('does nothing on tick when hasAsserted is false', () => {
      const { overlay, state } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const nav = document.getElementById(OVERLAY_ID).querySelector('.fr-nav')

      jest.advanceTimersByTime(50)

      expect(nav.classList.contains('fr-assert-flash')).toBe(false)
      expect(state.hasAsserted).toBe(false)
    })
  })

  describe('showStopped', () => {
    it('replaces the nav content with the finished message and hides the selector box', () => {
      const { overlay, state } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      overlay.showStopped()

      expect(state.isStopped).toBe(true)
      const nav = document.getElementById(OVERLAY_ID).querySelector('.fr-nav')
      expect(nav.querySelector('.fr-success-message h3').textContent).toBe('Recording finished!')
      const selectorBox = document.getElementById(SELECTOR_ID).firstChild
      expect(selectorBox.style.display).toBe('none')
    })

    it('rebinds the close button so it still hides the overlay after stopping', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      overlay.showStopped()
      const closeBtn = document.getElementById(OVERLAY_ID).querySelector('[data-action="close"]')
      click(closeBtn)

      const nav = document.getElementById(OVERLAY_ID).querySelector('.fr-nav')
      expect(nav.style.transform).toContain('translateY(100px)')
    })

    it('is a no-op on the nav/selector-box updates when the overlay was never mounted', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay

      expect(() => overlay.showStopped()).not.toThrow()
    })
  })

  describe('button actions via _bindActions', () => {
    it('does nothing when called before the overlay is mounted', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay

      expect(() => overlay._bindActions()).not.toThrow()
    })

    it('stop button sends STOP and shows the stopped state', () => {
      const { overlay, sendOverlayAction } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      click(document.getElementById(OVERLAY_ID).querySelector('[data-action="stop"]'))

      expect(sendOverlayAction).toHaveBeenCalledWith('STOP')
      expect(document.getElementById(OVERLAY_ID).querySelector('.fr-success-message')).not.toBeNull()
    })

    it('pause button pauses then resumes, toggling the icon and rec indicator each time', () => {
      const { overlay, sendOverlayAction, state } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const pauseBtn = document.getElementById(OVERLAY_ID).querySelector('[data-action="pause"]')
      const recEl = document.getElementById(OVERLAY_ID).querySelector('.fr-rec')

      click(pauseBtn)
      expect(state.isPaused).toBe(true)
      expect(sendOverlayAction).toHaveBeenCalledWith('PAUSE')
      expect(pauseBtn.title).toBe('Resume')
      expect(recEl.style.opacity).toBe('0.3')

      click(pauseBtn)
      expect(state.isPaused).toBe(false)
      expect(sendOverlayAction).toHaveBeenCalledWith('UNPAUSE')
      expect(pauseBtn.title).toBe('Pause')
      expect(recEl.style.opacity).toBe('1')
    })

    it('assert button toggles assertNextClick and the active class', () => {
      const { overlay, state } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const assertBtn = document.getElementById(OVERLAY_ID).querySelector('[data-action="assert"]')

      click(assertBtn)
      expect(state.assertNextClick).toBe(true)
      expect(assertBtn.classList.contains('fr-assert-btn-active')).toBe(true)

      click(assertBtn)
      expect(state.assertNextClick).toBe(false)
      expect(assertBtn.classList.contains('fr-assert-btn-active')).toBe(false)
    })

    it('close button toggles overlay visibility', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const nav = document.getElementById(OVERLAY_ID).querySelector('.fr-nav')

      click(document.getElementById(OVERLAY_ID).querySelector('[data-action="close"]'))

      expect(nav.style.transform).toContain('translateY(100px)')
    })

    it('rebinding is a no-op for whichever action buttons are absent from the current DOM', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      document.getElementById(OVERLAY_ID).querySelector('[data-action="close"]').remove()

      expect(() => overlay._bindActions()).not.toThrow()
    })
  })

  describe('_updateCurrentSelector', () => {
    it('truncates text longer than 80 characters', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      overlay._updateCurrentSelector('x'.repeat(90))

      const display = document.getElementById(OVERLAY_ID).querySelector('.fr-current-selector')
      expect(display.textContent).toBe('x'.repeat(80) + '...')
    })

    it('leaves short text unchanged', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      overlay._updateCurrentSelector('short')

      const display = document.getElementById(OVERLAY_ID).querySelector('.fr-current-selector')
      expect(display.textContent).toBe('short')
    })

    it('does not throw when the overlay is not mounted', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay

      expect(() => overlay._updateCurrentSelector('anything')).not.toThrow()
    })
  })

  describe('_moveSelector', () => {
    it('does nothing when there is no selector box', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay

      expect(() => overlay._moveSelector({ target: document.createElement('div') })).not.toThrow()
    })

    it('does nothing while stopped', () => {
      const { overlay, state } = makeOverlay({ isStopped: true })
      currentOverlay = overlay
      overlay.mount()
      const selectorBox = document.getElementById(SELECTOR_ID).firstChild
      selectorBox.style.display = 'none'
      const target = document.createElement('div')
      stubRect(target, { top: 1, left: 1, width: 1, height: 1 })

      overlay._moveSelector({ target })

      expect(selectorBox.style.display).toBe('none')
    })

    it('skips recalculating when the target has not changed since the last move', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const selectorBox = document.getElementById(SELECTOR_ID).firstChild
      const target = document.createElement('div')
      stubRect(target, { top: 5, left: 5, width: 5, height: 5 })

      overlay._moveSelector({ target })
      selectorBox.style.top = '999px'
      overlay._moveSelector({ target })

      expect(selectorBox.style.top).toBe('999px')
    })
  })

  describe('_toggleVisibility / restore hint', () => {
    beforeEach(() => jest.useFakeTimers())

    it('only flips the internal flag when the overlay is not mounted', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay

      expect(() => overlay._toggleVisibility()).not.toThrow()
      expect(overlay._isVisible).toBe(false)
    })

    it('shows a restore hint that fades then removes itself, and dismisses on the next toggle', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      overlay._toggleVisibility()
      const overlayEl = document.getElementById(OVERLAY_ID)
      let hint = overlayEl.querySelector('.fr-restore-hint')
      expect(hint).not.toBeNull()

      jest.advanceTimersByTime(2000)
      expect(hint.classList.contains('fr-restore-hint-fade')).toBe(true)

      jest.advanceTimersByTime(500)
      expect(overlayEl.querySelector('.fr-restore-hint')).toBeNull()
    })

    it('does not throw the removal timeout if the hint was already detached from the DOM', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      overlay._toggleVisibility()
      overlay._restoreHintEl.remove()

      expect(() => jest.advanceTimersByTime(2500)).not.toThrow()
    })

    it('dismisses a pending restore hint immediately when toggled back before it fades', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const overlayEl = document.getElementById(OVERLAY_ID)

      overlay._toggleVisibility()
      expect(overlayEl.querySelector('.fr-restore-hint')).not.toBeNull()

      overlay._toggleVisibility()
      expect(overlayEl.querySelector('.fr-restore-hint')).toBeNull()

      jest.advanceTimersByTime(3000)
      expect(overlayEl.querySelector('.fr-restore-hint')).toBeNull()
    })

    it('_dismissRestoreHint is a no-op when nothing is pending', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()

      expect(() => overlay._dismissRestoreHint()).not.toThrow()
    })

    it('does not set a transform or throw when the nav element is missing', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      document.getElementById(OVERLAY_ID).querySelector('.fr-nav').remove()

      expect(() => overlay._toggleVisibility()).not.toThrow()
      expect(document.getElementById(OVERLAY_ID).querySelector('.fr-restore-hint')).not.toBeNull()
    })
  })

  describe('_flashAssert', () => {
    beforeEach(() => jest.useFakeTimers())

    it('does nothing when the overlay is not mounted', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay

      expect(() => overlay._flashAssert()).not.toThrow()
    })

    it('flashes the nav border and briefly replaces the selector text', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const overlayEl = document.getElementById(OVERLAY_ID)
      const nav = overlayEl.querySelector('.fr-nav')
      const display = overlayEl.querySelector('.fr-current-selector')
      display.textContent = '#previous-selector'

      overlay._flashAssert()

      expect(nav.classList.contains('fr-assert-flash')).toBe(true)
      expect(display.textContent).toBe('Assertion added')
      expect(display.classList.contains('fr-assert-confirmed')).toBe(true)

      jest.advanceTimersByTime(350)
      expect(nav.classList.contains('fr-assert-flash')).toBe(false)

      jest.advanceTimersByTime(850)
      expect(display.textContent).toBe('#previous-selector')
      expect(display.classList.contains('fr-assert-confirmed')).toBe(false)
    })

    it('still flashes the nav border when there is no current-selector display to update', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      const overlayEl = document.getElementById(OVERLAY_ID)
      overlayEl.querySelector('.fr-current-selector').remove()

      expect(() => overlay._flashAssert()).not.toThrow()
      expect(overlayEl.querySelector('.fr-nav').classList.contains('fr-assert-flash')).toBe(true)
    })
  })

  describe('_updateRecIndicator', () => {
    it('does not throw when the rec indicator element is missing', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay
      overlay.mount()
      document.getElementById(OVERLAY_ID).querySelector('.fr-rec').remove()

      expect(() => overlay._updateRecIndicator()).not.toThrow()
    })
  })

  describe('_updateAssertButton', () => {
    it('does nothing when the assert button is missing', () => {
      const { overlay } = makeOverlay()
      currentOverlay = overlay

      expect(() => overlay._updateAssertButton()).not.toThrow()
    })

    it('toggles the selector-box assert-mode class alongside the button', () => {
      const { overlay, state } = makeOverlay({ assertNextClick: true })
      currentOverlay = overlay
      overlay.mount()

      overlay._updateAssertButton()

      const selectorBox = document.getElementById(SELECTOR_ID).firstChild
      expect(selectorBox.classList.contains('sf-assert-mode')).toBe(true)
    })

    it('still toggles the button class when there is no selector box to update', () => {
      const { overlay } = makeOverlay({ assertNextClick: true })
      currentOverlay = overlay
      overlay.mount()
      overlay._selectorBox = null

      overlay._updateAssertButton()

      const assertBtn = document.getElementById(OVERLAY_ID).querySelector('[data-action="assert"]')
      expect(assertBtn.classList.contains('fr-assert-btn-active')).toBe(true)
    })
  })
})
