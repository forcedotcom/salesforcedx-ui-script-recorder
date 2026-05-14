#!/usr/bin/env node

/**
 * MCP Server for SF UI Recorder
 *
 * Exposes the record and playback CLI commands as MCP tools
 * so Claude Code (or any MCP client) can trigger them.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { spawn } from 'child_process'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')
const CLI_PATH = path.join(PROJECT_ROOT, 'bin', 'cli.js')
const RECORDINGS_DIR = path.join(PROJECT_ROOT, 'recordings')

// Track active recording process
let activeRecordingProcess = null

const server = new Server(
  {
    name: 'sf-ui-recorder',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
)

// ─── Tools ───────────────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'record',
        description:
          'Launch a browser and start recording user interactions. The recording runs until the user clicks Stop in the browser overlay. Returns the path to the generated JSON recording and Playwright spec file.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Starting URL to navigate to (default: about:blank)',
            },
            output: {
              type: 'string',
              description: 'Output file path for the recording JSON (auto-generated if not specified)',
            },
            browser: {
              type: 'string',
              enum: ['chromium'],
              description: 'Browser to use (default: chromium)',
            },
            headless: {
              type: 'boolean',
              description: 'Run in headless mode (default: false, runs headed)',
            },
            viewportWidth: {
              type: 'number',
              description: 'Viewport width in pixels (default: 1280)',
            },
            viewportHeight: {
              type: 'number',
              description: 'Viewport height in pixels (default: 720)',
            },
            profileDir: {
              type: 'string',
              description: 'Persist Chrome profile to this directory (reuse login across recordings)',
            },
            saveAuth: {
              type: 'string',
              description: 'Save auth state (cookies/localStorage) to JSON for playback',
            },
            cloud: {
              type: 'string',
              description: 'Cloud identifier for Playwright conversion',
            },
            user: {
              type: 'string',
              description: 'Username for Playwright conversion metadata',
            },
            team: {
              type: 'string',
              description: 'Team name for Playwright conversion metadata',
            },
            dataAttribute: {
              type: 'string',
              description: 'Custom data attribute for selectors',
            },
          },
          required: [],
        },
      },
      {
        name: 'playback',
        description:
          'Run a Playwright spec file (playback a recording). Executes `npx playwright test` on the specified .spec.js file and returns the test results.',
        inputSchema: {
          type: 'object',
          properties: {
            specFile: {
              type: 'string',
              description:
                'Path to the .spec.js file to play back. Can be absolute or relative to the project recordings/ directory.',
            },
            headed: {
              type: 'boolean',
              description: 'Run with a visible browser window (default: true)',
            },
          },
          required: ['specFile'],
        },
      },
      {
        name: 'convert',
        description:
          'Convert a recorded JSON file to a Playwright test script without replaying it.',
        inputSchema: {
          type: 'object',
          properties: {
            inputFile: {
              type: 'string',
              description:
                'Path to the recording JSON file. Can be absolute or relative to the project recordings/ directory.',
            },
            output: {
              type: 'string',
              description: 'Output path for the Playwright script (defaults to same name with .spec.js extension)',
            },
            cloud: {
              type: 'string',
              description: 'Cloud identifier',
            },
            user: {
              type: 'string',
              description: 'Username',
            },
            team: {
              type: 'string',
              description: 'Team name',
            },
          },
          required: ['inputFile'],
        },
      },
      {
        name: 'list_recordings',
        description:
          'List all available recordings in the recordings/ directory. Returns JSON and spec.js file pairs.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ],
  }
})

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'record':
      return await handleRecord(args)
    case 'playback':
      return await handlePlayback(args)
    case 'convert':
      return await handleConvert(args)
    case 'list_recordings':
      return await handleListRecordings()
    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      }
  }
})

// ─── Resources ───────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const resources = []

  if (fs.existsSync(RECORDINGS_DIR)) {
    const files = fs.readdirSync(RECORDINGS_DIR)
    for (const file of files) {
      if (file.endsWith('.json') && !file.startsWith('.')) {
        resources.push({
          uri: `recording:///${file}`,
          name: file,
          mimeType: 'application/json',
          description: `Recording file: ${file}`,
        })
      }
      if (file.endsWith('.spec.js')) {
        resources.push({
          uri: `recording:///${file}`,
          name: file,
          mimeType: 'application/javascript',
          description: `Playwright spec: ${file}`,
        })
      }
    }
  }

  return { resources }
})

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri
  const filename = uri.replace('recording:///', '')
  const filePath = path.join(RECORDINGS_DIR, filename)

  if (!fs.existsSync(filePath)) {
    throw new Error(`Recording file not found: ${filename}`)
  }

  const content = fs.readFileSync(filePath, 'utf-8')
  return {
    contents: [
      {
        uri,
        mimeType: filename.endsWith('.json') ? 'application/json' : 'application/javascript',
        text: content,
      },
    ],
  }
})

// ─── Tool Handlers ───────────────────────────────────────────────────────────

async function handleRecord(args = {}) {
  const cliArgs = ['record']

  if (args.url) cliArgs.push('--url', args.url)
  if (args.output) cliArgs.push('--output', args.output)
  if (args.browser) cliArgs.push('--browser', args.browser)
  if (args.headless) cliArgs.push('--headless')
  if (args.viewportWidth) cliArgs.push('--viewport-width', String(args.viewportWidth))
  if (args.viewportHeight) cliArgs.push('--viewport-height', String(args.viewportHeight))
  if (args.profileDir) cliArgs.push('--profile-dir', args.profileDir)
  if (args.saveAuth) cliArgs.push('--save-auth', args.saveAuth)
  if (args.cloud) cliArgs.push('--cloud', args.cloud)
  if (args.user) cliArgs.push('--user', args.user)
  if (args.team) cliArgs.push('--team', args.team)
  if (args.dataAttribute) cliArgs.push('--data-attribute', args.dataAttribute)

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const proc = spawn('node', [CLI_PATH, ...cliArgs], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    activeRecordingProcess = proc

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      activeRecordingProcess = null

      if (code === 0) {
        // Extract output file paths from stdout
        const jsonMatch = stdout.match(/saved to[:\s]+(.+\.json)/i)
        const specMatch = stdout.match(/saved to[:\s]+(.+\.spec\.js)/i)

        resolve({
          content: [
            {
              type: 'text',
              text: [
                '✓ Recording completed successfully.',
                jsonMatch ? `  JSON: ${jsonMatch[1].trim()}` : '',
                specMatch ? `  Spec: ${specMatch[1].trim()}` : '',
                '',
                'CLI Output:',
                stdout,
                stderr ? `\nStderr:\n${stderr}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            },
          ],
        })
      } else {
        resolve({
          content: [
            {
              type: 'text',
              text: `Recording failed (exit code ${code}).\n\nStdout:\n${stdout}\n\nStderr:\n${stderr}`,
            },
          ],
          isError: true,
        })
      }
    })

    proc.on('error', (err) => {
      activeRecordingProcess = null
      resolve({
        content: [
          {
            type: 'text',
            text: `Failed to start recording process: ${err.message}`,
          },
        ],
        isError: true,
      })
    })
  })
}

async function handlePlayback(args) {
  let specFile = args.specFile

  // Resolve relative paths against recordings directory
  if (!path.isAbsolute(specFile)) {
    const inRecordings = path.join(RECORDINGS_DIR, specFile)
    if (fs.existsSync(inRecordings)) {
      specFile = inRecordings
    } else {
      specFile = path.resolve(PROJECT_ROOT, specFile)
    }
  }

  if (!fs.existsSync(specFile)) {
    return {
      content: [{ type: 'text', text: `Spec file not found: ${specFile}` }],
      isError: true,
    }
  }

  if (!specFile.endsWith('.spec.js')) {
    return {
      content: [{ type: 'text', text: `File must be a .spec.js file: ${specFile}` }],
      isError: true,
    }
  }

  const playwrightArgs = ['playwright', 'test', specFile]
  const headed = args.headed !== false // default true
  if (headed) {
    playwrightArgs.push('--headed')
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const proc = spawn('npx', playwrightArgs, {
      cwd: PROJECT_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({
          content: [
            {
              type: 'text',
              text: `✓ Playback completed successfully.\n\nFile: ${specFile}\n\nOutput:\n${stdout}${stderr ? `\nStderr:\n${stderr}` : ''}`,
            },
          ],
        })
      } else {
        resolve({
          content: [
            {
              type: 'text',
              text: `✗ Playback failed (exit code ${code}).\n\nFile: ${specFile}\n\nOutput:\n${stdout}\n\nStderr:\n${stderr}`,
            },
          ],
          isError: true,
        })
      }
    })

    proc.on('error', (err) => {
      resolve({
        content: [
          {
            type: 'text',
            text: `Failed to start playback: ${err.message}`,
          },
        ],
        isError: true,
      })
    })
  })
}

async function handleConvert(args) {
  let inputFile = args.inputFile

  // Resolve relative paths against recordings directory
  if (!path.isAbsolute(inputFile)) {
    const inRecordings = path.join(RECORDINGS_DIR, inputFile)
    if (fs.existsSync(inRecordings)) {
      inputFile = inRecordings
    } else {
      inputFile = path.resolve(PROJECT_ROOT, inputFile)
    }
  }

  if (!fs.existsSync(inputFile)) {
    return {
      content: [{ type: 'text', text: `Input file not found: ${inputFile}` }],
      isError: true,
    }
  }

  const cliArgs = ['convert', inputFile]
  if (args.output) cliArgs.push('--output', args.output)
  if (args.cloud) cliArgs.push('--cloud', args.cloud)
  if (args.user) cliArgs.push('--user', args.user)
  if (args.team) cliArgs.push('--team', args.team)

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''

    const proc = spawn('node', [CLI_PATH, ...cliArgs], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    proc.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({
          content: [
            {
              type: 'text',
              text: `✓ Conversion completed.\n\nOutput:\n${stdout}${stderr ? `\nStderr:\n${stderr}` : ''}`,
            },
          ],
        })
      } else {
        resolve({
          content: [
            {
              type: 'text',
              text: `Conversion failed (exit code ${code}).\n\nStdout:\n${stdout}\n\nStderr:\n${stderr}`,
            },
          ],
          isError: true,
        })
      }
    })

    proc.on('error', (err) => {
      resolve({
        content: [
          {
            type: 'text',
            text: `Failed to start conversion: ${err.message}`,
          },
        ],
        isError: true,
      })
    })
  })
}

async function handleListRecordings() {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    return {
      content: [{ type: 'text', text: 'No recordings directory found.' }],
    }
  }

  const files = fs.readdirSync(RECORDINGS_DIR).sort()
  const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.startsWith('.'))
  const specFiles = files.filter((f) => f.endsWith('.spec.js'))

  const recordings = jsonFiles.map((jsonFile) => {
    const baseName = jsonFile.replace(/\.json$/, '')
    const hasSpec = specFiles.includes(`${baseName}.spec.js`)
    const filePath = path.join(RECORDINGS_DIR, jsonFile)
    const stats = fs.statSync(filePath)

    return {
      name: baseName,
      jsonFile,
      specFile: hasSpec ? `${baseName}.spec.js` : null,
      size: stats.size,
      modified: stats.mtime.toISOString(),
    }
  })

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            recordingsDir: RECORDINGS_DIR,
            count: recordings.length,
            recordings,
          },
          null,
          2
        ),
      },
    ],
  }
}

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('SF UI Recorder MCP server running on stdio')
}

main().catch((err) => {
  console.error('Failed to start MCP server:', err)
  process.exit(1)
})
