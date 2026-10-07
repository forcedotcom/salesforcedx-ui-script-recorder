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

    if (step.assertedEvents?.some(event => event.isNewTabOrWindow)) {
      actions.push(`const pageEvent${this.commonCounter.value} = ${this.context.page}.waitForEvent('popup');`)
      actions.push(this._buildCommentString(step, ['tagName', 'inputType', 'value', 'parentSelectors'], selector))
      actions.push(this._buildActionString(step, action, selector?.[0], value, { await: true, ending: ';' }))
      actions.push(`const tab${this.commonCounter.value} = await pageEvent${this.commonCounter.value};`)
      this.stack.push(`tab${this.commonCounter.value}`)
      this.context.page = `tab${this.commonCounter.value}`
      this.commonCounter.value++
    } else {
      const navigationEvent = step.assertedEvents?.find(event => event.type === 'navigation')
      actions.push(this._buildCommentString(step, ['tagName', 'inputType', 'value', 'parentSelectors'], selector))
      actions.push(this._buildActionString(step, action, selector?.[0], value, { await: true, ending: ';' }))
      if (navigationEvent) {
        actions.push(`await ${this.context.page}.waitForLoadState('domcontentloaded')`)
      }
    }
    return actions
  }

  handleWindowOrTabClose() {
    this.stack.pop()
    this.context.page = this.stack.isEmpty() ? 'page' : this.stack.peek()
  }
}
