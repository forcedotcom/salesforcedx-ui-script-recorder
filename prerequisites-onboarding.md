**Google Doc:** [https://docs.google.com/document/d/18x-p6XiD2mXnp8J0EU8VzTo_WG31t6PCEFyho3Crv0M/edit](https://docs.google.com/document/d/18x-p6XiD2mXnp8J0EU8VzTo_WG31t6PCEFyho3Crv0M/edit)

# Prerequisites

Before using SF UI Recorder, ensure the following tools are installed on your machine.

## 1. Node.js (v18 or later)

Node.js is required to run the recorder and execute generated tests.

**macOS (Homebrew):**

```bash
brew install node
```

**Windows (winget):**

```bash
winget install OpenJS.NodeJS.LTS --source winget

# may need to set execution policy to run npm commands
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

**Linux (apt):**

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**All platforms (alternative):**  
Download the LTS installer from [https://nodejs.org](https://nodejs.org)

Verify your installation:

```bash
node --version
npm --version
```

## 2. Playwright & Test Framework

Install Playwright as a dependency in your project. This is required for test playback.

```bash
# if not yet already initialized as a node project
npm init -y
npm install playwright @playwright/test
```

## 3. Playwright Browsers

Playwright requires browser binaries to run tests. Install Chromium (the default browser used for recording and playback):

```bash
npx playwright install chromium
```

## Verify Your Setup

After completing the steps above, confirm everything is working:

```bash
node --version          # Should print v18.x.x or later
npx playwright --version   # Should print the installed Playwright version
```

You're all set! Proceed to the next section to install the extension.

# Installing the Extension

SF UI Recorder is distributed as a `.vsix` file during the pilot phase. Follow these steps to install it in any VS Code-based editor (VS Code, Code for Salesforce, Cursor, etc.).

## Steps

1. Open your VS Code-based editor.
2. Open the **Extensions** panel by clicking the Extensions icon in the Activity Bar (or pressing `Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Drag and drop the `.vsix` file directly into the Extensions panel.
4. The extension will install automatically. You should see **SF UI Recorder** appear in your list of installed extensions.

## Alternative: Install via Command Palette

If drag and drop isn't working, you can install from the Command Palette:

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Type **"Extensions: Install from VSIX..."** and select it.
3. Browse to and select the `.vsix` file.
4. Reload the editor when prompted.

## Verify Installation

After installation, confirm the extension is active:

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Type **"SF UI Recorder"** — you should see the extension's commands appear in the list.

# Using the Extension

## Core Features

### Record a Test

Record browser interactions and automatically generate a Playwright test script.

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **"SF UI Recorder: Start UI Recording"**.
3. Enter the URL you want to record against (e.g., your Salesforce org login page).
4. A browser window will launch with an overlay control bar for managing the session.
5. Interact with the page as you normally would — clicks, form fills, navigation are all captured.
6. When finished, click **Stop** in the overlay (or press Cancel in the VS Code progress notification).
7. The extension saves your recording and automatically generates a Playwright test file.

Your files are saved in a `recordings/` folder in your workspace:

- `recording_<timestamp>.json` — the raw recording data
- `recording_<timestamp>.spec.js` — the generated Playwright test

### Play Back a Test

Run a previously recorded test in the browser.

1. Open a `.spec.js` file in the editor.
2. Open the Command Palette and run **"SF UI Recorder: Play Recording"**, or click the **Play** icon in the editor title bar.
3. A form modal opens showing input fields for any parameterized values (e.g., username, password). Fill in the required values and click **Run**.
4. The test executes via Playwright in the integrated terminal.

> **Note:** On first playback, the extension may prompt you to create a supporting config file (`config/config.js`). Accept the prompt to generate it automatically.

### Providing Values for Parameterized Steps

The generated test uses parameterized values for inputs like username and password. **Username and Password fields are automatically parameterized** during recording — you'll be prompted to provide their values before each playback run.

When you click **Play Recording**, a modal form appears with input fields for every parameterized value in the test. Fill in the values and press **Run** — the extension passes them as environment variables to Playwright automatically.

- Values are **cached for the session** — you only need to enter them once per VS Code window.
- The password field is masked for security.
- The Run button is disabled until all required fields are filled.

> **Note:** If you run tests directly from the terminal (outside the extension), you'll need to set the environment variables manually. They follow the format `SF_UI_RECORDER_<PARAM_NAME>` (uppercased):
>
> ```bash
> # macOS / Linux
> export SF_UI_RECORDER_USERNAME="user@mail.com"
> export SF_UI_RECORDER_PASSWORD="yourpassword"
>
> # Windows (PowerShell)
> $env:SF_UI_RECORDER_USERNAME = "user@mail.com"
> $env:SF_UI_RECORDER_PASSWORD = "yourpassword"
>
> # Windows (Command Prompt)
> set SF_UI_RECORDER_USERNAME=user@mail.com
> set SF_UI_RECORDER_PASSWORD=yourpassword
> ```

## Utility Features

> **Important:** Parameterizing a step and re-converting to Playwright will **overwrite** your `.spec.js` file. Any manual edits you have made to the generated script will be lost. If you need to customize a test beyond what parameterization offers, do so *after* you are finished parameterizing all steps.

### Parameterize a Step

Replace a recorded value with a dynamic variable — useful for making tests reusable across environments or with randomized data.

1. Open a recording `.json` file in the editor.
2. Look for the **CodeLens** action above each input step (e.g., "Parameterize Username").
3. Click the CodeLens link and choose a mode:
  - **Config Variable** — the value is read from an environment variable (`SF_UI_RECORDER_<NAME>`) at runtime. Useful for credentials or org-specific values.
  - **Random Data** — generates a random value each run. Supports types like email, phone, number, string, date, currency, URL, and more. You'll be prompted for type-specific options (e.g., domain for emails, min/max for numbers).
  - **Remove Parameterization** — reverts the step back to its original recorded value.
4. After parameterizing, the `.spec.js` file is automatically regenerated.

### Re-convert to Playwright

Regenerate the `.spec.js` test file from the recording JSON. Useful after manually editing the JSON or after parameterizing steps.

1. Open a recording `.json` file.
2. Click the **"Re-convert to Playwright"** CodeLens link at the top of the file.
3. The corresponding `.spec.js` is regenerated and opened in the editor.

### Install Agentforce Vibes MCP Server Config

Set up the Model Context Protocol (MCP) integration for use with Agentforce AI tooling.

1. Open the Command Palette and run **"SF UI Recorder: Install Agentforce MCP Server Config"**.
2. The extension writes the MCP server configuration to the appropriate platform-specific location.
3. A notification confirms success with an option to open the config file.

# Using with Agentforce Vibes

If you prefer a conversational workflow, you can control SF UI Recorder through natural language prompts in Agentforce Vibes. After installing the MCP server config (see above), the following capabilities are available:

## Record

Start a recording session by asking Agentforce to record. A browser window will launch and you interact with it just like a manual recording.

**Example prompts:**

- "Start a recording at [https://myorg.salesforce.com](https://myorg.salesforce.com)"

## Playback

Run a previously recorded test by asking Agentforce to play it back.

**Example prompts:**

- "Run the most recent recording"
- "Play back recording_2025-05-15.spec.js in headed mode"

## Convert

Regenerate a Playwright test script from a recording JSON file.

**Example prompts:**

- "Convert my latest recording to a test script"
- "Re-convert recording_2025-05-15.json"

## List Recordings

See all available recordings in your workspace.

**Example prompts:**

- "What recordings do I have?"
- "List all my recorded tests"

> **Note:** The MCP integration communicates with the VS Code extension in the background. Your editor must be open with the SF UI Recorder extension active for Agentforce Vibes commands to work.

# Known Limitations

- **Hover interactions are not captured.** UI elements that only appear on hover (e.g., tooltips, dropdown menus triggered by mouseover) will not be recorded. Tests that depend on these elements will fail during playback. Hover event support is not yet available.
- **MFA requires manual verification on first recording.** During your first recording session, you will need to manually complete the MFA challenge. On subsequent recordings and playbacks, MFA should be bypassed automatically — the extension saves the MFA cookie in `auth-state.json` for reuse, as long as you are on the same user account. The auth state is continuously updated after each successful login, so the cookie should stay fresh. If issues arise, you may need to manually enter the MFA code again during recording and/or playback.
- **One-time UI elements will cause playback failures.** If you interact with transient elements during recording — such as popovers, toast notifications, or first-time-use prompts — those steps will likely fail on playback since the elements won't be present on subsequent runs. For now, you will need to manually remove those steps from the recording JSON. Automatic detection and filtering of one-time elements is planned for a future release.
