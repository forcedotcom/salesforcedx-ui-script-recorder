/**
 * CSS Selector Finder - generates unique CSS selectors for DOM elements.
 * Ported from fpsx-ui-recorder/src/services/finder.js
 *
 * Enhanced to traverse shadow DOM boundaries. parentElement returns null at
 * shadow root boundaries. This version crosses those boundaries using
 * getRootNode().host, generating selectors that include the path through
 * shadow hosts.
 *
 * Runs in a CDP ISOLATED world — same behavior as Chrome extension content
 * scripts. DOM APIs are unpatched, event.target is the real deep target.
 */
import { dataAttributes, otherAttributes } from './selector.js'
import { OVERLAY_ID } from './constants.js'

const notAllowedSldsClasses = new Set([
  'slds-is-active', 'slds-has-focus', 'highlighted', 'slds-is-selected'
])

const attributeEvaluator = (name, value) =>
  (dataAttributes.has(name) && value && !hasUnwantedChars(value) && hasAtleastOneStringChar(value)) ||
  (otherAttributes.has(name) && checkForStringAndSpace(value))

export const finderOptions = {
  seedMinLength: 5,
  optimizedMinLength: 3,
  attr: attributeEvaluator,
  idName: name => OVERLAY_ID === name,
  className: name => !notAllowedSldsClasses.has(name),
  threshold: 1000,
  maxNumberOfTries: 10000,
  timeoutMs: 1000,
  slotCheck: false,
}

function hasUnwantedChars(text) {
  return text.includes(':') || text.includes(';')
}

function checkForStringAndSpace(text) {
  return /^[A-Za-z ()\-_[\]]+$/.test(text)
}

function hasAtleastOneStringChar(text) {
  return /.*[^\d].*/.test(text)
}

let config
let rootDocument
let start

export function finder(input, options) {
  start = new Date()

  if (input.nodeType !== Node.ELEMENT_NODE) {
    throw new Error(`Can't generate CSS selector for non-element node type.`)
  }

  if ('html' === input.tagName.toLowerCase()) {
    return 'html'
  }

  const defaults = {
    root: document.body,
    idName: (name) => true,
    className: (name) => true,
    tagName: (name) => true,
    attr: (name, value) => false,
    seedMinLength: 1,
    optimizedMinLength: 2,
    threshold: 1000,
    maxNumberOfTries: 10000,
    timeoutMs: 1000,
    slotCheck: false,
  }

  config = { ...defaults, ...options }

  // Determine the root for querying - if the element is in a shadow DOM,
  // we need to work within its root node for uniqueness checking.
  // But we also build a full path that crosses shadow boundaries.
  const elementRoot = input.getRootNode()

  // If the element is in a shadow root, we generate a compound selector
  // that pierces through each shadow boundary.
  if (elementRoot instanceof ShadowRoot) {
    return findShadowPiercingSelector(input, config)
  }

  // Normal case: element is in the light DOM (document)
  rootDocument = findRootDocument(config.root, defaults)

  let path = bottomUpSearch(input, 'all',
    () => bottomUpSearch(input, 'two',
      () => bottomUpSearch(input, 'one',
        () => bottomUpSearch(input, 'none', config.slotCheck),
        config.slotCheck),
      config.slotCheck),
    config.slotCheck)

  if (path) {
    const optimized = sort(optimize(path, input))
    if (optimized.length > 0) {
      path = optimized[0]
    }
    return selectorFromPath(path)
  } else {
    throw new Error(`Selector was not found.`)
  }
}

/**
 * Generates a selector that pierces shadow DOM boundaries.
 * Builds a selector for the element within its shadow root,
 * then walks up through each shadow host, building a combined selector.
 *
 * Result looks like: "nav[aria-label=\"Global\"] one-app-nav-bar-item-root[data-id=\"Contact\"] span.slds-truncate"
 */
