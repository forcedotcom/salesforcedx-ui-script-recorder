/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

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
