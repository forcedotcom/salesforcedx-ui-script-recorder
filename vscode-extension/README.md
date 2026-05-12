# SF UI Recorder — VS Code Extension

A lightweight VS Code extension that wraps the `sf-ui-recorder` CLI, letting you record browser interactions and play back generated Playwright tests without leaving your editor.

## Requirements

| Requirement | Install | Notes |
|-------------|---------|-------|
| **Node.js >= 18** | [nodejs.org](https://nodejs.org) | Required to run the CLI and Playwright |
| **npm / npx** | Included with Node.js | Used to invoke Playwright for playback |
| **Project dependencies** | `npm install` | Run from the project root |
| **Playwright Chromium browser** | `npx playwright install chromium` | Required for both recording and playback |

### Platform Support

The extension works on **macOS**, **Windows**, and **Linux**. After installing Node.js, run:

```bash
npm install
npx playwright install chromium
```

This downloads the correct platform-specific binaries (esbuild, Playwright browser) for your OS automatically.

### Platform Notes

- **macOS** — Works out of the box.
- **Windows** — Requires Node.js on PATH. Works with both PowerShell and Command Prompt terminals.
- **Linux** — May require additional system dependencies for Chromium. Run `npx playwright install-deps chromium` to install them.

## Getting Started

1. Open the root project folder in VS Code
2. Press **F5** to launch the Extension Development Host (uses the `.vscode/launch.json` at the project root)
3. A new VS Code window opens with the extension active

## Commands

### Start UI Recording

**Command Palette:** `SF UI Recorder: Start UI Recording`

1. Opens an input box prompting for a URL
2. Launches a Chromium browser navigated to that URL
3. A progress notification appears — use the **in-browser overlay controls** or press **Cancel** to stop and save
4. On completion, a notification shows how many events were recorded
5. The generated `.spec.js` Playwright test file opens automatically

Recordings are saved to a `recordings/` folder in your workspace:
```
<workspace>/recordings/recording_2026-05-08_14-30-22.json
<workspace>/recordings/recording_2026-05-08_14-30-22.spec.js
```

### Play Recording

**Command Palette:** `SF UI Recorder: Play Recording`

**Editor title bar:** Click the **play** button (appears on `.spec.js` files)

1. A quick pick menu appears with playback options:
   - **Headed** (checked by default) — runs the browser visibly
2. Select your options and press Enter
3. The test runs via `npx playwright test` in the integrated terminal

The terminal is reused across multiple playback runs.

## Extension Settings

Currently no configurable settings. Future options may include default browser, viewport dimensions, and Chrome profile paths.

## File Structure

```
fresh-ui-recorder/
  package.json                       Combined CLI + VS Code extension manifest
  .vscodeignore                      Packaging exclusions for vsce
  bin/cli.js                         CLI entry point
  src/                               Recorder and converter source
  images/
    icon.png                         Extension icon
    param-icon.svg                   Parameterize action icon
  recordings/                        Output directory for tests
    config/config.js                 Config loader for test playback
    utils/random.js                  Random utility for test playback
  vscode-extension/
    extension.js                     Extension entry point (activates commands)
    package.json                     CommonJS type override for this directory
    parameterize-wizard.js           Step parameterization UI wizard
    recording-codelens-provider.js   CodeLens actions on recording files
    decorations.js                   Editor decorations for recordings
    step-labels.js                   Human-readable step label generation
    config/config.js                 Runtime config for generated scripts
    utils/random.js                  Random utility for generated scripts
    commands/
      start-recording.js             Start recording command
      playback.js                    Play recording command
      parameterize.js                Parameterize step command
      reconvert.js                   Re-convert recording command
    README.md                        This file
```

## Development

The extension is launched from the project root via the `.vscode/launch.json` configuration:

```json
{
  "name": "Run Extension",
  "type": "extensionHost",
  "request": "launch",
  "args": ["--extensionDevelopmentPath=${workspaceFolder}"]
}
```

No build step is required — the extension is plain CommonJS JavaScript.

## Packaging

To build a distributable `.vsix` file:

```bash
npx @vscode/vsce package
```

This packages the entire project (CLI, source, dependencies) into a single installable file. Install it with:

```bash
code --install-extension sf-ui-recorder-1.0.0.vsix
```
