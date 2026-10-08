/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { BaseAction } from './BaseAction.js'
import { toJavaScriptStringLiteral } from './JavaScriptLiteral.js'

export class AssertAction extends BaseAction {
  handle(step) {
    const selector = step.selectors?.find(sel => sel[0])?.[0]
    if (!selector) return []

    const activePage = this.context.page
    const actions = []
    const locator = `${activePage}.locator(${toJavaScriptStringLiteral(selector)})`

    if (step.assertionType === 'containsText' && step.textContent) {
      const firstLine = step.textContent.split('\n')[0].trim()
      actions.push(`await expect(${locator}).toContainText(${toJavaScriptStringLiteral(firstLine)});`)
    } else {
      actions.push(`await expect(${locator}).toBeVisible();`)
    }

    return this.wrapTriggeredPageClose(step, actions, activePage)
  }
}
