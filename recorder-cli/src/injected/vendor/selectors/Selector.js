// Ported from @fpsx/ui-recorder-utils/src/injected/selectors/Selector.ts
// Copyright 2023 The Chromium Authors. All rights reserved.

export class SelectorPart {
  constructor(value, optimized) {
    this.value = value
    this.optimized = optimized || false
  }

  toString() {
    return this.value
  }
}