function findShadowPiercingSelector(element, cfg) {
  const parts = []
  let current = element

  while (current) {
    const currentRoot = current.getRootNode()

    // Set rootDocument to the current root for uniqueness checks
    if (currentRoot instanceof ShadowRoot) {
      rootDocument = currentRoot
    } else {
      rootDocument = currentRoot
    }

    // Find a selector for `current` within its root
    const localSelector = findLocalSelector(current, cfg)
    if (localSelector) {
      parts.unshift(localSelector)
    } else {
      // Fallback: just use tag name
      parts.unshift(current.tagName.toLowerCase())
    }

    // Move to the shadow host (cross the shadow boundary)
    if (currentRoot instanceof ShadowRoot) {
      current = currentRoot.host
    } else {
      // We've reached the document - done
      current = null
    }
  }

  return parts.join(' ')
}

/**
 * Find a local selector for an element within its own root (shadow root or document).
 */
function findLocalSelector(element, cfg) {
  const root = element.getRootNode()
  rootDocument = root

  // Try to find a short unique selector within the local root
  let path = bottomUpSearch(element, 'all',
    () => bottomUpSearch(element, 'two',
      () => bottomUpSearch(element, 'one',
        () => bottomUpSearch(element, 'none', cfg.slotCheck),
        cfg.slotCheck),
      cfg.slotCheck),
    cfg.slotCheck)

  if (path) {
    const optimized = sort(optimize(path, element))
    if (optimized.length > 0) {
      path = optimized[0]
    }
    return selectorFromPath(path)
  }

  return null
}

function findRootDocument(rootNode, defaults) {
  if (rootNode.nodeType === Node.DOCUMENT_NODE) {
    return rootNode
  }
  if (rootNode === defaults.root) {
    return rootNode.ownerDocument
  }
  return rootNode
}

function bottomUpSearch(input, limit, fallback, slotCheck) {
  let path = null
  let stack = []
  let current = input
  let i = 0

  // Determine the stopping point - don't cross shadow root boundaries here
  const stopRoot = input.getRootNode()

  while (current) {
    // Stop at the shadow root host or document body
    if (current === stopRoot) break
    if (stopRoot instanceof ShadowRoot && current === stopRoot.host) break
    if (stopRoot === document && (current === document.body || current === document.documentElement)) {
      // Include body/html in traversal but stop after
      const rect = current.getBoundingClientRect()
      if (slotCheck && rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0) {
        current = current.parentElement
        i++
        continue
      }

      let level = maybe(id(current)) ||
        maybe(...attr(current)) ||
        maybe(...classNames(current)) ||
        maybe(tagName(current)) || [any()]

      for (let node of level) { node.level = i }
      stack.push(level)
      break
    }

    const rect = current.getBoundingClientRect()
    if (slotCheck && rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0 && rect.right === 0 && rect.bottom === 0) {
      current = current.parentElement
      i++
      continue
    }

    const elapsedTime = new Date().getTime() - start.getTime()
    if (config.timeoutMs !== undefined && elapsedTime > config.timeoutMs) {
      throw new Error(`Timeout: Can't find a unique selector after ${elapsedTime}ms`)
    }

    let level = maybe(id(current)) ||
      maybe(...attr(current)) ||
      maybe(...classNames(current)) ||
      maybe(tagName(current)) || [any()]

    const nth = index(current)

    if (limit === 'all') {
      if (nth) {
        level = level.concat(level.filter(dispensableNth).map((node) => nthChild(node, nth)))
      }
    } else if (limit === 'two') {
      level = level.slice(0, 1)
      if (nth) {
        level = level.concat(level.filter(dispensableNth).map((node) => nthChild(node, nth)))
      }
    } else if (limit === 'one') {
      const [node] = (level = level.slice(0, 1))
      if (nth && dispensableNth(node)) {
        level = [nthChild(node, nth)]
      }
    } else if (limit === 'none') {
      level = [any()]
      if (nth) {
        level = [nthChild(level[0], nth)]
      }
    }

    for (let node of level) {
      node.level = i
    }

    stack.push(level)

    if (stack.length >= config.seedMinLength) {
      path = findUniquePath(stack, fallback)
      if (path) break
    }

    current = current.parentElement
    i++
  }

  if (!path) {
    path = findUniquePath(stack, fallback)
  }

  if (!path && fallback) {
    return fallback()
  }

  return path
}

