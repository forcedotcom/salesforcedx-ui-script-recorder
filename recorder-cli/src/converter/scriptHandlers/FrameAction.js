/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { BaseAction } from './BaseAction.js'
import { ClickAction, preferScopedTextForFragileListClick } from './ClickAction.js'
import {
  ChangeAction,
  buildComboboxOpenGuard,
  getComboboxActivationSelector,
  isSearchableComboboxChange
} from './ChangeAction.js'
import { toJavaScriptStringLiteral } from './JavaScriptLiteral.js'

export class FrameAction extends BaseAction {
  constructor(stack, context, commonCounter, data) {
    super(stack, context, commonCounter, data)
    this.frameCount = 0
    this.frameAction = 0
  }

  handle(step) {
    const frameActions = []
    let delegatedAction = false

    if (step.frameSelectors?.length) {
      const currentPage = this.context.page || this.stack.peek() || 'page'
      let frameLocatorString = currentPage

      for (const frameSelector of step.frameSelectors) {
        frameLocatorString += `.frameLocator(${toJavaScriptStringLiteral(frameSelector)})`
      }

      frameActions.push(`const frame${this.frameCount} = ${frameLocatorString};`)

      if (step.type === 'click') {
        const replayStep = preferScopedTextForFragileListClick(step)
        const clickSelector = replayStep.selectors?.find(selector => selector?.[0])?.[0]
        if (clickSelector) {
          const timeout = step?.timeout
          frameActions.push(`const frameAction${this.frameAction} = frame${this.frameCount}.locator(${toJavaScriptStringLiteral(clickSelector)});`)
          if (timeout) {
            frameActions.push(`await frameAction${this.frameAction}.click({timeout: ${timeout}})`)
          } else {
            frameActions.push(`await frameAction${this.frameAction}.click()`)
          }
        } else {
          delegatedAction = true
          const clickAction = new ClickAction(this.stack, this.context, this.commonCounter, this.data)
          const clickActionResults = clickAction.handle(step)
          if (clickActionResults) frameActions.push(...clickActionResults)
        }
      }

      if (step.type === 'change') {
        const changeSelector = step.selectors?.find(selector => selector?.[0])?.[0]
        if (changeSelector) {
          frameActions.push(`const frameAction${this.frameAction} = frame${this.frameCount}.locator(${toJavaScriptStringLiteral(changeSelector)});`)
          if (isSearchableComboboxChange(step)) {
            const activationSelector = getComboboxActivationSelector(step)
            const activationLocator = `frame${this.frameCount}.locator(${toJavaScriptStringLiteral(activationSelector)})`
            frameActions.push(buildComboboxOpenGuard(activationLocator))
          }
          if (step.inputType === 'checkbox' || step.inputType === 'radio') {
            frameActions.push(`await frameAction${this.frameAction}.setChecked(${step.value} == true);`)
          } else if (step.inputType === 'select-one') {
            frameActions.push(`await frameAction${this.frameAction}.selectOption(${toJavaScriptStringLiteral(step.value)});`)
          } else {
            frameActions.push(`await frameAction${this.frameAction}.fill(${toJavaScriptStringLiteral(step.value)});`)
          }
        } else {
          delegatedAction = true
          const changeAction = new ChangeAction(this.stack, this.context, this.commonCounter, this.data)
          const changeActionResults = changeAction.handle(step)
          if (changeActionResults) frameActions.push(...changeActionResults)
        }
      }

      this.frameAction++
      this.frameCount++

      // Delegated handlers already manage navigation, popup, and close events.
      if (delegatedAction) return frameActions

      const actionsWithNavigation = this.wrapSamePageNavigation(step, frameActions, currentPage)
      const actionsWithPopup = this.wrapNewTabOrWindow(step, actionsWithNavigation, currentPage)
      return this.wrapTriggeredPageClose(step, actionsWithPopup, currentPage)
    }

    return frameActions
  }
}
