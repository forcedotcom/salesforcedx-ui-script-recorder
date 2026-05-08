# SF UI Recorder — VS Code Extension

A lightweight VS Code extension that wraps the `sf-ui-recorder` CLI, letting you record browser interactions and play back generated Playwright tests without leaving your editor.

## Prerequisites

- Node.js >= 18
- The `sf-ui-recorder` CLI (parent directory) with dependencies installed (`npm install`)
- Playwright browsers installed (`npx playwright install chromium`)

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
vscode-extension/
  package.json      Extension manifest (commands, menus, activation)
  extension.js      Extension entry point (command implementations)
  .vscodeignore     Packaging exclusions
  README.md         This file
```

## Development

The extension is launched from the project root via the `.vscode/launch.json` configuration:

```json
{
  "name": "Run Extension",
  "type": "extensionHost",
  "request": "launch",
  "args": ["--extensionDevelopmentPath=${workspaceFolder}/vscode-extension"]
}
```

No build step is required — the extension is plain CommonJS JavaScript.
