/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { BaseAction } from './BaseAction.js'

export class CloseAction extends BaseAction {
  handle(step) {
    const closingPage = typeof this.context.pageForTabId === 'function'
      ? (this.context.pageForTabId(step.tabId) || this.context.page)
      : this.context.page
    const activePage = this.context.page
    const actions = [
      `if (!${closingPage}.isClosed()) {`,
      `  await ${closingPage}.close();`,
      '}'
    ]

    this.handleWindowOrTabClose(closingPage, activePage)
    return actions
  }
}
