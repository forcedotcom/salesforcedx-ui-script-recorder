/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

// Ported from @fpsx/ui-recorder-utils/src/injected/selectors/TextSelector.ts
// Copyright 2023 The Chromium Authors. All rights reserved.

import { createTextContent, isSuitableNodeForTextMatching } from '../puppeteer/TextContent.js'
import { textQuerySelectorAll } from '../puppeteer/TextQuerySelector.js'

const MINIMUM_TEXT_LENGTH = 12
const MAXIMUM_TEXT_LENGTH = 64

const collect = (iter, max = Infinity) => {
  const results = []
  for (const value of iter) {
    if (max <= 0) break
    results.push(value)
    --max
  }
  return results
}

/**
 * Computes the text selector for a node.
 * Handles text content across shadow DOM boundaries.
 */
export const computeTextSelector = (node) => {
  const content = createTextContent(node).full.trim()
  if (!content) return

  // If it's short, just return it.
  if (content.length <= MINIMUM_TEXT_LENGTH) {
    const elements = collect(textQuerySelectorAll(document, content), 2)
    if (elements.length !== 1 || elements[0] !== node) return
    return [content]
  }

  // If it's too long, it's probably irrelevant.
  if (content.length > MAXIMUM_TEXT_LENGTH) return

  // Binary search for the optimal length of a unique substring.
  let left = MINIMUM_TEXT_LENGTH
  let right = content.length
  while (left <= right) {
    const center = left + ((right - left) >> 2)
    const elements = collect(textQuerySelectorAll(document, content.slice(0, center)), 2)
    if (elements.length !== 1 || elements[0] !== node) {
      left = center + 1
    } else {
      right = center - 1
    }
  }

  // Never matched.
  if (right === content.length) return

  // Attempt to round the word.
  const length = right + 1
  const remainder = content.slice(length, length + MAXIMUM_TEXT_LENGTH)
  return [content.slice(0, length + remainder.search(/ |$/))]
}
