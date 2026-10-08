/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { BaseAction } from './BaseAction.js'
import { toJavaScriptStringLiteral } from './JavaScriptLiteral.js'

export class KeyBoardAction extends BaseAction {
  handle(step) {
    const activePage = this.context.page
    const pressDelay = Number.isFinite(step.keyPressDuration) && step.keyPressDuration > 0
      ? `, { delay: ${Math.round(step.keyPressDuration)} }`
      : ''
    const actions = [
      `await ${activePage}.keyboard.press(${toJavaScriptStringLiteral(step.key)}${pressDelay});`
    ]

    const actionsWithNavigation = this.wrapSamePageNavigation(step, actions, activePage)
    const actionsWithPopup = this.wrapNewTabOrWindow(step, actionsWithNavigation, activePage)
    return this.wrapTriggeredPageClose(step, actionsWithPopup, activePage)
  }
}
