/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

// Ported from @fpsx/ui-recorder-utils/src/injected/Logger.ts
// Copyright 2023 The Chromium Authors. All rights reserved.

const noop = () => void 0

export class Logger {
  #log
  #time
  #timeEnd

  constructor(level) {
    switch (level) {
      case 'silent':
        this.#log = noop
        this.#time = noop
        this.#timeEnd = noop
        break
      case 'error':
        this.#log = noop
        this.#time = noop
        this.#timeEnd = noop
        break
      default:
        this.#log = console.log
        this.#time = console.time
        this.#timeEnd = console.timeEnd
        break
    }
  }

  log(...args) {
    this.#log(...args)
  }

  timed(label, action) {
    this.#time(label)
    const value = action()
    this.#timeEnd(label)
    return value
  }
}
