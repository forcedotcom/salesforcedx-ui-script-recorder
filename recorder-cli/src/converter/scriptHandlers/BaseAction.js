/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { toJavaScriptStringLiteral } from './JavaScriptLiteral.js'

export class BaseAction {
  constructor(stack, context, commonCounter, data) {
    this.stack = stack
    this.context = context
    this.commonCounter = commonCounter
    this.data = data
  }

  _buildCommentString(step, fields, selector) {
    const commentParts = []

    fields.forEach(field => {
      if (step[field]) commentParts.push(`${field} = ${JSON.stringify(step[field])}`)
    })

    if (step.selectors && Array.isArray(step.selectors)) {
      const alternativeSelectors = step.selectors
        .filter(sel => sel[0] && sel !== selector)
        .map(sel => sel[0])
      if (alternativeSelectors.length > 0) {
        commentParts.push('alternative selectors = [' + alternativeSelectors.map(s => "'" + s + "'").join(', ') + ']')
      }
    }

    if (commentParts.length > 0) {
      return `// ${commentParts.join(', ')}`
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
    }

    return ''
  }

  _buildActionString(step, action, selector, value, options = {}) {
    const awaitStr = options.await ? 'await ' : ''
    const ending = options.ending ?? ''
    const selectorLiteral = toJavaScriptStringLiteral(selector)

    if (step.type === 'click' || step.type === 'doubleClick') {
      const timeout = step?.timeout
      if (timeout) {
        return `${awaitStr}${this.context.page}.${action}(${selectorLiteral}, {timeout: ${timeout}})${ending}`
      }
      return `${awaitStr}${this.context.page}.${action}(${selectorLiteral})${ending}`
    } else if (step.type === 'change') {
      if (step.inputType === 'checkbox' || step.inputType === 'radio') {
        return `${awaitStr}${this.context.page}.locator(${selectorLiteral}).setChecked(${value} == true)${ending}`
      } else if (step.inputType === 'select-one') {
        return `${awaitStr}${this.context.page}.locator(${selectorLiteral}).selectOption(${toJavaScriptStringLiteral(value)})${ending}`
      }
      return `${awaitStr}${this.context.page}.${action}(${selectorLiteral}, ${toJavaScriptStringLiteral(value)})${ending}`
    }

    return `${awaitStr}${this.context.page}.${action}(${selectorLiteral})${ending}`
  }

  handleNewTabOrWindow(step, action, value) {
    const actions = []
    const selector = step.selectors?.find(sel => sel[0])
    const activePage = this.context.page
    const popupNavigation = step.assertedEvents?.find(event => event.isNewTabOrWindow === true)

    if (popupNavigation) {
      actions.push(`const pageEvent${this.commonCounter.value} = ${activePage}.waitForEvent('popup');`)
      actions.push(this._buildCommentString(step, ['tagName', 'inputType', 'value', 'parentSelectors'], selector))
      actions.push(this._buildActionString(step, action, selector?.[0], value, { await: true, ending: ';' }))
      const popupPage = `tab${this.commonCounter.value}`
      actions.push(`const ${popupPage} = await pageEvent${this.commonCounter.value};`)
      actions.push(this.buildFinalNavigationWait(popupPage, popupNavigation))
      this.stack.push(popupPage)
      if (typeof this.context.registerPage === 'function') {
        this.context.registerPage(popupNavigation.targetTabId, popupPage)
      } else {
        this.context.page = popupPage
      }
      this.commonCounter.value++
    } else {
      actions.push(this._buildCommentString(step, ['tagName', 'inputType', 'value', 'parentSelectors'], selector))
      actions.push(this._buildActionString(step, action, selector?.[0], value, { await: true, ending: ';' }))
      return this.wrapSamePageNavigation(step, actions, activePage)
    }
    return actions
  }

  wrapSamePageNavigation(step, actions, activePage = this.context.page) {
    const hasSamePageNavigation = step.assertedEvents?.some(event =>
      event?.type === 'navigation' && event?.isNewTabOrWindow !== true
    )
    if (!hasSamePageNavigation) return actions

    const navigationCounter = this.commonCounter.value++
    actions.unshift(
      `const navigationEvent${navigationCounter} = ${activePage}.waitForNavigation({ waitUntil: 'domcontentloaded' });`
    )
    actions.push(`await navigationEvent${navigationCounter};`)
    const navigation = step.assertedEvents.find(event =>
      event?.type === 'navigation' && event?.isNewTabOrWindow !== true
    )
    if (navigation?.url) actions.push(this.buildFinalNavigationWait(activePage, navigation))
    return actions
  }

  buildFinalNavigationWait(pageName, navigation) {
    if (!navigation?.url) return `await ${pageName}.waitForLoadState('domcontentloaded');`
    return `await ${pageName}.waitForURL(url => url.href === ${toJavaScriptStringLiteral(navigation.url)}, { waitUntil: 'domcontentloaded' });`
  }

