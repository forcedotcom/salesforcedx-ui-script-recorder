/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { BaseAction } from './BaseAction.js'

export class ReloadAction extends BaseAction {
  handle(step) {
    const actions = []
    const activePage = this.context.page
    const opensNewPage = step.assertedEvents?.some(event => event.isNewTabOrWindow === true)
    let targetPage = activePage

    if (opensNewPage) {
      targetPage = this.openNewPage(actions, activePage)
      actions.push(`await ${targetPage}.goto(${activePage}.url());`)
    } else {
      actions.push(`await ${activePage}.reload();`)
    }

    const finalNavigation = step.assertedEvents?.find(event => event.type === 'navigation')
    if (finalNavigation?.url) {
      actions.push(this.buildFinalNavigationWait(targetPage, finalNavigation))
    }

    return this.appendExplicitPageClose(step, actions, targetPage)
  }
}
