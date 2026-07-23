import fs from 'fs'
import path from 'path'

class RecorderReporter {
  constructor() {
    this.results = []
    this.startTime = null
  }

  onBegin(config, suite) {
    this.startTime = new Date().toISOString()
    this.suiteName = suite.title || 'Test Run'
  }

  onTestEnd(test, result) {
    const entry = {
      title: test.title,
      file: path.basename(test.location.file),
      status: result.status,
      duration: result.duration,
      retries: result.retry,
    }

    if (result.status === 'failed' || result.status === 'timedOut') {
      entry.errors = result.errors.map((e) => ({
        message: e.message,
        stack: e.stack,
        snippet: e.snippet,
      }))
    }

    if (result.stdout?.length > 0) {
      entry.stdout = result.stdout.map((chunk) => chunk.toString()).join('')
    }

    if (result.stderr?.length > 0) {
      entry.stderr = result.stderr.map((chunk) => chunk.toString()).join('')
    }

    if (result.attachments?.length > 0) {
      entry.attachments = result.attachments.map((a) => ({
        name: a.name,
        contentType: a.contentType,
        path: a.path,
      }))
    }

    this.results.push(entry)
  }

  onEnd(result) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const batchId = process.env.SF_UI_RECORDER_BATCH_ID || null
    const sessionIndex = process.env.SF_UI_RECORDER_SESSION_INDEX || null

    const specFiles = [...new Set(this.results.map((r) => r.file))]
    const specName = specFiles.length === 1
      ? specFiles[0].replace(/\.spec\.js$/, '')
      : specFiles.map((f) => f.replace(/\.spec\.js$/, '')).join('+')

    const dirName = batchId
      ? `${specName}---batch-${batchId}---session-${sessionIndex}`
      : `${specName}---${timestamp}`
    const runDir = path.resolve('playback-results', dirName)
    fs.mkdirSync(runDir, { recursive: true })

    const summary = {
      timestamp: this.startTime,
      duration: result.duration,
      status: result.status,
      ...(batchId && { batchId, sessionIndex: parseInt(sessionIndex, 10) }),
      total: this.results.length,
      passed: this.results.filter((r) => r.status === 'passed').length,
      failed: this.results.filter((r) => r.status === 'failed').length,
      skipped: this.results.filter((r) => r.status === 'skipped').length,
      timedOut: this.results.filter((r) => r.status === 'timedOut').length,
      tests: this.results,
    }

    // Copy screenshot/image attachments into the run folder so each result
    // directory is self-contained, and rewrite the stored path to the local copy.
    for (const test of this.results) {
      if (!test.attachments?.length) continue
      test.attachments = test.attachments.map((att) => {
        const isImage = att.contentType?.startsWith('image/') || /\.png$/i.test(att.path || '')
        if (!isImage || !att.path || !fs.existsSync(att.path)) return att
        const ext = path.extname(att.path) || '.png'
        const safeTitle = test.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80)
        const destName = `${test.status}--${safeTitle || 'test'}${ext}`
        const destPath = path.join(runDir, destName)
        try {
          fs.copyFileSync(att.path, destPath)
          return { ...att, path: destName }
        } catch {
          return att
        }
      })
    }

    const resultsPath = path.join(runDir, 'results.json')
    fs.writeFileSync(resultsPath, JSON.stringify(summary, null, 2))

    const latestPath = path.resolve('playback-results', 'latest.json')
    fs.writeFileSync(latestPath, JSON.stringify({ run: dirName, ...summary }, null, 2))
  }
}

export default RecorderReporter