  findPrimaryActionIndex(actions, activePage = this.context.page) {
    const actionPrefix = `await ${activePage}.`
    return actions.findIndex(actionLine =>
      typeof actionLine === 'string' &&
      actionLine.startsWith(actionPrefix) &&
      !actionLine.includes('.waitFor')
    )
  }

  replacePrimaryAction(actions, replacement, activePage = this.context.page) {
    const actionIndex = this.findPrimaryActionIndex(actions, activePage)
    if (actionIndex !== -1) actions[actionIndex] = replacement
    return actionIndex
  }

  insertBeforePrimaryAction(actions, insertion, activePage = this.context.page) {
    const actionIndex = this.findPrimaryActionIndex(actions, activePage)
    actions.splice(actionIndex === -1 ? actions.length : actionIndex, 0, insertion)
  }

  resolveClosingPage(step, fallbackPage = this.context.page) {
    const closeEvent = step.assertedEvents?.find(event => event.type === 'windowOrTabClose')
    if (typeof this.context.pageForTabId === 'function') {
      return this.context.pageForTabId(closeEvent?.targetTabId) || fallbackPage
    }
    return fallbackPage
  }

  handleWindowOrTabClose(closingPage = this.context.page, activePage = this.context.page) {
    const closingTabId = typeof this.context.tabIdForPage === 'function'
      ? this.context.tabIdForPage(closingPage)
      : null
    if (typeof this.stack.remove === 'function') this.stack.remove(closingPage)
    else this.stack.pop()
    if (typeof this.context.unregisterPage === 'function') {
      this.context.unregisterPage(closingTabId)
    }
    this.context.page = closingPage === activePage
      ? (this.stack.isEmpty() ? 'page' : this.stack.peek())
      : activePage
  }

  openNewPage(actions, openingPage = this.context.page, targetTabId = null) {
    const pageCounter = this.commonCounter.value++
    const pageName = `tab${pageCounter}`
    actions.push(`const ${pageName} = await ${openingPage}.context().newPage();`)
    this.stack.push(pageName)
    if (typeof this.context.registerPage === 'function') {
      this.context.registerPage(targetTabId, pageName)
    } else {
      this.context.page = pageName
    }
    return pageName
  }

  appendExplicitPageClose(step, actions, closingPage = this.context.page) {
    if (!step.assertedEvents?.some(event => event.type === 'windowOrTabClose')) return actions

    const activePage = this.context.page
    const targetPage = this.resolveClosingPage(step, closingPage)

    if (Number.isFinite(step.closeDelay) && step.closeDelay > 0) {
      actions.push(`await delay(${Math.round(step.closeDelay)})`)
    }
    actions.push(`if (!${targetPage}.isClosed()) {`)
    actions.push(`  await ${targetPage}.close();`)
    actions.push('}')
    this.handleWindowOrTabClose(targetPage, activePage)
    return actions
  }

  wrapTriggeredPageClose(step, actions, triggeringPage = this.context.page) {
    const openedNewPage = step.assertedEvents?.some(event => event.isNewTabOrWindow === true)
    const isLegacyFlow = this.data != null && !(Number(this.data.timingVersion) >= 2)
    if (openedNewPage || step.explicitClose === true || isLegacyFlow) {
      // A later raw tab-close marker describes a user closing the popup; the
      // triggering action cannot reproduce that close event on its own.
      return this.appendExplicitPageClose(step, actions, this.context.page)
    }
    return this.wrapWindowOrTabClose(step, actions, triggeringPage)
  }

  wrapWindowOrTabClose(step, actions, closingPage = this.context.page) {
    if (!step.assertedEvents?.some(event => event.type === 'windowOrTabClose')) return actions

    const activePage = this.context.page
    const targetPage = this.resolveClosingPage(step, closingPage)
    const closeCounter = this.commonCounter.value++
    actions.unshift(`const pageCloseEvent${closeCounter} = ${targetPage}.waitForEvent('close');`)
    actions.push(`await pageCloseEvent${closeCounter};`)
    this.handleWindowOrTabClose(targetPage, activePage)
    return actions
  }

  wrapNewTabOrWindow(step, actions, openingPage = this.context.page) {
    const popupNavigation = step.assertedEvents?.find(event => event.isNewTabOrWindow === true)
    if (!popupNavigation) return actions

    const popupCounter = this.commonCounter.value++
    actions.unshift(`const pageEvent${popupCounter} = ${openingPage}.waitForEvent('popup');`)
    actions.push(`const tab${popupCounter} = await pageEvent${popupCounter};`)
    actions.push(this.buildFinalNavigationWait(`tab${popupCounter}`, popupNavigation))
    this.stack.push(`tab${popupCounter}`)
    if (typeof this.context.registerPage === 'function') {
      this.context.registerPage(popupNavigation.targetTabId, `tab${popupCounter}`)
    } else {
      this.context.page = `tab${popupCounter}`
    }
    return actions
  }
}
