/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { toJavaScriptStringLiteral } from './JavaScriptLiteral.js'
import { BaseAction } from './BaseAction.js'

export class NavigateAction extends BaseAction {
  handle(step) {
    const actions = []
    const activePage = this.context.page
    const newPageNavigation = step.assertedEvents?.find(event => event.isNewTabOrWindow === true)
    const opensNewPage = Boolean(newPageNavigation)
    const targetPage = opensNewPage
      ? this.openNewPage(actions, activePage, newPageNavigation.targetTabId ?? step.tabId)
      : activePage

    actions.push(`await ${targetPage}.goto(${toJavaScriptStringLiteral(step.url)});`)
    const finalNavigation = step.assertedEvents?.find(event => event.type === 'navigation')
    // goto() already waits for the requested navigation. A second exact-URL
    // wait is only needed when recording observed a redirect; legacy flows
    // commonly repeat step.url here, sometimes without the browser's
    // canonical trailing slash.
    if (finalNavigation?.url && finalNavigation.url !== step.url) {
      actions.push(this.buildFinalNavigationWait(targetPage, finalNavigation))
    }
    return this.appendExplicitPageClose(step, actions, targetPage)
  }
}
