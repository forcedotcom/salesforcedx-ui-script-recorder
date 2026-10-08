/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

export class BrowserContext {
  constructor() {
    this.page = 'page'
    this.activeTabId = null
    this.pagesByTabId = new Map()
  }

  activatePage(tabId) {
    if (tabId == null) return this.page

    if (this.pagesByTabId.has(tabId)) {
      this.page = this.pagesByTabId.get(tabId)
    } else if (this.pagesByTabId.size === 0) {
      // The first recorded tab is the Playwright fixture page.
      this.pagesByTabId.set(tabId, 'page')
      this.page = 'page'
    }
    this.activeTabId = tabId
    return this.page
  }

  registerPage(tabId, pageName) {
    if (tabId != null) this.pagesByTabId.set(tabId, pageName)
    this.activeTabId = tabId ?? this.activeTabId
    this.page = pageName
  }

  unregisterPage(tabId) {
    if (tabId != null) this.pagesByTabId.delete(tabId)
    if (this.activeTabId === tabId) this.activeTabId = null
  }

  pageForTabId(tabId) {
    return tabId == null ? null : (this.pagesByTabId.get(tabId) ?? null)
  }

  tabIdForPage(pageName) {
    for (const [tabId, mappedPage] of this.pagesByTabId) {
      if (mappedPage === pageName) return tabId
    }
    return null
  }
}
