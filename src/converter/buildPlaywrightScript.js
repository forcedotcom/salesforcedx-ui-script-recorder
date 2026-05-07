import { ClickAction } from './scriptHandlers/ClickAction.js'
import { ChangeAction } from './scriptHandlers/ChangeAction.js'
import { FrameAction } from './scriptHandlers/FrameAction.js'
import { NavigateAction } from './scriptHandlers/NavigateAction.js'
import { ViewportAction } from './scriptHandlers/ViewportAction.js'
import { KeyBoardAction } from './scriptHandlers/KeyboardAction.js'
import { Stack } from './Stack.js'
import { BrowserContext } from './BrowserContext.js'

export function getScriptBody(data) {
  const stack = new Stack()
  const context = new BrowserContext()
  const commonCounter = { value: 1 }
  stack.push('page')

  const actionsMap = new Map([
    ['click', (stack, context, commonCounter) => new ClickAction(stack, context, commonCounter, data)],
    ['doubleClick', (stack, context, commonCounter) => new ClickAction(stack, context, commonCounter, data)],
    ['change', (stack, context, commonCounter) => new ChangeAction(stack, context, commonCounter, data)],
    ['navigate', (stack, context, commonCounter) => new NavigateAction(context)],
    ['setViewport', (stack, context, commonCounter) => new ViewportAction(context)],
    ['keyDown', (stack, context, commonCounter) => new KeyBoardAction(context)],
    ['keyUp', (stack, context, commonCounter) => new KeyBoardAction(context)],
  ])

  const frameAction = new FrameAction(stack, context, commonCounter, data)
  let scriptBody = []

  data.steps.forEach(step => {
    const action = actionsMap.get(step.type)

    if (step.frameSelectors?.length && (step.type === 'click' || step.type === 'change')) {
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
      if (step.duration) {
        scriptBody.push(`await delay(${step.duration})`)
      }
    }
  })

  return scriptBody.join('\n')
}
