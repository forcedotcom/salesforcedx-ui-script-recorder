/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

import fs from 'fs'
import path from 'path'
import chalk from 'chalk'

const RESULTS_DIR = path.resolve('playback-results')

export function generateReport(options = {}) {
  const { last, all, json } = options

  if (!fs.existsSync(RESULTS_DIR)) {
    console.log(chalk.yellow('No test results found. Run a playback first.'))
    return
  }

  const runs = getRunDirs().map(loadRun).filter(Boolean)

  if (runs.length === 0) {
    console.log(chalk.yellow('No test results found. Run a playback first.'))
    return
  }

  // Group runs by batchId (single runs get their own group)
  const groups = groupRuns(runs)

  if (json) {
    const data = all ? groups : [groups[groups.length - 1]]
    console.log(JSON.stringify(data, null, 2))
    return
  }

  const groupsToShow = all ? groups : [groups[groups.length - 1]]

  for (const group of groupsToShow) {
    if (group.batchId) {
      printBatch(group)
    } else {
      printRun(group.runs[0])
    }
    if (groupsToShow.length > 1) console.log('')
  }

  if (all && groups.length > 1) {
    printTrend(groups)
  }
}

function getRunDirs() {
  const dirs = []

  for (const entry of fs.readdirSync(RESULTS_DIR)) {
    const full = path.join(RESULTS_DIR, entry)
    if (!fs.statSync(full).isDirectory()) continue

    if (entry.endsWith('---BULK')) {
      for (const sub of fs.readdirSync(full)) {
        const subFull = path.join(full, sub)
        if (!fs.statSync(subFull).isDirectory()) continue
        if (!fs.existsSync(path.join(subFull, 'results.json'))) continue
        dirs.push({ dirName: `${entry}/${sub}`, bulkParent: entry })
      }
    } else if (fs.existsSync(path.join(full, 'results.json'))) {
      dirs.push({ dirName: entry, bulkParent: null })
    }
  }

  dirs.sort((a, b) => a.dirName.localeCompare(b.dirName))
  return dirs
}

function loadRun(entry) {
  const dirName = typeof entry === 'string' ? entry : entry.dirName
  const bulkParent = typeof entry === 'string' ? null : entry.bulkParent
  const resultsPath = path.join(RESULTS_DIR, dirName, 'results.json')
  if (!fs.existsSync(resultsPath)) return null
  const data = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'))
  data._dirName = dirName
  if (bulkParent) data._bulkParent = bulkParent
  return data
}

function groupRuns(runs) {
  const groups = []
  const bulkMap = new Map()

  for (const run of runs) {
    const groupKey = run._bulkParent || run.bulkFolder || (run.batchId ? `batch-${run.batchId}` : null)
    if (groupKey) {
      if (!bulkMap.has(groupKey)) {
        const group = { batchId: run.batchId || groupKey, bulkFolder: run._bulkParent || run.bulkFolder || null, runs: [] }
        bulkMap.set(groupKey, group)
        groups.push(group)
      }
      bulkMap.get(groupKey).runs.push(run)
    } else {
      groups.push({ batchId: null, bulkFolder: null, runs: [run] })
    }
  }

  for (const group of groups) {
    if (group.batchId) {
      group.runs.sort((a, b) => (a.sessionIndex || 0) - (b.sessionIndex || 0))
    }
  }

  return groups
}

function printBatch(group) {
  const { bulkFolder, runs } = group
  const totalSessions = runs.length
  const passedSessions = runs.filter((r) => r.status === 'passed').length
  const failedSessions = totalSessions - passedSessions
  const totalDuration = Math.max(...runs.map((r) => r.duration))
  const overallStatus = failedSessions === 0 ? 'passed' : 'failed'
  const date = new Date(runs[0].timestamp).toLocaleString()

  const statusIcon = overallStatus === 'passed' ? chalk.green('PASS') : chalk.red('FAIL')
  console.log(`${statusIcon}  ${chalk.cyan('BULK')}  ${chalk.dim(date)}  ${chalk.dim(`(${formatDuration(totalDuration)})`)}`)
  const folderLabel = bulkFolder || runs[0]._bulkParent || runs[0]._dirName
  console.log(chalk.dim(`     ${path.join('playback-results', folderLabel)}/  •  ${totalSessions} sessions`))
  console.log('')

  console.log(
    `     ${chalk.green(`${passedSessions} passed`)}` +
      (failedSessions > 0 ? `  ${chalk.red(`${failedSessions} failed`)}` : '') +
      `  ${chalk.dim(`(${totalSessions} sessions)`)}`
  )
  console.log('')

  for (const run of runs) {
    const icon = run.status === 'passed' ? chalk.green('✓') : chalk.red('✗')
    const label = `Session ${run.sessionIndex || '?'}`
    const dur = chalk.dim(`(${formatDuration(run.duration)})`)
    console.log(`     ${icon} ${label}  ${dur}`)

    if (run.status !== 'passed') {
      const failures = run.tests.filter((t) => t.status === 'failed' || t.status === 'timedOut')
      for (const test of failures) {
        if (test.errors?.length > 0) {
          const firstError = test.errors[0].message?.split('\n')[0] || 'Unknown error'
          console.log(chalk.dim(`         ${firstError}`))
        }
      }
    }
  }
}

function printRun(run) {
  const statusIcon = run.status === 'passed' ? chalk.green('PASS') : chalk.red('FAIL')
  const date = new Date(run.timestamp).toLocaleString()
  const duration = formatDuration(run.duration)

  console.log(`${statusIcon}  ${chalk.dim(date)}  ${chalk.dim(`(${duration})`)}`)
  console.log(chalk.dim(`     ${path.join('playback-results', run._dirName)}/`))
  console.log('')

  console.log(
    `     ${chalk.green(`${run.passed} passed`)}` +
      (run.failed > 0 ? `  ${chalk.red(`${run.failed} failed`)}` : '') +
      (run.skipped > 0 ? `  ${chalk.yellow(`${run.skipped} skipped`)}` : '') +
      (run.timedOut > 0 ? `  ${chalk.magenta(`${run.timedOut} timed out`)}` : '') +
      `  ${chalk.dim(`(${run.total} total)`)}`)

  if (run.failed > 0 || run.timedOut > 0) {
    console.log('')
    const failures = run.tests.filter((t) => t.status === 'failed' || t.status === 'timedOut')
    for (const test of failures) {
      const icon = test.status === 'timedOut' ? chalk.magenta('⏱') : chalk.red('✗')
      console.log(`     ${icon} ${test.file} > ${test.title}`)
      if (test.errors?.length > 0) {
        const firstError = test.errors[0].message?.split('\n')[0] || 'Unknown error'
        console.log(chalk.dim(`       ${firstError}`))
      }
    }
  }
}

function printTrend(groups) {
  console.log(chalk.dim('─'.repeat(50)))
  console.log(chalk.bold('  Trend (last ' + groups.length + ' runs):'))
  const passCount = groups.filter((g) => {
    return g.runs.every((r) => r.status === 'passed')
  }).length
  const bar = groups.map((g) => {
    const allPassed = g.runs.every((r) => r.status === 'passed')
    return allPassed ? chalk.green('●') : chalk.red('●')
  }).join(' ')
  console.log(`  ${bar}`)
  console.log(`  ${chalk.dim(`${passCount}/${groups.length} passed (${Math.round((passCount / groups.length) * 100)}%)`)}`)
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.round((ms % 60000) / 1000)
  return `${mins}m ${secs}s`
}
