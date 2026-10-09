/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { BaseAction } from './BaseAction.js'
import { toJavaScriptStringLiteral } from './JavaScriptLiteral.js'

export function preferScopedTextForFragileListClick(step) {
  if (step.type !== 'click' || step.params?.parameterise || step.componentType !== 'list') {
    return step
  }

  const primarySelector = step.selectors?.find(selector => selector?.[0])?.[0]
  const searchResultSelectors = [[primarySelector], ...(step.parentSelectors || [])]
    .flat()
    .filter(Boolean)
  const isPositionalSelector = primarySelector?.includes(':nth-child(')
  const isSearchResultsList = searchResultSelectors.some(selector =>
    /aria-label\s*=\s*["']Search Results["']/i.test(selector) ||
    /^aria\/Search Results(?:\[|$)/i.test(selector)
  )
  if (!isPositionalSelector && !isSearchResultsList) return step

  const textSelector = step.selectors
    ?.find(selector => selector?.[0]?.startsWith('text/'))?.[0]
  const text = textSelector?.slice('text/'.length)
  if (!text || /[\u0000-\u001F\u007F\u2028\u2029]/u.test(text)) return step

  const parentSelector = step.parentSelectors
    ?.find(selector => isCssSelector(selector?.[0]))?.[0]
  if (!parentSelector) return step

  // Recorder text selectors use the Puppeteer `text/` dialect, which
  // Playwright cannot execute directly. Scope Playwright's text engine to
  // the recorded list so the option remains stable when its row moves.
  const scopedTextSelector = `${parentSelector} >> :text(${JSON.stringify(text)})`

  return {
    ...step,
    selectors: [[scopedTextSelector], ...step.selectors]
  }
}

function isCssSelector(selector) {
  return Boolean(selector) && !/^(aria|css|pierce|text|xpath)\//.test(selector)
}

export class ClickAction extends BaseAction {
  static nthSelectorCounters = {
    listCounter: 1,
    tableCounter: 1
  }

  handle(step) {
    const triggeringPage = this.context.page
    const replayStep = preferScopedTextForFragileListClick(step)
    const actions = this.handleNewTabOrWindow(replayStep, 'click')

    if (step.params?.parameterise) {
      const childIndex = typeof step.params.childIndex === 'number' && !isNaN(step.params.childIndex) ? step.params.childIndex : null
      const componentAction = this._handleComponentAction(step, childIndex, triggeringPage)
      if (componentAction) {
        this.replacePrimaryAction(actions, componentAction, triggeringPage)
      }
    }

    return this.wrapTriggeredPageClose(step, actions, triggeringPage)
  }

  _handleComponentAction(step, childIndex, activePage = this.context.page) {
    let childSelector
    if (step.componentType === 'table') {
      childSelector = `${step.parentSelectors?.[0]?.[0]} tr th a`
      return this._generateSelectorAction('tableCounter', childSelector, childIndex, activePage)
    } else if (step.componentType === 'list') {
      childSelector = `${step.parentSelectors?.[0]?.[0]} li a`
      return this._generateSelectorAction('listCounter', childSelector, childIndex, activePage)
    }
    return null
  }

  _generateSelectorAction(counterKey, childSelector, childIndex, activePage = this.context.page) {
    const counter = ClickAction.nthSelectorCounters[counterKey]
    const varName = counterKey.replace('Counter', 'Selector')

    const selector = `
const ${varName}${counter} = await ${activePage}.locator(${toJavaScriptStringLiteral(childSelector)}).nth(${childIndex ?? 0})
await ${varName}${counter}.click()
`
    ClickAction.nthSelectorCounters[counterKey] += 1
    return selector
  }
}
