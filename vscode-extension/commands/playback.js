const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Session cache for parameter values (cleared when extension reloads)
const paramCache = new Map();

function register(context) {
  return vscode.commands.registerCommand(
    'sf-ui-recorder.playbackScript',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('SF UI Recorder: No file open.');
        return;
      }

      const specPath = editor.document.uri.fsPath;

      if (!specPath.endsWith('.spec.js')) {
        vscode.window.showErrorMessage('SF UI Recorder: This command only works on .spec.js files.');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('SF UI Recorder: Please open a workspace folder first.');
        return;
      }

      await ensureUtilityFiles(specPath);

      // Parse spec file for config.get('...') parameters
      const specContent = fs.readFileSync(specPath, 'utf-8');
      const paramMatches = [...specContent.matchAll(/config\.get\(['"]([^'"]+)['"]\)/g)];
      const paramNames = [...new Set(paramMatches.map((m) => m[1]))];

      // Show webview form for playback options + parameters (pre-filled from cache)
      const cachedValues = {};
      for (const name of paramNames) {
        if (paramCache.has(name)) {
          cachedValues[name] = paramCache.get(name);
        }
      }

      const result = await showPlaybackForm(context, paramNames, cachedValues);
      if (!result) return;

      const { params } = result;

      // Cache parameter values for this session
      for (const [name, value] of Object.entries(params)) {
        if (value) paramCache.set(name, value);
      }

      // Build env vars from parameter values
      const envVars = {};
      for (const [paramName, value] of Object.entries(params)) {
        envVars[`SF_UI_RECORDER_${paramName.toUpperCase()}`] = value;
      }

      const specFileName = path.basename(specPath);
      const playwrightArgs = ['playwright', 'test', specFileName];

      const terminal = vscode.window.createTerminal({
        name: 'SF UI Recorder: Playback',
        cwd: workspaceFolder.uri.fsPath,
        env: envVars,
      });
      terminal.show();
      terminal.sendText(`npx ${playwrightArgs.join(' ')}`);
    }
  );
}

function showPlaybackForm(context, paramNames, cachedValues) {
  return new Promise((resolve) => {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const panel = vscode.window.createWebviewPanel(
      'sfUiRecorderPlayback',
      'Playback Options',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(path.join(extensionRoot, 'images'))],
      }
    );

    const iconUri = panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(extensionRoot, 'images', 'icon.png'))
    );

    panel.webview.html = getWebviewHtml(paramNames, cachedValues, iconUri);

    let resolved = false;

    panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'run') {
        resolved = true;
        panel.dispose();
        resolve(message.data);
      } else if (message.type === 'cancel') {
        resolved = true;
        panel.dispose();
        resolve(null);
      }
    });

    panel.onDidDispose(() => {
      if (!resolved) resolve(null);
    });
  });
}

function getWebviewHtml(paramNames, cachedValues = {}, iconUri) {
  const paramFields = paramNames
    .map(
      (name) => `
      <div class="field">
        <label for="param-${name}">${name}</label>
        <input type="${name === 'password' ? 'password' : 'text'}" id="param-${name}" name="${name}" placeholder="${name}" value="${escapeHtml(cachedValues[name] || '')}" required />
      </div>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
      margin: 0;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 18px;
    }
    .header img {
      width: 48px;
      height: 48px;
    }
    h2 {
      margin: 0;
      font-size: 1.2em;
      font-weight: 600;
    }
    .field {
      margin-bottom: 14px;
    }
    .field label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
    }
    .field input[type="text"],
    .field input[type="password"] {
      width: 100%;
      max-width: 350px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, #ccc);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #000);
      border-radius: 3px;
      font-size: inherit;
      box-sizing: border-box;
    }
    .field input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      border-color: var(--vscode-focusBorder);
    }
    .buttons {
      display: flex;
      gap: 10px;
      margin-top: 20px;
    }
    button {
      padding: 8px 16px;
      border: none;
      border-radius: 3px;
      font-size: inherit;
      cursor: pointer;
    }
    button.primary {
      background: transparent;
      color: #4ec963;
      border: 1.5px solid #4ec963;
      border-radius: 5px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    button.primary:hover:not(:disabled) {
      background: rgba(78, 201, 99, 0.1);
    }
    button.primary:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="SF UI Recorder" />
    <h2>Playback Options</h2>
  </div>

  ${paramNames.length > 0 ? paramFields : '<p>No parameters required. Press Run to start.</p>'}

  <div class="buttons">
    <button class="primary" id="run-btn" ${paramNames.length > 0 ? 'disabled' : ''}><svg width="12" height="14" viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 1.5L10.5 7L1.5 12.5V1.5Z" stroke="#4ec963" stroke-width="1.5" stroke-linejoin="round"/></svg> Run</button>
    <button class="secondary" id="cancel-btn">Cancel</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const paramNames = ${JSON.stringify(paramNames)};
    const runBtn = document.getElementById('run-btn');

    function validateForm() {
      const allFilled = paramNames.every((name) => {
        return document.getElementById('param-' + name).value.trim() !== '';
      });
      runBtn.disabled = !allFilled;
    }

    // Validate on every input change
    paramNames.forEach((name) => {
      document.getElementById('param-' + name).addEventListener('input', validateForm);
    });

    // Run initial validation (handles pre-filled cached values)
    validateForm();

    runBtn.addEventListener('click', () => {
      if (runBtn.disabled) return;
      const params = {};
      paramNames.forEach((name) => {
        params[name] = document.getElementById('param-' + name).value;
      });
      vscode.postMessage({ type: 'run', data: { params } });
    });

    document.getElementById('cancel-btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !runBtn.disabled) {
        runBtn.click();
      } else if (e.key === 'Escape') {
        document.getElementById('cancel-btn').click();
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function ensureUtilityFiles(specPath) {
  const recordingsDir = path.dirname(specPath);
  const configDir = path.join(recordingsDir, 'config');
  const configPath = path.join(configDir, 'config.js');

  if (fs.existsSync(configPath)) return;

  const choice = await vscode.window.showWarningMessage(
    'SF UI Recorder: The config file required by this script is missing.',
    'Create File',
    'Cancel'
  );

  if (choice !== 'Create File') return;

  fs.mkdirSync(configDir, { recursive: true });
  const sourceConfigPath = path.resolve(__dirname, '..', 'config', 'config.js');
  fs.copyFileSync(sourceConfigPath, configPath);

  vscode.window.showInformationMessage(
    'SF UI Recorder: Created config/config.js in recordings folder.'
  );
}

module.exports = { register };
