/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * Selector generation service.
 * Ported from fpsx-ui-recorder/src/services/selector.js
 *
 * Uses @fpsx/ui-recorder-utils SelectorComputer for shadow DOM-aware selectors.
 */
import { finder, finderOptions } from './finder.js'
import { SelectorComputer } from './vendor/SelectorComputer.js'
import { Logger } from './vendor/Logger.js'
import { OVERLAY_ID } from './constants.js'

export const dataAttributes = new Set([
  'data-recordid', 'data-id', 'data-label', 'data-tab-name', 'data-product-id',
  'data-testid', 'data-test-id', 'data-cy'
])

export const otherAttributes = new Set(['name', 'title', 'type', 'aria-label'])

const notAllowedSldsClasses = new Set(['slds-is-active', 'slds-has-focus', 'highlighted', 'slds-is-selected'])
const selectorTypesToRecord = [
  /*'aria',*/
  'text'
]

const stringOnlyRegex = /^[A-Za-z ()\-_[\]]+$/
const nonNumberOnlyRegex = /.*[^\d].*/

function hasUnwantedChars(text) {
  return text.includes(':') || text.includes(';')
}

function checkForStringAndSpace(text) {
  return stringOnlyRegex.test(text)
}

function hasAtleastOneStringChar(text) {
  return nonNumberOnlyRegex.test(text)
}

/**
 * Lightweight accessibility bindings for the SelectorComputer.
 * These replicate what Chrome DevTools provides for ARIA computation.
 */
const accessibilityBindings = {
  getAccessibleName(node) {
    if (!(node instanceof Element)) return ''

    // aria-label takes priority
    const ariaLabel = node.getAttribute('aria-label')
    if (ariaLabel) return ariaLabel.trim()

    // aria-labelledby
    const labelledBy = node.getAttribute('aria-labelledby')
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy)
      if (labelEl) return labelEl.textContent?.trim() || ''
    }

    // For inputs, check associated label
    if (node.id && (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.tagName === 'SELECT')) {
      const label = document.querySelector(`label[for="${node.id}"]`)
      if (label) return label.textContent?.trim() || ''
    }

    // title attribute
    const title = node.getAttribute('title')
    if (title) return title.trim()

    // For buttons/links, use text content
    const role = node.getAttribute('role') || getImplicitRole(node)
    if (role === 'button' || role === 'link' || role === 'tab' || role === 'menuitem') {
      const text = node.textContent?.trim()
      if (text && text.length < 100) return text
    }

    return ''
  },

  getAccessibleRole(node) {
    if (!(node instanceof Element)) return ''
    const explicitRole = node.getAttribute('role')
    if (explicitRole) return explicitRole
    return getImplicitRole(node) || ''
  }
}

function getImplicitRole(element) {
  if (!(element instanceof Element)) return ''
  const tag = element.tagName.toLowerCase()
  const roleMap = {
    a: element.hasAttribute('href') ? 'link' : '',
    button: 'button',
    input: getInputRole(element),
    select: 'combobox',
    textarea: 'textbox',
    img: 'img',
    nav: 'navigation',
    main: 'main',
    header: 'banner',
    footer: 'contentinfo',
    aside: 'complementary',
    form: 'form',
    table: 'table',
    ul: 'list',
    ol: 'list',
    li: 'listitem',
    h1: 'heading', h2: 'heading', h3: 'heading',
    h4: 'heading', h5: 'heading', h6: 'heading',
  }
  return roleMap[tag] || ''
}

function getInputRole(element) {
  const type = element.type || 'text'
  const inputRoles = {
    checkbox: 'checkbox',
    radio: 'radio',
    range: 'slider',
    search: 'searchbox',
    text: 'textbox',
    email: 'textbox',
    tel: 'textbox',
    url: 'textbox',
    number: 'spinbutton',
  }
  return inputRoles[type] || 'textbox'
}

