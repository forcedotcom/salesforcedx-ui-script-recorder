# Salesforce UI Script Recorder

A CLI tool that records browser interactions and generates Playwright test scripts. Uses Chrome DevTools Protocol (CDP) isolated world injection to capture events accurately on Salesforce/LWC pages — bypassing shadow DOM retargeting and patched DOM APIs.

## Requirements

- Node.js >= 18

## Installation

```bash
npm install
```

## Quick Start

```bash
# Record a session
npx sf-ui-recorder record --url https://myorg.salesforce.com -o ./test-plans/playwright/test.json

# Run the generated Playwright test
npx playwright test --headed
```

## Commands

### `record`

Launch a browser and record user interactions. Outputs a JSON recording and a Playwright test script.

```bash
npx sf-ui-recorder record [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-u, --url <url>` | `about:blank` | Starting URL to navigate to |
| `-o, --output <path>` | `./recording.json` | Output file path for the recording JSON |
| `--headed` | `true` | Run in headed mode |
| `--headless` | `false` | Run in headless mode |
| `--browser <browser>` | `chromium` | Browser to use (chromium only for CDP features) |
| `--data-attribute <attr>` | | Custom data attribute for selectors |
| `--viewport-width <width>` | `1280` | Viewport width |
| `--viewport-height <height>` | `720` | Viewport height |
| `--profile-dir <path>` | | Persist Chrome profile to this directory |
| `--save-auth <path>` | | Save auth state (cookies/localStorage) to JSON |
| `--cloud <cloud>` | | Cloud identifier for Playwright conversion |
| `--user <user>` | | Username for Playwright conversion |
| `--team <team>` | | Team name for Playwright conversion |

**Example:**

```bash
npx sf-ui-recorder record \
  --url https://myorg.lightning.force.com \
  --profile-dir ./.chrome-profile \
  --save-auth ./auth-state.json \
  -o ./test-plans/playwright/create-account.json
```

### `convert`

Convert an existing JSON recording to a Playwright test script (without re-recording).

```bash
npx sf-ui-recorder convert <input> [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-o, --output <path>` | `<input>.spec.js` | Output path for the Playwright script |
| `--cloud <cloud>` | | Cloud identifier |
| `--user <user>` | | Username |
| `--team <team>` | | Team name |

**Example:**

```bash
npx sf-ui-recorder convert ./test-plans/playwright/create-account.json
```

## Overlay Controls

When recording, an in-page overlay appears at the top of the browser:

- **REC** indicator — shows recording is active
- **Pause/Resume** — temporarily stop capturing events
- **Stop** — finish recording and generate output files
- **Restart** — clear all recorded events and start over

You can also close the browser window to stop recording — the output will still be saved.

## Session Persistence (Skipping MFA on Playback)

For Salesforce orgs with MFA, you can persist your authenticated session so that:
1. You only log in once across multiple recording sessions
2. Playwright test playback skips authentication entirely

### How it works

**`--profile-dir`** persists the full Chrome profile (cookies, localStorage, IndexedDB, cache) to a directory. Reuse the same directory across recording sessions to stay logged in.

**`--save-auth`** exports cookies and localStorage to a JSON file when recording ends. The `playwright.config.js` automatically loads this file during test playback.

### Workflow

```bash
# First recording — log in manually (including MFA)
npx sf-ui-recorder record \
  --url https://myorg.salesforce.com \
  --profile-dir ./.chrome-profile \
  --save-auth ./auth-state.json \
  -o ./test-plans/playwright/test-flow.json

# Second recording — already authenticated, no login needed
npx sf-ui-recorder record \
  --url https://myorg.lightning.force.com/lightning/o/Account/list \
  --profile-dir ./.chrome-profile \
  --save-auth ./auth-state.json \
  -o ./test-plans/playwright/another-flow.json

# Playback — auth-state.json is loaded automatically
npx playwright test --headed
```

> **Note:** Salesforce sessions expire (typically 2-12 hours). When the session expires, re-run the recorder with `--profile-dir` and log in again to refresh the stored state.

## Running Generated Tests

