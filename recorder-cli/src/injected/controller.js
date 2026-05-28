/**
 * Controller - routes messages between WebSocket (server) and local components.
 * Ported from fpsx-ui-recorder/src/content-scripts/controller.js
 */

export class Controller {
  constructor({ overlay, recorder, state, sendOverlayAction }) {
    this._overlay = overlay
    this._recorder = recorder
    this._state = state
    this._sendOverlayAction = sendOverlayAction
  }

  /**
   * Handle messages received from the WebSocket server.
   * In the Chrome extension this was chrome.runtime.onMessage.
   */
  handleMessage(msg) {
    if (!msg?.action) return

    switch (msg.action) {
      case 'TOGGLE_OVERLAY':
        if (msg?.value?.open) {
          this._overlay.mount(msg.value)
        } else {
          this._overlay.unmount()
        }
        break

      case 'STOP':
        this._state.isClosed = true
        break

      case 'PAUSE':
        this._state.isPaused = true
        break

      case 'UN_PAUSE':
        this._state.isPaused = false
        break
    }
  }
}