export function getSelector(e, { dataAttribute } = {}, targetElement) {
  let cssSelector, ariaSelector, textSelector = ''

  // In the ISOLATED world, event.target is already the deep target element
  // (no retargeting across open shadow DOM boundaries).
  let element = targetElement || e?.target

  if (!element || !(element instanceof Element)) return null

  // Check custom data attribute first
  if (dataAttribute && element.getAttribute(dataAttribute)) {
    cssSelector = `[${dataAttribute}="${element.getAttribute(dataAttribute)}"]`
  } else {
    try {
      cssSelector = finder(element, finderOptions)
      if (element && (!cssSelector || cssSelector?.includes('slot'))) {
        element = getClickableTargetFromEvent(e)
        const opts = { ...finderOptions, slotCheck: true }
        cssSelector = finder(element, opts)
      }
    } catch (err) {
      // If finder fails, fall back to a basic selector
      cssSelector = buildFallbackSelector(element)
    }
  }

  if (cssSelector?.includes('#' + OVERLAY_ID)) {
    return null
  }

  // Use SelectorComputer for ARIA selector (shadow DOM aware)
  ariaSelector = getAriaSelector(element)

  // Use SelectorComputer for text selector (shadow DOM aware)
  if (element?.type !== 'password' &&
      element?.tagName !== 'INPUT' &&
      element?.tagName !== 'TEXTAREA' &&
      element?.tagName !== 'SELECT') {
    textSelector = getTextSelector(element)
  }

  return finaliseSelectors(cssSelector, ariaSelector, textSelector)
}

function finaliseSelectors(cssSelector, ariaSelector, textSelector) {
  const evaluatedSelectors = []
  if (cssSelector) {
    evaluatedSelectors.push([cssSelector])
  }
  if (ariaSelector) {
    evaluatedSelectors.push([ariaSelector])
  }
  if (textSelector) {
    evaluatedSelectors.push([textSelector])
  }
  return evaluatedSelectors.length > 0 ? evaluatedSelectors : null
}

/**
 * Uses SelectorComputer ARIA selector (traverses shadow DOM).
 */
function getAriaSelector(element) {
  if (!element) return ''

  const role = accessibilityBindings.getAccessibleRole(element)
  const name = accessibilityBindings.getAccessibleName(element)
  const trimmedName = name?.replace('required', '')?.trim()
  if (!trimmedName) return ''

  let ariaSelector = `aria/${trimmedName}`
  if (role) {
    ariaSelector += `[role="${role}"]`
  }
  return ariaSelector
}

/**
 * Uses SelectorComputer for text selector (shadow DOM aware).
 */
function getTextSelector(element) {
  const logger = new Logger('error')
  const selectorComputer = new SelectorComputer(accessibilityBindings, logger, '', selectorTypesToRecord)
  const selectors = selectorComputer.getSelectors(element)
  return selectors?.[0]?.[0]
}

/**
 * Fallback selector builder when finder fails.
 */
function buildFallbackSelector(element) {
  if (!element) return null
  if (element.id) return `#${element.id}`

  const tag = element.tagName.toLowerCase()

  for (const attr of dataAttributes) {
    const val = element.getAttribute(attr)
    if (val && !hasUnwantedChars(val) && hasAtleastOneStringChar(val)) {
      return `${tag}[${attr}="${val}"]`
    }
  }

  for (const attr of otherAttributes) {
    const val = element.getAttribute(attr)
    if (val && checkForStringAndSpace(val)) {
      return `${tag}[${attr}="${val}"]`
    }
  }

  if (element.className && typeof element.className === 'string') {
    const classes = element.className.trim().split(/\s+/).filter(c => !notAllowedSldsClasses.has(c)).slice(0, 2).join('.')
    if (classes) return `${tag}.${classes}`
  }

  return tag
}

/**
 * Returns the element that emitted the event (first element with dimensions).
 * In the ISOLATED world, event.target is already the leaf element, so this
 * just walks up from target to find the first ancestor with visible dimensions.
 */
export function getClickableTargetFromEvent(event) {
  if (!event) return event?.target

  let element = event.target
  while (element && element instanceof Element) {
    const rect = element.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return element
    element = element.parentElement
  }
  return event.target
}

export function getMouseEventOffsets(event, target) {
  if (!target) return { offsetX: 0, offsetY: 0 }
  const rect = target.getBoundingClientRect()
  return { offsetX: event.clientX - rect.x, offsetY: event.clientY - rect.y }
}
