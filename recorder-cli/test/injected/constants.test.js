import { OVERLAY_ID, SELECTOR_ID, CURSOR_CAMERA_CLASS, FLASH_CLASS } from '../../src/injected/constants.js'

describe('injected constants', () => {
  it('exports the expected string identifiers', () => {
    expect(OVERLAY_ID).toBe('sf-recorder-overlay')
    expect(SELECTOR_ID).toBe('sf-recorder-selector')
    expect(CURSOR_CAMERA_CLASS).toBe('sf-recorder-camera-cursor')
    expect(FLASH_CLASS).toBe('sf-recorder-flash')
  })
})
