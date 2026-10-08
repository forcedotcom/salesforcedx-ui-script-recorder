/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { AssertAction } from './scriptHandlers/AssertAction.js'
import { ClickAction } from './scriptHandlers/ClickAction.js'
import { ChangeAction } from './scriptHandlers/ChangeAction.js'
import { CloseAction } from './scriptHandlers/CloseAction.js'
import { FrameAction } from './scriptHandlers/FrameAction.js'
import { NavigateAction } from './scriptHandlers/NavigateAction.js'
import { ReloadAction } from './scriptHandlers/ReloadAction.js'
import { ViewportAction } from './scriptHandlers/ViewportAction.js'
import { KeyBoardAction } from './scriptHandlers/KeyboardAction.js'
import { Stack } from './Stack.js'
import { BrowserContext } from './BrowserContext.js'

export function getScriptBody(data) {
  // Reset credential variable tracking for each new conversion
  ChangeAction.resetDeclaredVars()

  const stack = new Stack()
  const context = new BrowserContext()
  const commonCounter = { value: 1 }
  stack.push('page')

  const actionsMap = new Map([
    ['assert', (stack, context, commonCounter) => new AssertAction(stack, context, commonCounter, data)],
    ['click', (stack, context, commonCounter) => new ClickAction(stack, context, commonCounter, data)],
    ['doubleClick', (stack, context, commonCounter) => new ClickAction(stack, context, commonCounter, data)],
    ['change', (stack, context, commonCounter) => new ChangeAction(stack, context, commonCounter, data)],
    ['close', (stack, context, commonCounter) => new CloseAction(stack, context, commonCounter, data)],
    ['navigate', (stack, context, commonCounter) => new NavigateAction(stack, context, commonCounter, data)],
    ['reload', (stack, context, commonCounter) => new ReloadAction(stack, context, commonCounter, data)],
    ['setViewport', (stack, context, commonCounter) => new ViewportAction(context)],
    ['keyDown', (stack, context, commonCounter) => new KeyBoardAction(stack, context, commonCounter, data)],
    ['keyUp', (stack, context, commonCounter) => new KeyBoardAction(stack, context, commonCounter, data)],
  ])

  const frameAction = new FrameAction(stack, context, commonCounter, data)
  let scriptBody = []
  let followsLegacyNavigationBoundary = false
  const hasLifecycleCompletionTiming = Number(data.timingVersion) >= 2

  data.steps.forEach(step => {
    context.activatePage(step.tabId)
    const action = actionsMap.get(step.type)
    const isFrameAction = step.frameSelectors?.length && (step.type === 'click' || step.type === 'change')
    const createsLegacyNavigationBoundary = step.type === 'navigate' || step.type === 'reload' ||
      step.assertedEvents?.some(event =>
        event?.type === 'navigation' ||
        event?.isNewTabOrWindow === true
      )

    if (!action && !isFrameAction) {
      if (!hasLifecycleCompletionTiming && createsLegacyNavigationBoundary) {
        followsLegacyNavigationBoundary = true
      }
      return
    }

    if (!followsLegacyNavigationBoundary && Number.isFinite(step.duration) && step.duration > 0) {
      scriptBody.push(`await delay(${step.duration})`)
    }

    followsLegacyNavigationBoundary = false

    if (isFrameAction) {
      const frameActionsScript = frameAction.handle(step)
      if (frameActionsScript) {
        scriptBody = scriptBody.concat(frameActionsScript)
      }
    } else if (action) {
      const actionInstance = action(stack, context, commonCounter, data)
      const actionScript = actionInstance.handle(step)
      if (actionScript) {
        scriptBody = scriptBody.concat(actionScript)
      }
    }

    if (!hasLifecycleCompletionTiming && createsLegacyNavigationBoundary) {
      followsLegacyNavigationBoundary = true
    }
  })

  return scriptBody.join('\n')
}
