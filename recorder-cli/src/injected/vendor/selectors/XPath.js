/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

// Ported from @fpsx/ui-recorder-utils/src/injected/selectors/XPath.ts
// Copyright 2023 The Chromium Authors. All rights reserved.

const getSelectorPart = (node, attributes = []) => {
  if (!(node instanceof Element)) return

  // Declared attributes have the greatest priority.
  for (const attribute of attributes) {
    const value = node.getAttribute(attribute)
    if (value) {
      return `//*[@${attribute}='${value}']`
    }
  }

  let selector = node.localName

  const parent = node.parentNode
  if (!parent) return `//${selector}`

  const children = parent.children
  let index = 0
  let sameTagCount = 0
  for (const child of children) {
    if (child.tagName === node.tagName) sameTagCount++
    if (child === node) { index = sameTagCount; break }
  }

  if (sameTagCount > 1) {
    selector += `[${index}]`
  }

  return selector
}

/**
 * Computes the XPath selector for a node.
 * Handles shadow DOM boundaries.
 */
export const computeXPath = (node, optimized = true, attributes = []) => {
  if (!(node instanceof Element)) return undefined

  const parts = []
  let current = node

  while (current && current !== document.documentElement) {
    const part = getSelectorPart(current, attributes)
    if (!part) break

    parts.unshift(part)

    // If we found a unique attribute selector, we can stop
    if (part.startsWith('//*[@')) break

    current = current.parentNode
    if (current instanceof ShadowRoot) {
      // Cross shadow boundary
      current = current.host
    }
  }

  if (parts.length === 0) return undefined

  // If first part is an absolute xpath, return as-is
  if (parts[0].startsWith('//')) {
    return [parts.join('/')]
  }

  return ['//' + parts.join('/')]
}
