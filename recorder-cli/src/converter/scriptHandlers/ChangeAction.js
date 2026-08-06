/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { BaseAction } from './BaseAction.js'

// Track which credential variables have already been declared within a single conversion
const declaredVars = new Set()

export class ChangeAction extends BaseAction {
  static resetDeclaredVars() {
    declaredVars.clear()
  }

  handle(step) {
    const actions = this.handleNewTabOrWindow(step, 'fill', step.value)
    const selector = step.selectors?.find(sel => sel[0])?.[0]
    const ariaSelector = step.selectors?.find(sel => sel[0]?.startsWith('aria'))?.[0]

    if (ariaSelector && this._isUsernameOrPassword(ariaSelector)) {
      this._buildUsernameAndPassword(selector, ariaSelector, actions)
    }

    if (step.params?.parameterise) {
      const paramName = step.params.paramName
      if (paramName) {
        const paramAction = `let ${paramName} = config.get('${paramName}');`
        actions.splice(1, 0, paramAction)
        if (step.inputType === 'checkbox' || step.inputType === 'radio') {
          actions[actions.length - 1] = `await ${this.context.page}.locator('${selector}').setChecked(${paramName} == "true");`
        } else {
          actions[actions.length - 1] = `await ${this.context.page}.fill('${selector}', ${paramName});`
        }
      }
    }

    if (step.assertedEvents?.some(event => event.type === 'windowOrTabClose')) {
      this.handleWindowOrTabClose()
    }
    return actions
  }

  _isUsernameOrPassword(ariaSelector) {
    const prefixes = ['aria/Username', 'aria/Password']
    return prefixes.some(prefix => ariaSelector.startsWith(prefix))
  }

  _buildUsernameAndPassword(selector, ariaSelector, actions) {
    if (ariaSelector.startsWith('aria/Username')) {
      if (!declaredVars.has('username')) {
        actions.splice(1, 0, `const username = config.get('username');`)
        declaredVars.add('username')
      }
      actions[actions.length - 1] = `await ${this.context.page}.fill('${selector}', username);`
    } else {
      if (!declaredVars.has('password')) {
        actions.splice(1, 0, `const password = config.get('password');`)
        declaredVars.add('password')
      }
      actions[actions.length - 1] = `await ${this.context.page}.fill('${selector}', password);`
    }
  }
}
