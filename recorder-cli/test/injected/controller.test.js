import { Controller } from '../../src/injected/controller.js'

describe('Controller', () => {
  let overlay
  let recorder
  let state
  let sendOverlayAction
  let controller

  beforeEach(() => {
    overlay = { mount: jest.fn(), unmount: jest.fn() }
    recorder = {}
    state = { isClosed: false, isPaused: false }
    sendOverlayAction = jest.fn()
    controller = new Controller({ overlay, recorder, state, sendOverlayAction })
  })

  it('ignores a message with no action', () => {
    controller.handleMessage({})

    expect(overlay.mount).not.toHaveBeenCalled()
    expect(overlay.unmount).not.toHaveBeenCalled()
  })

  it('ignores a null/undefined message', () => {
    expect(() => controller.handleMessage(undefined)).not.toThrow()
    expect(() => controller.handleMessage(null)).not.toThrow()
  })

  it('mounts the overlay on TOGGLE_OVERLAY with value.open truthy', () => {
    controller.handleMessage({ action: 'TOGGLE_OVERLAY', value: { open: true, foo: 'bar' } })

    expect(overlay.mount).toHaveBeenCalledWith({ open: true, foo: 'bar' })
    expect(overlay.unmount).not.toHaveBeenCalled()
  })

  it('unmounts the overlay on TOGGLE_OVERLAY with value.open falsy', () => {
    controller.handleMessage({ action: 'TOGGLE_OVERLAY', value: { open: false } })

    expect(overlay.unmount).toHaveBeenCalled()
    expect(overlay.mount).not.toHaveBeenCalled()
  })

  it('unmounts the overlay on TOGGLE_OVERLAY with no value at all', () => {
    controller.handleMessage({ action: 'TOGGLE_OVERLAY' })

    expect(overlay.unmount).toHaveBeenCalled()
    expect(overlay.mount).not.toHaveBeenCalled()
  })

  it('sets isClosed on STOP', () => {
    controller.handleMessage({ action: 'STOP' })

    expect(state.isClosed).toBe(true)
  })

  it('sets isPaused on PAUSE', () => {
    controller.handleMessage({ action: 'PAUSE' })

    expect(state.isPaused).toBe(true)
  })

  it('clears isPaused on UN_PAUSE', () => {
    state.isPaused = true
    controller.handleMessage({ action: 'UN_PAUSE' })

    expect(state.isPaused).toBe(false)
  })

  it('does nothing for an unrecognized action', () => {
    controller.handleMessage({ action: 'SOMETHING_ELSE' })

    expect(overlay.mount).not.toHaveBeenCalled()
    expect(overlay.unmount).not.toHaveBeenCalled()
    expect(state.isClosed).toBe(false)
    expect(state.isPaused).toBe(false)
  })
})
