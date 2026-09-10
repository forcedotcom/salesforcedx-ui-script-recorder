/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * Thin wrapper around the Salesforce CLI (`sf`) for org-authenticated
 * recording/playback. Lets a user record and play back against an org
 * they've already logged into via `sf org login web` — no username,
 * password, or MFA code is ever typed or stored by this tool.
 *
 * SECURITY: `getFrontdoorUrl()` returns a URL containing a live session
 * token (`sid`). Callers must treat that return value as a secret —
 * never write it to a recording JSON, a generated .spec.js, a log line,
 * or any file under version control. Use `sanitizeFrontdoor()` any time
 * the destination needs to be recorded or printed.
 */

import { execFile } from 'child_process'

const SF_NOT_FOUND_MESSAGE =
  'Salesforce CLI ("sf") not found on PATH. Install it from https://developer.salesforce.com/tools/salesforcecli ' +
  'and run "sf org login web" to authenticate an org, then try again.'

/**
 * Run an `sf` subcommand and parse its `--json` output.
 * Always invoked as execFile with an argument array (never a shell string)
 * so org names/aliases can't be interpreted as shell syntax.
 *
 * @param {string[]} args - CLI arguments, e.g. ['org', 'list', '--json']
 * @returns {Promise<any>} the parsed `result` field of the CLI's JSON output
 */
function runSfJson(args) {
  return new Promise((resolve, reject) => {
    execFile('sf', [...args, '--json'], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        reject(new Error(SF_NOT_FOUND_MESSAGE))
        return
      }

      // The CLI can print update/plugin warnings to stdout or stderr ahead of
      // the JSON payload, and exits non-zero on some warning conditions even
      // when the JSON itself is valid — so always try to parse stdout first.
      const parsed = extractJson(stdout)
      if (parsed) {
        if (parsed.status && parsed.status !== 0) {
          reject(new Error(parsed.message || `sf ${args.join(' ')} failed (status ${parsed.status})`))
          return
        }
        resolve(parsed.result)
        return
      }

      reject(new Error(
        `Failed to parse output of "sf ${args.join(' ')}": ${(err && err.message) || stderr || 'no JSON found'}`
      ))
    })
  })
}

/**
 * Pull the last top-level `{...}` JSON object out of a string. The CLI
 * sometimes prefixes valid JSON output with plugin/update warning lines —
 * if one of those lines itself contains a "{", the first one isn't
 * necessarily where the real payload starts, so keep trying subsequent
 * "{" occurrences until one actually parses.
 */
function extractJson(text) {
  if (!text) return null
  let start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  while (start !== -1 && start <= end) {
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      start = text.indexOf('{', start + 1)
    }
  }
  return null
}

/**
 * List orgs the Salesforce CLI is currently authenticated to.
 * @returns {Promise<Array<{ username: string, alias: string|null, instanceUrl: string, isScratch: boolean, isSandbox: boolean }>>}
 */
export async function listOrgs() {
  const result = await runSfJson(['org', 'list'])
  // The CLI reports the same orgs across multiple overlapping buckets
  // (e.g. a non-scratch org appears in both `nonScratchOrgs` and `other`) —
  // dedupe by username below.
  const buckets = [result?.nonScratchOrgs, result?.scratchOrgs, result?.sandboxes, result?.other]
  const all = buckets.filter(Array.isArray).flat()

  const seen = new Set()
  const orgs = []
  for (const org of all) {
    if (org.connectedStatus !== 'Connected' || seen.has(org.username)) continue
    seen.add(org.username)
    orgs.push({
      username: org.username,
      alias: org.alias || null,
      instanceUrl: org.instanceUrl,
      isScratch: !!org.isScratch,
      isSandbox: !!org.isSandbox
    })
  }
  return orgs
}

/**
 * Resolve a one-time "frontdoor" URL that logs a browser straight into the
 * given org's session — no credentials, no MFA prompt, since the CLI
 * already holds a valid OAuth token for it.
 *
 * SECURITY: the returned URL contains a live session token (`sid` query
 * param). Keep it in memory only — pass it directly to `page.goto()` and
 * never log, persist, or otherwise write it out. Use `sanitizeFrontdoor()`
 * to get a safe-to-record/print equivalent.
 *
 * @param {string} orgUsernameOrAlias
 * @param {{ path?: string }} [options] - relative path to land on after login
 * @returns {Promise<string>} frontdoor URL (treat as a secret)
 */
export async function getFrontdoorUrl(orgUsernameOrAlias, options = {}) {
  if (!orgUsernameOrAlias) {
    throw new Error('getFrontdoorUrl() requires an org username or alias')
  }
  const args = ['org', 'open', '-o', orgUsernameOrAlias, '--url-only']
  if (options.path) {
    args.push('--path', options.path)
  }
  // Unlike other `sf` subcommands, `org open --json` omits the URL from its
  // `result` (it only returns orgId/username) since the URL is a live
  // session credential — it's only printed in the plain-text output, so
  // this reads stdout directly rather than going through runSfJson.
  const stdout = await new Promise((resolve, reject) => {
    execFile('sf', args, { maxBuffer: 10 * 1024 * 1024 }, (err, out) => {
      if (err && err.code === 'ENOENT') {
        reject(new Error(SF_NOT_FOUND_MESSAGE))
        return
      }
      // The CLI can exit non-zero on warning conditions (e.g. an available
      // update) even though the URL printed fine, so always try to extract
      // it from stdout before treating this as a failure.
      resolve(out)
    })
  })
  const url = extractUrl(stdout)
  if (!url) {
    throw new Error(`"sf org open -o ${orgUsernameOrAlias} --url-only" did not return a URL`)
  }
  return url
}

/**
 * Pull the last http(s) URL out of a string. `sf org open`'s plain-text
 * output can print an unrelated docs link inside its warning banner before
 * the actual login link, so the last match is always the real one.
 */
function extractUrl(text) {
  if (!text) return null
  const matches = text.match(/https?:\/\/\S+/g)
  return matches ? matches[matches.length - 1] : null
}

/**
 * Strip the session token from a frontdoor URL, leaving a safe-to-record,
 * safe-to-log destination (origin + the retURL path it was headed to).
 *
 * @param {string} frontdoorUrl
 * @returns {string} sanitized URL, e.g. "https://myorg.my.salesforce.com/lightning/page"
 */
export function sanitizeFrontdoor(frontdoorUrl) {
  try {
    const parsed = new URL(frontdoorUrl)
    const retUrl = parsed.searchParams.get('retURL')
    return retUrl ? new URL(retUrl, parsed.origin).toString() : parsed.origin + '/'
  } catch {
    return frontdoorUrl
  }
}
