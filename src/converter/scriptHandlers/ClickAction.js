import { BaseAction } from './BaseAction.js'

export class ClickAction extends BaseAction {
  static nthSelectorCounters = {
    listCounter: 1,
    tableCounter: 1
  }

  handle(step) {
    const actions = this.handleNewTabOrWindow(step, 'click')

    if (step.params?.parameterise) {
      const childIndex = typeof step.params.childIndex === 'number' && !isNaN(step.params.childIndex) ? step.params.childIndex : null
      const componentAction = this._handleComponentAction(step, childIndex)
      if (componentAction) {
        actions[actions.length - 1] = componentAction
      }
    }

    if (step.assertedEvents?.some(event => event.type === 'windowOrTabClose')) {
      this.handleWindowOrTabClose()
    }
    return actions
  }

  _handleComponentAction(step, childIndex) {
    let childSelector
    if (step.componentType === 'table') {
      childSelector = `${step.parentSelectors?.[0]?.[0]} tr th a`
      return this._generateSelectorAction('tableCounter', childSelector, childIndex)
    } else if (step.componentType === 'list') {
      childSelector = `${step.parentSelectors?.[0]?.[0]} li a`
      return this._generateSelectorAction('listCounter', childSelector, childIndex)
    }
    return null
  }

  _generateSelectorAction(counterKey, childSelector, childIndex) {
    const counter = ClickAction.nthSelectorCounters[counterKey]
    const varName = counterKey.replace('Counter', 'Selector')

    const selector = `
const ${varName}${counter} = await ${this.context.page}.locator('${childSelector}').nth(${childIndex ?? 0})
await ${varName}${counter}.click()
`
    ClickAction.nthSelectorCounters[counterKey] += 1
    return selector
  }
}