function findUniquePath(stack, fallback) {
  const paths = sort(combinations(stack))
  if (paths.length > config.threshold) {
    return fallback ? fallback() : null
  }
  for (let candidate of paths) {
    if (unique(candidate)) {
      return candidate
    }
  }
  return null
}

function selectorFromPath(path) {
  let node = path[0]
  let query = node.name
  for (let i = 1; i < path.length; i++) {
    const level = path[i].level || 0
    if (node.level === level - 1) {
      query = `${path[i].name} > ${query}`
    } else {
      query = `${path[i].name} ${query}`
    }
    node = path[i]
  }
  return query
}

function penalty(path) {
  return path.map((node) => node.penalty).reduce((acc, i) => acc + i, 0)
}

function unique(path) {
  const css = selectorFromPath(path)
  try {
    const matches = rootDocument.querySelectorAll(css)
    switch (matches.length) {
      case 0:
        throw new Error(`Can't select any node with this selector: ${css}`)
      case 1:
        return true
      default:
        return false
    }
  } catch (e) {
    // Invalid selector
    return false
  }
}

function id(input) {
  const elementId = input.getAttribute('id')
  if (elementId && config.idName(elementId)) {
    return {
      name: '#' + elementId,
      penalty: 0,
    }
  }
  return null
}

function attr(input) {
  const attrs = Array.from(input.attributes).filter((a) => config.attr(a.name, a.value))
  return attrs.map((a) => ({
    name: `${input.nodeName.toLowerCase()}[${a.name}="${a.value}"]`,
    penalty: dataAttributes.has(a.name) ? 0.5 : 0.75,
  }))
}

function classNames(input) {
  const names = Array.from(input.classList).filter(config.className)
  return names.map((name) => ({
    name: `${input.nodeName.toLowerCase()}` + '.' + name,
    penalty: 1,
  }))
}

function tagName(input) {
  const name = input.tagName.toLowerCase()
  if (config.tagName(name)) {
    return { name, penalty: 2 }
  }
  return null
}

function any() {
  return { name: '*', penalty: 3 }
}

function index(input) {
  const parent = input.parentNode
  if (!parent) return null
  let child = parent.firstChild
  if (!child) return null
  let i = 0
  while (child) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      i++
    }
    if (child === input) break
    child = child.nextSibling
  }
  return i
}

function nthChild(node, i) {
  return {
    name: node.name + `:nth-child(${i})`,
    penalty: node.penalty + 1,
  }
}

function dispensableNth(node) {
  return node.name !== 'html' && !node.name.startsWith('#')
}

function maybe(...level) {
  const list = level.filter(notEmpty)
  if (list.length > 0) return list
  return null
}

function notEmpty(value) {
  return value !== null && value !== undefined
}

function* combinations(stack, path = []) {
  if (stack.length > 0) {
    for (let node of stack[0]) {
      yield* combinations(stack.slice(1, stack.length), path.concat(node))
    }
  } else {
    yield path
  }
}

function sort(paths) {
  return [...paths].sort((a, b) => penalty(a) - penalty(b))
}

function* optimize(path, input, scope = { counter: 0, visited: new Map() }) {
  if (path.length > 2 && path.length > config.optimizedMinLength) {
    for (let i = 1; i < path.length - 1; i++) {
      if (scope.counter > config.maxNumberOfTries) return
      scope.counter += 1
      const newPath = [...path]
      newPath.splice(i, 1)
      const newPathKey = selectorFromPath(newPath)
      if (scope.visited.has(newPathKey)) return
      if (unique(newPath) && same(newPath, input)) {
        yield newPath
        scope.visited.set(newPathKey, true)
        yield* optimize(newPath, input, scope)
      }
    }
  }
}

function same(path, input) {
  return rootDocument.querySelector(selectorFromPath(path)) === input
}
