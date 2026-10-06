/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import { BaseAction } from './BaseAction.js'

export function preferScopedTextForFragileListClick(step) {
  if (step.type !== 'click' || step.params?.parameterise || step.componentType !== 'list') {
    return step
  }

  const primarySelector = step.selectors?.find(selector => selector?.[0])?.[0]
  if (!primarySelector?.includes(':nth-child(')) return step

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
  const escapedSelector = escapeSingleQuotedJavaScript(scopedTextSelector)

  return {
    ...step,
    selectors: [[escapedSelector], ...step.selectors]
  }
}

function isCssSelector(selector) {
  return Boolean(selector) && !/^(aria|css|pierce|text|xpath)\//.test(selector)
}

function escapeSingleQuotedJavaScript(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export class ClickAction extends BaseAction {
  static nthSelectorCounters = {
    listCounter: 1,
    tableCounter: 1
  }

  handle(step) {
    const replayStep = preferScopedTextForFragileListClick(step)
    const actions = this.handleNewTabOrWindow(replayStep, 'click')

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
