/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * Entry point for the injected browser script.
 * This sets up the WebSocket connection and initializes
 * the recorder + overlay inside the target page.
 */
import { Recorder } from './recorder.js'
import { Overlay } from './overlay.js'
import { Controller } from './controller.js'

;(function() {
  if (window.__sfRecorderInjected) return
  window.__sfRecorderInjected = true

  const config = window.__sfRecorderConfig || {}
  const wsPort = config.wsPort
  const dataAttribute = config.dataAttribute || ''

  // --- State (replaces Vuex store) ---
  const state = {
    isPaused: false,
    isStopped: false,
    isClosed: false,
    screenshotMode: false,
    screenshotClippedMode: false,
    hasRecorded: false,
    hasAsserted: false,
    assertNextClick: false,
    dataAttribute,
    recording: []
  }

  // --- WebSocket Connection ---
  let ws = null
  let wsReady = false
  const pendingMessages = []

  function connectWs() {
    ws = new WebSocket(`ws://127.0.0.1:${wsPort}`)

    ws.onopen = () => {
      wsReady = true
      // Flush pending messages
      while (pendingMessages.length > 0) {
        ws.send(JSON.stringify(pendingMessages.shift()))
      }
    }

    ws.onclose = () => {
      wsReady = false
      // Attempt to reconnect after a short delay
      setTimeout(connectWs, 1000)
    }

    ws.onerror = () => {
      // Will trigger onclose
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        controller.handleMessage(msg)
      } catch (err) {
        // ignore
      }
    }
  }

  function sendMessage(msg) {
    if (wsReady && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    } else {
      pendingMessages.push(msg)
    }
  }

  function sendOverlayAction(action) {
    sendMessage({ _type: 'overlay-action', action })
  }

  // --- Initialize ---
  const overlay = new Overlay({ state, sendOverlayAction })
  const recorder = new Recorder({ state, sendMessage })
  const controller = new Controller({ overlay, recorder, state, sendOverlayAction })

  // Connect WebSocket immediately (doesn't need DOM)
  connectWs()

  // Wait for DOM to be ready before mounting overlay and attaching event listeners
  function initWhenReady() {
    if (document.body) {
      overlay.mount()
      recorder.init()
    } else {
      // DOM not ready yet (addInitScript runs early), wait for it
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          overlay.mount()
          recorder.init()
        }, { once: true })
      } else {
        // readyState is 'interactive' or 'complete' but no body yet - poll briefly
        const check = setInterval(() => {
          if (document.body) {
            clearInterval(check)
            overlay.mount()
            recorder.init()
          }
        }, 10)
      }
    }
  }

  initWhenReady()
})()
