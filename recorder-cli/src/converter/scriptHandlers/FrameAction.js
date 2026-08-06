/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { BaseAction } from './BaseAction.js'
import { ClickAction } from './ClickAction.js'
import { ChangeAction } from './ChangeAction.js'

export class FrameAction extends BaseAction {
  constructor(stack, context, commonCounter, data) {
    super(stack, context, commonCounter, data)
    this.frameCount = 0
    this.frameAction = 0
  }

  handle(step) {
    const frameActions = []

    if (step.frameSelectors?.length) {
      const currentPage = this.stack.peek() || 'page'
      let frameLocatorString = currentPage

      for (const frameSelector of step.frameSelectors) {
        frameLocatorString += `.frameLocator('${frameSelector}')`
      }

      frameActions.push(`const frame${this.frameCount} = ${frameLocatorString};`)

      if (step.type === 'click') {
        const clickSelector = step.selectors?.find(selector => selector)
        if (clickSelector) {
          const timeout = step?.timeout
          frameActions.push(`const frameAction${this.frameAction} = frame${this.frameCount}.locator('${clickSelector}');`)
          if (timeout) {
            frameActions.push(`await frameAction${this.frameAction}.click({timeout: ${timeout}})`)
          } else {
            frameActions.push(`await frameAction${this.frameAction}.click()`)
          }
        } else {
          const clickAction = new ClickAction(this.stack, this.context, this.commonCounter)
          const clickActionResults = clickAction.handle(step)
          if (clickActionResults) frameActions.push(...clickActionResults)
        }
      }

      if (step.type === 'change') {
        const changeSelector = step.selectors?.find(selector => selector[0])
        if (changeSelector) {
          frameActions.push(`const frameAction${this.frameAction} = frame${this.frameCount}.locator('${changeSelector}');`)
          frameActions.push(`await frameAction${this.frameAction}.fill('${changeSelector}', '${step.value}');`)
        } else {
          const changeAction = new ChangeAction(this.stack, this.context, this.commonCounter)
          const changeActionResults = changeAction.handle(step)
          if (changeActionResults) frameActions.push(...changeActionResults)
        }
      }

      this.frameAction++
      this.frameCount++
    }

    return frameActions
  }
}
