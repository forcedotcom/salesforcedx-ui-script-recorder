/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

// Ported from @fpsx/ui-recorder-utils/src/injected/SelectorComputer.ts
// Copyright 2023 The Chromium Authors. All rights reserved.

import { computeARIASelector } from './selectors/ARIASelector.js'
import { computeCSSSelector } from './selectors/CSSSelector.js'
import { computePierceSelector } from './selectors/PierceSelector.js'
import { computeTextSelector } from './selectors/TextSelector.js'
import { computeXPath } from './selectors/XPath.js'

const prefixSelector = (selector, prefix) => {
  if (selector === undefined) return
  if (typeof selector === 'string') return `${prefix}/${selector}`
  return selector.map(s => `${prefix}/${s}`)
}

export class SelectorComputer {
  #customAttributes = ['data-recordid', 'data-id', 'data-label']
  #bindings
  #logger
  #nodes = new WeakMap()
  #nextNodeId = 1
  #selectorFunctionsInOrder

  constructor(bindings, logger, customAttribute = '', selectorTypesToRecord) {
    this.#bindings = bindings
    this.#logger = logger

    let selectorOrder = ['aria', 'css', 'xpath', 'pierce', 'text']
    if (customAttribute) {
      this.#customAttributes.unshift(customAttribute)
      selectorOrder = ['css', 'xpath', 'pierce', 'aria', 'text']
    }

    this.#selectorFunctionsInOrder = selectorOrder
      .filter(type => {
        if (selectorTypesToRecord) return selectorTypesToRecord.includes(type)
        return true
      })
      .map(selectorType => {
        switch (selectorType) {
          case 'css': return this.getCSSSelector.bind(this)
          case 'xpath': return this.getXPathSelector.bind(this)
          case 'pierce': return this.getPierceSelector.bind(this)
          case 'aria': return this.getARIASelector.bind(this)
          case 'text': return this.getTextSelector.bind(this)
          default: throw new Error('Unknown selector type: ' + selectorType)
        }
      })
  }

  #getOrInsertNode(node) {
    let id = this.#nodes.get(node)
    if (id !== undefined) return id
    id = this.#nextNodeId++
    this.#nodes.set(node, id)
    return id
  }

  getSelectors(node) {
    const selectors = []
    for (const getSelector of this.#selectorFunctionsInOrder) {
      const selector = getSelector(node)
      if (selector) selectors.push(selector)
    }
    return selectors
  }

  getCSSSelector(node) {
    return this.#logger.timed(`getCSSSelector: ${this.#getOrInsertNode(node)} ${node.nodeName}`, () => {
      return computeCSSSelector(node, this.#customAttributes)
    })
  }

  getTextSelector(node) {
    return this.#logger.timed(`getTextSelector: ${this.#getOrInsertNode(node)} ${node.nodeName}`, () => {
      return prefixSelector(computeTextSelector(node), 'text')
    })
  }

  getXPathSelector(node) {
    return this.#logger.timed(`getXPathSelector: ${this.#getOrInsertNode(node)} ${node.nodeName}`, () => {
      return prefixSelector(computeXPath(node, true, this.#customAttributes), 'xpath')
    })
  }

  getPierceSelector(node) {
    return this.#logger.timed(`getPierceSelector: ${this.#getOrInsertNode(node)} ${node.nodeName}`, () => {
      return prefixSelector(computePierceSelector(node, this.#customAttributes), 'pierce')
    })
  }

  getARIASelector(node) {
    return this.#logger.timed(`getARIASelector: ${this.#getOrInsertNode(node)} ${node.nodeName}`, () => {
      return prefixSelector(computeARIASelector(node, this.#bindings), 'aria')
    })
  }
}
