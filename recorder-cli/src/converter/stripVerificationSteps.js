/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * Strip Salesforce identity verification steps from a recording.
 *
 * When an auth-state file provides the sfdc_lv2 device cookie, Salesforce skips
 * the "Verify Your Identity" screen on playback. But during recording the user
 * still goes through verification (if it's a first-time device). Those steps
 * are useless on replay and cause failures, so we strip them automatically.
 *
 * Detection strategy:
 * 1. Find a step whose assertedEvents navigation URL contains
 *    `_ui/identity/verification` OR whose title matches "Verify Your Identity".
 *    This is the login-submit click that TRIGGERED the verification screen.
 * 2. All subsequent steps are part of the verification flow until we find a
 *    step with assertedEvents that navigates AWAY (e.g. to the Lightning app).
 * 3. Remove the verification steps (between trigger and exit, exclusive of
 *    the trigger). Replace the trigger step's assertedEvents with the final
 *    navigation destination (the page after verification).
 */

/**
 * Patterns that identify a navigation to the Salesforce identity verification page.
 */
const VERIFICATION_URL_PATTERNS = [
  '_ui/identity/verification',
  'identity/verification',
  'IdentityVerification',
]

const VERIFICATION_TITLE_PATTERNS = [
  'Verify Your Identity',
  'Identity Verification',
]

/**
 * Check if a step's assertedEvents indicate navigation to a verification page.
 */
function isVerificationNavigation(step) {
  if (!step.assertedEvents || step.assertedEvents.length === 0) return false

  return step.assertedEvents.some((event) => {
    if (event.type !== 'navigation') return false

    const url = event.url || ''
    const title = event.title || ''

    const urlMatch = VERIFICATION_URL_PATTERNS.some((pattern) =>
      url.includes(pattern)
    )
    const titleMatch = VERIFICATION_TITLE_PATTERNS.some((pattern) =>
      title.includes(pattern)
    )

    return urlMatch || titleMatch
  })
}

/**
 * Strip identity verification steps from the user flow data.
 * Returns a new data object with verification steps removed.
 *
 * @param {object} data - The user flow JSON with { title, steps, ... }
 * @returns {object} - New data object with verification steps filtered out
 */
export function stripVerificationSteps(data) {
  if (!data.steps || data.steps.length === 0) return data

  const steps = data.steps
  const filteredSteps = []
  let i = 0

  while (i < steps.length) {
    const step = steps[i]

    if (isVerificationNavigation(step)) {
      // This step triggered the verification screen (e.g. login submit click).
      // Keep this step but we'll update its assertedEvents.
      // Now scan forward to find the end of the verification section.
      let exitNavigation = null
      let j = i + 1

      while (j < steps.length) {
        const verifyStep = steps[j]

        // The exit step is the one that navigates AWAY from verification
        // (e.g. clicking "Verify" button which navigates to the app)
        if (verifyStep.assertedEvents && verifyStep.assertedEvents.length > 0) {
          const hasNonVerifyNav = verifyStep.assertedEvents.some((event) => {
            if (event.type !== 'navigation') return false
            const url = event.url || ''
            // It's the exit if it navigates somewhere that ISN'T a verification page
            return !VERIFICATION_URL_PATTERNS.some((pattern) => url.includes(pattern))
          })

          if (hasNonVerifyNav) {
            exitNavigation = verifyStep.assertedEvents.find((event) => {
              if (event.type !== 'navigation') return false
              const url = event.url || ''
              return !VERIFICATION_URL_PATTERNS.some((pattern) => url.includes(pattern))
            })
            j++ // skip this step too (it's the verify button click)
            break
          }
        }
        j++
      }

      // Replace the trigger step's assertedEvents with the post-verification
      // navigation destination, so the script waits for the right page load
      const updatedStep = { ...step }
      if (exitNavigation) {
        updatedStep.assertedEvents = [exitNavigation]
      } else {
        // No exit navigation found — just remove the verification nav assertion
        // so the step doesn't waitForNavigation to the verify page
        delete updatedStep.assertedEvents
      }
      filteredSteps.push(updatedStep)

      // Skip all verification steps — jump to after the exit
      i = j
    } else {
      filteredSteps.push(step)
      i++
    }
  }

  return {
    ...data,
    steps: filteredSteps,
  }
}
