/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { BaseAction } from './BaseAction.js'
import { toJavaScriptStringLiteral } from './JavaScriptLiteral.js'

// Track which credential variables have already been declared within a single conversion
const declaredVars = new Set()
const volatileSldsSelectorPattern = /\.(?:slds-is-open|slds-has-selection)(?![\w-])/
const comboboxRoleSelectorPattern = /\[role=(?:"combobox"|'combobox'|combobox)\]/i

export function getComboboxActivationSelector(step) {
  return step?.comboboxActivationSelector ||
    step?.selectors?.find(selector => selector?.[0])?.[0]
}

export function isSearchableComboboxChange(step) {
  if (step?.type !== 'change' || step.tagName !== 'INPUT' || step.ensureComboboxOpen !== true) return false

  const primarySelector = step.selectors?.find(selector => selector?.[0])?.[0]
  const activationSelector = getComboboxActivationSelector(step)
  if (!primarySelector || !activationSelector ||
      volatileSldsSelectorPattern.test(activationSelector)) return false

  return step.selectors?.some(selector =>
    selector?.some(part => typeof part === 'string' && comboboxRoleSelectorPattern.test(part))
  ) === true
}

export function buildComboboxOpenGuard(locatorExpression) {
  return `if (\n  (await ${locatorExpression}.first().isVisible()) &&\n  (await ${locatorExpression}.first().getAttribute('aria-expanded')) === 'false'\n) {\n  await ${locatorExpression}.first().click();\n}`
}

export class ChangeAction extends BaseAction {
  static resetDeclaredVars() {
    declaredVars.clear()
  }

  handle(step) {
    const triggeringPage = this.context.page
    const actions = this.handleNewTabOrWindow(step, 'fill', step.value)
    const selector = step.selectors?.find(sel => sel[0])?.[0]
    const ariaSelector = step.selectors?.find(sel => sel[0]?.startsWith('aria'))?.[0]

    if (ariaSelector && this._isUsernameOrPassword(ariaSelector)) {
      this._buildUsernameAndPassword(selector, ariaSelector, actions, triggeringPage)
    }

    if (step.params?.parameterise) {
      const paramName = step.params.paramName
      if (paramName) {
        const paramAction = `let ${paramName} = config.get('${paramName}');`
        this.insertBeforePrimaryAction(actions, paramAction, triggeringPage)
        if (step.inputType === 'checkbox' || step.inputType === 'radio') {
          this.replacePrimaryAction(
            actions,
            `await ${triggeringPage}.locator(${toJavaScriptStringLiteral(selector)}).setChecked(${paramName} == "true");`,
            triggeringPage
          )
        } else {
          this.replacePrimaryAction(
            actions,
            `await ${triggeringPage}.fill(${toJavaScriptStringLiteral(selector)}, ${paramName});`,
            triggeringPage
          )
        }
      }
    }

    if (selector && isSearchableComboboxChange(step)) {
      const activationSelector = getComboboxActivationSelector(step)
      const locator = `${triggeringPage}.locator(${toJavaScriptStringLiteral(activationSelector)})`
      this.insertBeforePrimaryAction(actions, buildComboboxOpenGuard(locator), triggeringPage)
    }

    return this.wrapTriggeredPageClose(step, actions, triggeringPage)
  }

  _isUsernameOrPassword(ariaSelector) {
    const prefixes = ['aria/Username', 'aria/Password']
    return prefixes.some(prefix => ariaSelector.startsWith(prefix))
  }

  _buildUsernameAndPassword(selector, ariaSelector, actions, activePage = this.context.page) {
    if (ariaSelector.startsWith('aria/Username')) {
      if (!declaredVars.has('username')) {
        this.insertBeforePrimaryAction(actions, `const username = config.get('username');`, activePage)
        declaredVars.add('username')
      }
      this.replacePrimaryAction(
        actions,
        `await ${activePage}.fill(${toJavaScriptStringLiteral(selector)}, username);`,
        activePage
      )
    } else {
      if (!declaredVars.has('password')) {
        this.insertBeforePrimaryAction(actions, `const password = config.get('password');`, activePage)
        declaredVars.add('password')
      }
      this.replacePrimaryAction(
        actions,
        `await ${activePage}.fill(${toJavaScriptStringLiteral(selector)}, password);`,
        activePage
      )
    }
  }
}
