import { BaseAction } from './BaseAction.js'

export class AssertAction extends BaseAction {
  handle(step) {
    const selector = step.selectors?.find(sel => sel[0])?.[0]
    if (!selector) return []

    const actions = []
    const locator = `${this.context.page}.locator('${selector}')`

    if (step.assertionType === 'containsText' && step.textContent) {
      const escaped = step.textContent.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      actions.push(`await expect(${locator}).toContainText('${escaped}');`)
    } else {
      actions.push(`await expect(${locator}).toBeVisible();`)
    }

    return actions
  }
}
