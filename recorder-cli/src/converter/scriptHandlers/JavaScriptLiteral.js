/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * Serialize untrusted text as a single-quoted JavaScript string literal.
 * JSON.stringify supplies complete control-character, slash, and surrogate
 * escaping; the final replacements preserve the converter's existing quote
 * style while keeping JavaScript line separators portable.
 */
export function toJavaScriptStringLiteral(value) {
  const body = JSON.stringify(String(value))
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/'/g, "\\'")
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

  return `'${body}'`
}