Generated Playwright scripts are saved to the `test-plans/playwright/` directory as `.spec.js` files. Run them with:

```bash
# Run all tests
npx playwright test --headed

# Run a specific test
npx playwright test create-account.spec.js --headed

# Set credentials for tests that use username/password fills
RECORDER_USERNAME="user@example.com" RECORDER_PASSWORD="pass" npx playwright test --headed
```

## Project Structure

```
sf-ui-recorder/
├── bin/cli.js                        # CLI entry point
├── src/
│   ├── index.js                      # Main orchestrator (Playwright + CDP + WS)
│   ├── server.js                     # WebSocket server
│   ├── build.js                      # esbuild bundler for injected scripts
│   ├── playwright-converter.js       # JSON → Playwright script converter
│   ├── converter/                    # Playwright code generation engine
│   │   ├── index.js                  # Converter entry point
│   │   ├── buildPlaywrightScript.js  # Script assembly
│   │   ├── parametrise.js            # Parameter injection
│   │   ├── BrowserContext.js         # Browser context tracking
│   │   ├── Stack.js                  # Frame stack management
│   │   ├── constants.js              # Converter constants
│   │   └── scriptHandlers/           # Per-action code generators
│   │       ├── BaseAction.js         # Shared action base
│   │       ├── ChangeAction.js       # Input/select changes
│   │       ├── ClickAction.js        # Click events
│   │       ├── FrameAction.js        # Frame navigation
│   │       ├── Header.js             # Test file header/imports
│   │       ├── KeyboardAction.js     # Keyboard events
│   │       ├── NavigateAction.js     # Page navigation
│   │       └── ViewportAction.js     # Viewport resize
│   └── injected/                     # Scripts injected into the browser
│       ├── entry.js                  # IIFE entry (WS, state, init)
│       ├── controller.js             # Recording control logic
│       ├── recorder.js               # Event capture
│       ├── selector.js               # Selector generation
│       ├── finder.js                 # CSS uniqueness finder
│       ├── overlay.js                # Recording UI overlay
│       ├── constants.js              # Injected script constants
│       └── vendor/                   # Shadow DOM traversal utilities
│           ├── Logger.js             # Logging utility
│           ├── SelectorComputer.js   # Selector computation
│           ├── puppeteer/            # Puppeteer-based query selectors
│           └── selectors/            # Selector strategy implementations
├── vscode-extension/                 # VS Code extension
│   ├── extension.js                  # Extension entry point
│   ├── package.json                  # CommonJS type override
│   ├── parameterize-wizard.js        # Step parameterization UI
│   ├── recording-codelens-provider.js # CodeLens for recordings
│   ├── decorations.js                # Editor decorations
│   ├── step-labels.js                # Human-readable step labels
│   ├── utils/random.js               # Random utility for generated scripts
│   ├── commands/                     # Command implementations
│   │   ├── start-recording.js        # Start recording command
│   │   ├── playback.js               # Play recording command
│   │   ├── parameterize.js           # Parameterize step command
│   │   └── reconvert.js              # Re-convert recording command
│   └── README.md                     # Extension documentation
├── images/                           # Icons and images
│   ├── icon.png                      # Extension icon
│   └── param-icon.svg                # Parameterize action icon
├── test-plans/playwright/             # Output directory for tests
├── playwright.config.js              # Playwright test runner config
├── .vscodeignore                     # Packaging exclusions for vsce
└── package.json                      # Combined CLI + VS Code extension manifest
```

## How It Works

1. **Build** — `esbuild` bundles the injected scripts (`src/injected/`) into a single IIFE
2. **Launch** — Playwright launches Chromium; a WebSocket server starts for communication
3. **Inject** — The bundled script is injected into a CDP **isolated world** (same as Chrome extension content scripts)
4. **Record** — The injected script captures DOM events and sends them to the CLI via WebSocket
5. **Generate** — On stop, the CLI produces a JSON user flow and converts it to a Playwright test script

The isolated world injection ensures correct behavior on Salesforce pages where LWC patches native DOM APIs and retargets events across shadow DOM boundaries.
