/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

export class ViewportAction {
  constructor(context) {
    this.context = context
  }

  handle(step) {
    return [`await ${this.context.page}.setViewportSize({ width: ${step.width}, height: ${step.height} });`]
  }
}
