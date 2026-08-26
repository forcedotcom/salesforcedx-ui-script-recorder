#!/usr/bin/env node

/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * MCP Server for Salesforce UI Script Recorder
 *
 * Communicates with the VS Code extension via file-based triggers:
 *   1. Writes a command to <workspace>/.sf-ui-recorder/trigger.json
 *   2. Extension picks it up, executes it (in terminal/output channel)
 *   3. Extension writes result to <workspace>/.sf-ui-recorder/result.json
 *   4. MCP server reads the result and returns it to the agent
 *
 * The workspace path is derived from the CWD that Agentforce sets when
 * spawning this process (the open project folder).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import path from 'path'
import fs from 'fs'

// The workspace root is the cwd that Agentforce/VS Code sets when spawning us.
// Fall back to SF_UI_RECORDER_WORKSPACE env var if set.
const WORKSPACE_ROOT = process.env.SF_UI_RECORDER_WORKSPACE || process.cwd()
const TRIGGER_DIR = path.join(WORKSPACE_ROOT, '.sf-ui-recorder')
const TRIGGER_FILE = path.join(TRIGGER_DIR, 'trigger.json')
const RESULT_FILE = path.join(TRIGGER_DIR, 'result.json')

// How long to wait for the extension to respond
const RESULT_TIMEOUT_MS = 300_000 // 5 minutes (recording can take a while)
const POLL_INTERVAL_MS = 500

const server = new Server(
  {
    name: 'sf-ui-recorder',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
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
          'Launch a browser and start recording user interactions. The recording runs until the user clicks Stop in the browser overlay. Returns the paths to the generated JSON recording and Playwright spec file.',
        inputSchema: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'Starting URL to navigate to (default: about:blank)',
            },
            // output: {
            //   type: 'string',
            //   description: 'Output file path for the recording JSON (auto-generated with timestamp if not specified)',
            // },
            // headless: {
            //   type: 'boolean',
            //   description: 'Run in headless mode (default: false, runs headed)',
            // },
            // viewportWidth: {
            //   type: 'number',
            //   description: 'Viewport width in pixels (default: 1280)',
            // },
            // viewportHeight: {
            //   type: 'number',
            //   description: 'Viewport height in pixels (default: 720)',
            // },
            // profileDir: {
            //   type: 'string',
            //   description: 'Persist Chrome profile to this directory (reuse login across recordings)',
            // },
            // saveAuth: {
            //   type: 'string',
            //   description: 'Save auth state (cookies/localStorage) to JSON for playback',
            // },
            // cloud: {
            //   type: 'string',
            //   description: 'Cloud identifier for Playwright conversion',
            // },
            // user: {
            //   type: 'string',
            //   description: 'Username for Playwright conversion metadata',
            // },
            // team: {
            //   type: 'string',
            //   description: 'Team name for Playwright conversion metadata',
            // },
            // dataAttribute: {
            //   type: 'string',
            //   description: 'Custom data attribute for selectors',
            // },
          },
          required: [],
        },
      },
      {
        name: 'playback',
        description:
          'Play back a Playwright spec file (replay a recording). Runs in the VS Code terminal with visible output.',
        inputSchema: {
          type: 'object',
          properties: {
            specFile: {
              type: 'string',
              description:
                'Path to the .spec.js file to play back. Can be absolute or relative to the project root.',
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
                'Path to the recording JSON file. Can be absolute or relative to the project root.',
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
          'List all available recordings in the project test-plans/playwright/ directory.',
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

  try {
    const result = await triggerCommand(name, args || {})
    if (result.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }
    } else {
      return {
        content: [{ type: 'text', text: `Error: ${result.error}` }],
        isError: true,
      }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `MCP trigger error: ${err.message}` }],
      isError: true,
    }
  }
})

// ─── File-Based Trigger ──────────────────────────────────────────────────────

/**
 * Write a trigger file and wait for the extension to write the result.
 */
async function triggerCommand(command, args) {
  // Ensure trigger directory exists
  if (!fs.existsSync(TRIGGER_DIR)) {
    fs.mkdirSync(TRIGGER_DIR, { recursive: true })
  }

  // Remove any stale result file
  if (fs.existsSync(RESULT_FILE)) {
    fs.unlinkSync(RESULT_FILE)
  }

  // Write the trigger
  const trigger = { command, args, timestamp: Date.now() }
  fs.writeFileSync(TRIGGER_FILE, JSON.stringify(trigger, null, 2), 'utf-8')

  // Poll for result
  const result = await waitForResult()
  return result
}

/**
 * Poll for the result file until it appears or timeout.
 */
function waitForResult() {
  return new Promise((resolve, reject) => {
    const startTime = Date.now()

    const poll = () => {
      if (fs.existsSync(RESULT_FILE)) {
        try {
          const raw = fs.readFileSync(RESULT_FILE, 'utf-8').trim()
          if (raw) {
            const result = JSON.parse(raw)
            // Clean up result file
            try { fs.unlinkSync(RESULT_FILE) } catch {}
            resolve(result)
            return
          }
        } catch (err) {
          // File might be partially written, try again
        }
      }

      if (Date.now() - startTime > RESULT_TIMEOUT_MS) {
        reject(new Error(
          'Timed out waiting for VS Code extension to respond. ' +
          'Make sure the Salesforce UI Script Recorder extension is active in VS Code and a workspace folder is open.'
        ))
        return
      }

      setTimeout(poll, POLL_INTERVAL_MS)
    }

    poll()
  })
}

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`Salesforce UI Script Recorder MCP server running on stdio (workspace: ${WORKSPACE_ROOT})`)
}

main().catch((err) => {
  console.error('Failed to start MCP server:', err)
  process.exit(1)
})
