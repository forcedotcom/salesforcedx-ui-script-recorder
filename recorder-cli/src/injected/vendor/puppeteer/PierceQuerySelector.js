/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * @license
 * Copyright 2022 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @internal
 */
export const pierceQuerySelector = (root, selector) => {
    let found = null;
    const search = (root) => {
        const iter = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        do {
            const currentNode = iter.currentNode;
            if (currentNode.shadowRoot) {
                search(currentNode.shadowRoot);
            }
            if (currentNode instanceof ShadowRoot) {
                continue;
            }
            if (currentNode !== root && !found && currentNode.matches(selector)) {
                found = currentNode;
            }
        } while (!found && iter.nextNode());
    };
    if (root instanceof Document) {
        root = root.documentElement;
    }
    search(root);
    return found;
};
/**
 * @internal
 */
export const pierceQuerySelectorAll = (element, selector) => {
    const result = [];
    const collect = (root) => {
        const iter = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        do {
            const currentNode = iter.currentNode;
            if (currentNode.shadowRoot) {
                collect(currentNode.shadowRoot);
            }
            if (currentNode instanceof ShadowRoot) {
                continue;
            }
            if (currentNode !== root && currentNode.matches(selector)) {
                result.push(currentNode);
            }
        } while (iter.nextNode());
    };
    if (element instanceof Document) {
        element = element.documentElement;
    }
    collect(element);
    return result;
};
//# sourceMappingURL=PierceQuerySelector.js.map