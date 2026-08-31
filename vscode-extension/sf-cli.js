/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * Thin wrapper around the Salesforce CLI (`sf`) for the VS Code extension's
 * org picker. Mirrors recorder-cli/src/sf-cli.js, but as CommonJS (the
 * extension isn't an ES module) and without getFrontdoorUrl/sanitizeFrontdoor
 * — the extension only ever needs the list of connected orgs to populate a
 * QuickPick. The recorder CLI/generated spec resolve the actual frontdoor
 * URL (a live session token) themselves, in their own process — it never
 * passes through the extension.
 */

const { execFile } = require('child_process');
const { getExtendedPath } = require('./resolve-node');

const SF_NOT_FOUND_MESSAGE =
  'Salesforce CLI ("sf") not found on PATH. Install it from https://developer.salesforce.com/tools/salesforcecli ' +
  'and run "sf org login web" to authenticate an org, then try again.';

/**
 * List orgs the Salesforce CLI is currently authenticated to.
 * @returns {Promise<Array<{ username: string, alias: string|null, instanceUrl: string, isScratch: boolean, isSandbox: boolean }>>}
 */
function listSalesforceCliOrgs() {
  return new Promise((resolve, reject) => {
    execFile(
      'sf',
      ['org', 'list', '--json'],
      { maxBuffer: 10 * 1024 * 1024, env: { ...process.env, PATH: getExtendedPath() } },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          reject(new Error(SF_NOT_FOUND_MESSAGE));
          return;
        }

        const parsed = extractJson(stdout);
        if (!parsed) {
          reject(new Error(
            `Failed to parse "sf org list --json" output: ${(err && err.message) || stderr || 'no JSON found'}`
          ));
          return;
        }
        if (parsed.status && parsed.status !== 0) {
          reject(new Error(parsed.message || `sf org list failed (status ${parsed.status})`));
          return;
        }

        const result = parsed.result || {};
        // The CLI reports the same orgs across multiple overlapping buckets
        // (e.g. a non-scratch org appears in both `nonScratchOrgs` and
        // `other`) — dedupe by username below.
        const buckets = [result.nonScratchOrgs, result.scratchOrgs, result.sandboxes, result.other];
        const all = buckets.filter(Array.isArray).flat();

        const seen = new Set();
        const orgs = [];
        for (const org of all) {
          if (org.connectedStatus !== 'Connected' || seen.has(org.username)) continue;
          seen.add(org.username);
          orgs.push({
            username: org.username,
            alias: org.alias || null,
            instanceUrl: org.instanceUrl,
            isScratch: !!org.isScratch,
            isSandbox: !!org.isSandbox,
          });
        }
        resolve(orgs);
      }
    );
  });
}

/**
 * Pull the last top-level `{...}` JSON object out of a string. The CLI
 * sometimes prefixes valid JSON output with plugin/update warning lines.
 */
function extractJson(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

module.exports = { listSalesforceCliOrgs };
