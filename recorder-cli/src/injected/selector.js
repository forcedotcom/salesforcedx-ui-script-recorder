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
const interactiveSelector =
  'a, area[href], audio[controls], button, details, embed, iframe, input, label, object, ' +
  'select, summary, textarea, video[controls], [contenteditable=""], [contenteditable="true" i], ' +
  '[contenteditable="plaintext-only" i], ' +
  '[draggable="true"], [onclick], [tabindex], ' +
  '[role~="button"], [role~="checkbox"], [role~="combobox"], [role~="gridcell"], ' +
  '[role~="link"], [role~="listbox"], [role~="menuitem"], [role~="menuitemcheckbox"], ' +
  '[role~="menuitemradio"], [role~="option"], [role~="radio"], [role~="scrollbar"], ' +
  '[role~="searchbox"], [role~="slider"], [role~="spinbutton"], [role~="switch"], ' +
  '[role~="tab"], [role~="textbox"], [role~="treeitem"]'

function hasUnwantedChars(text) {
  return text.includes(':') || text.includes(';')
}

function isContentEditableTarget(element) {
  if (element?.isContentEditable === true) return true

  const reflectedState = element?.contentEditable
  if (reflectedState === 'true' || reflectedState === 'plaintext-only') return true
  if (typeof reflectedState === 'string') return false

  const attribute = element?.getAttribute?.('contenteditable')
  if (attribute === '') return true
  if (attribute === null || attribute === undefined) return false
  const normalized = attribute.toLowerCase()
  return normalized === 'true' || normalized === 'plaintext-only'
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

  // Component events may be retargeted to a shadow host or framework wrapper.
  // Resolve the first visible element from the event path so recording uses
  // the same concrete element that was under the pointer.
  let element = targetElement || getClickableTargetFromEvent(e)

  if (!element || !(element instanceof Element)) return null

  // Check custom data attribute first
  if (dataAttribute && element.getAttribute(dataAttribute)) {
    cssSelector = `[${dataAttribute}="${element.getAttribute(dataAttribute)}"]`
  } else {
    try {
      const baseFinderOptions = getFinderOptions(dataAttribute)
      cssSelector = finder(element, baseFinderOptions)
      if (element && (!cssSelector || cssSelector?.includes('slot'))) {
        element = getClickableTargetFromEvent(e)
        const opts = { ...baseFinderOptions, slotCheck: true }
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
      element?.tagName !== 'SELECT' &&
      !isContentEditableTarget(element)) {
    textSelector = getTextSelector(element)
    if (!textSelector) {
      textSelector = getTextSelectorFromOptionAncestor(element)
    }
  }

  return finaliseSelectors(cssSelector, ariaSelector, textSelector)
}

function getFinderOptions(dataAttribute) {
  if (!dataAttribute) return finderOptions

  const defaultAttributeFilter = finderOptions.attr
  return {
    ...finderOptions,
    attr: (name, value) =>
      (name === dataAttribute && Boolean(value)) ||
      (typeof defaultAttributeFilter === 'function' && defaultAttributeFilter(name, value))
  }
}

function getTextSelectorFromOptionAncestor(element) {
  const option = closestAcrossShadowRoots(element, '[role~="option"]')
  if (!option) return ''

  const interactive = closestAcrossShadowRoots(element, interactiveSelector)
  if (interactive && interactive !== option) return ''

  if (element !== option) {
    let candidate = parentElementAcrossShadowRoots(element)
    while (candidate) {
      const selector = getTextSelector(candidate)
      if (selector) return selector
      if (candidate === option) break
      candidate = parentElementAcrossShadowRoots(candidate)
    }
  }

  const candidates = []
  let inspected = 0
  for (const candidate of option.querySelectorAll('*')) {
    if (++inspected > 100) break
    if (closestAcrossShadowRoots(candidate, interactiveSelector) !== option) continue
    const text = candidate.textContent?.trim()
    if (!text) continue

    candidates.push({
      element: candidate,
      textLength: text.length,
      depth: getElementDepth(candidate, option)
    })
  }

  candidates.sort((a, b) => b.textLength - a.textLength || b.depth - a.depth)
  for (const { element: candidate } of candidates.slice(0, 1)) {
    const selector = getTextSelector(candidate)
    if (selector) return selector
  }

  return ''
}

function getElementDepth(element, ancestor) {
  let depth = 0
  let current = element

  while (current && current !== ancestor) {
    depth++
    current = current.parentElement
  }

  return depth
}

function closestAcrossShadowRoots(element, selector) {
  let current = element

  while (current instanceof Element) {
    const match = current.closest(selector)
    if (match) return match

    const root = current.getRootNode()
    current = root?.host instanceof Element ? root.host : null
  }

  return null
}

function parentElementAcrossShadowRoots(element) {
  if (element.parentElement) return element.parentElement
  const root = element.getRootNode()
  return root?.host instanceof Element ? root.host : null
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
 * Returns the first visible element in the event's composed path. Events that
 * cross a component boundary can expose a retargeted host through event.target,
 * while composedPath() still identifies the concrete element under the pointer.
 * Falls back to the target/ancestor walk for events without an available path.
 */
export function getClickableTargetFromEvent(event) {
  if (!event) return event?.target

  if (typeof event.composedPath === 'function') {
    const path = event.composedPath()
    for (const element of path) {
      if (!(element instanceof Element)) continue
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return element
    }
  }

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
