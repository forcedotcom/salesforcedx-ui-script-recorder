const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Session cache for parameter values (cleared when extension reloads)
const paramCache = new Map();

// Credential-like parameter names that belong in user-files (not data-files)
const CREDENTIAL_PARAMS = new Set(['username', 'password', 'user', 'pass', 'email', 'login']);

function isCredentialParam(name) {
  return CREDENTIAL_PARAMS.has(name.toLowerCase());
}

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

      // Separate credential params (for user-files) from data params (for data-files)
      const credentialParams = paramNames.filter((n) => isCredentialParam(n));
      const dataParams = paramNames.filter((n) => !isCredentialParam(n));

      // Scan for available CSV files and parse metadata
      const workspacePath = workspaceFolder.uri.fsPath;
      const usersDir = path.join(workspacePath, 'user-files');
      const dataDir = path.join(workspacePath, 'data-files');
      const userCsvFiles = fs.existsSync(usersDir)
        ? fs.readdirSync(usersDir).filter((f) => f.endsWith('.csv'))
        : [];
      const dataCsvFiles = fs.existsSync(dataDir)
        ? fs.readdirSync(dataDir).filter((f) => f.endsWith('.csv'))
        : [];
      const usersFileExists = userCsvFiles.length > 0;
      const dataFileExists = dataCsvFiles.length > 0;

      const userCsvMeta = {};
      for (const f of userCsvFiles) {
        const lines = fs.readFileSync(path.join(usersDir, f), 'utf-8').split('\n').filter((l) => l.trim());
        userCsvMeta[f] = { rows: Math.max(0, lines.length - 1) };
      }

      const dataCsvMeta = {};
      for (const f of dataCsvFiles) {
        const lines = fs.readFileSync(path.join(dataDir, f), 'utf-8').split('\n').filter((l) => l.trim());
        const headers = lines.length > 0 ? lines[0].split(',').map((h) => h.trim()) : [];
        dataCsvMeta[f] = { columns: headers, rows: Math.max(0, lines.length - 1) };
      }

      // Show webview form for playback options + parameters (pre-filled from cache)
      const cachedValues = {};
      for (const name of paramNames) {
        if (paramCache.has(name)) {
          cachedValues[name] = paramCache.get(name);
        }
      }

      const result = await showPlaybackForm(context, paramNames, cachedValues, {
        credentialParams,
        dataParams,
        usersFileExists,
        dataFileExists,
        userCsvFiles,
        dataCsvFiles,
        userCsvMeta,
        dataCsvMeta,
        specFileName: path.basename(specPath),
      });
      if (!result) return;

      // Handle file generation requests from the webview
      if (result.generateUsersFile) {
        generateSkeletonCsv(workspacePath, 'user-files', 'users.csv', credentialParams.length > 0 ? credentialParams : ['username', 'password']);
        vscode.window.showInformationMessage('SF UI Recorder: Created user-files/users.csv');
        const doc = await vscode.workspace.openTextDocument(path.join(usersDir, 'users.csv'));
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        return;
      }

      if (result.generateDataFile) {
        const columns = result.columns && result.columns.length > 0 ? result.columns : (dataParams.length > 0 ? dataParams : ['param1', 'param2']);
        const filename = result.filename || 'data.csv';
        generateSkeletonCsv(workspacePath, 'data-files', filename, columns);
        vscode.window.showInformationMessage(`SF UI Recorder: Created data-files/${filename}`);
        const doc = await vscode.workspace.openTextDocument(path.join(dataDir, filename));
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        return;
      }

      const specFileName = path.basename(specPath);
      const playwrightArgs = ['playwright', 'test', specFileName];

      if (result.mode === 'bulk') {
        const { parallelCount, usersFile, dataFiles } = result;

        // Parse user credentials CSV
        const userRows = parseCsv(path.join(usersDir, usersFile));

        // Parse and merge all selected data files
        const dataRows = [];
        for (const df of dataFiles) {
          const rows = parseCsv(path.join(dataDir, df));
          rows.forEach((row, i) => {
            if (!dataRows[i]) dataRows[i] = {};
            Object.assign(dataRows[i], row);
          });
        }

        // Spawn parallel terminals with cycling
        const count = parallelCount;
        const userRowCount = userRows.length;
        const dataRowCount = dataRows.length;

        if (userRowCount > 0 && userRowCount < count) {
          vscode.window.showWarningMessage(
            `SF UI Recorder: User file has ${userRowCount} row${userRowCount === 1 ? '' : 's'} but ${count} sessions requested — credentials will cycle.`
          );
        }
        if (dataRowCount > 0 && dataRowCount < count) {
          vscode.window.showWarningMessage(
            `SF UI Recorder: Data files have ${dataRowCount} row${dataRowCount === 1 ? '' : 's'} but ${count} sessions requested — data will cycle.`
          );
        }

        for (let i = 0; i < count; i++) {
          const envVars = {};
          const userRow = userRowCount > 0 ? userRows[i % userRowCount] : {};
          for (const [key, value] of Object.entries(userRow)) {
            envVars[`SF_UI_RECORDER_${key.toUpperCase()}`] = value;
          }
          const dataRow = dataRowCount > 0 ? dataRows[i % dataRowCount] : {};
          for (const [key, value] of Object.entries(dataRow)) {
            envVars[`SF_UI_RECORDER_${key.toUpperCase()}`] = value;
          }

          const terminal = vscode.window.createTerminal({
            name: `SF UI Recorder: Bulk #${i + 1}`,
            cwd: workspacePath,
            env: envVars,
          });
          terminal.show();
          terminal.sendText(`npx ${playwrightArgs.join(' ')}`);
        }
      } else {
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

        const terminal = vscode.window.createTerminal({
          name: 'SF UI Recorder: Playback',
          cwd: workspacePath,
          env: envVars,
        });
        terminal.show();
        terminal.sendText(`npx ${playwrightArgs.join(' ')}`);
      }
    }
  );
}

function parseCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
}

function generateSkeletonCsv(workspacePath, dirName, fileName, columns) {
  const dir = path.join(workspacePath, dirName);
  const filePath = path.join(dir, fileName);
  fs.mkdirSync(dir, { recursive: true });

  const header = columns.join(',');
  const sampleRow = columns.map((col) => {
    if (col.toLowerCase().includes('password')) return 'changeme123';
    if (col.toLowerCase().includes('username') || col.toLowerCase().includes('email')) return 'user1@example.com';
    return `sample_${col}`;
  }).join(',');

  fs.writeFileSync(filePath, `${header}\n${sampleRow}\n`, 'utf-8');
}

function showPlaybackForm(context, paramNames, cachedValues, bulkOptions = {}) {
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

    panel.webview.html = getWebviewHtml(paramNames, cachedValues, iconUri, bulkOptions);

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
      } else if (message.type === 'generateUsersFile') {
        resolved = true;
        panel.dispose();
        resolve({ generateUsersFile: true });
      } else if (message.type === 'generateDataFile') {
        resolved = true;
        panel.dispose();
        resolve({ generateDataFile: true, columns: message.data?.columns, filename: message.data?.filename });
      }
    });

    panel.onDidDispose(() => {
      if (!resolved) resolve(null);
    });
  });
}

function getWebviewHtml(paramNames, cachedValues = {}, iconUri, bulkOptions = {}) {
  const { credentialParams = [], dataParams = [], usersFileExists = false, dataFileExists = false, userCsvFiles = [], dataCsvFiles = [], userCsvMeta = {}, dataCsvMeta = {}, specFileName = '' } = bulkOptions;

  const credentialFields = credentialParams
    .map(
      (name) => `
      <div class="field">
        <label for="param-${name}">${name}</label>
        <input type="${name === 'password' ? 'password' : 'text'}" id="param-${name}" name="${name}" placeholder="${name}" value="${escapeHtml(cachedValues[name] || '')}" required />
      </div>`
    )
    .join('');

  const customParamFields = dataParams
    .map(
      (name) => `
      <div class="field">
        <label for="param-${name}">${name}</label>
        <input type="text" id="param-${name}" name="${name}" placeholder="${name}" value="${escapeHtml(cachedValues[name] || '')}" required />
      </div>`
    )
    .join('');

  const usersFileStatus = usersFileExists
    ? '<span class="file-status exists">✓ user-files/users.csv exists</span>'
    : `<button class="generate-btn" id="gen-users-btn">Generate user-files/users.csv</button>`;

  const dataFileStatus = dataFileExists
    ? '<span class="file-status exists">✓ data-files/data.csv exists</span>'
    : `<button class="generate-btn" id="gen-data-btn">Generate data-files/data.csv</button>`;

  const usersColumns = credentialParams.length > 0 ? credentialParams.join(', ') : 'username, password';
  const dataColumns = dataParams.length > 0 ? dataParams.join(', ') : 'param1, param2';

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
    .section {
      margin-bottom: 24px;
    }
    .section-title {
      font-size: 0.9em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
      padding-bottom: 6px;
      border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
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
    .field input[type="password"],
    .field input[type="number"] {
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
    .section {
      padding: 0;
    }
    .description {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 14px;
      line-height: 1.5;
    }
    .mode-switch {
      display: inline-flex;
      margin-bottom: 18px;
      background: var(--vscode-input-background, rgba(128,128,128,0.1));
      border-radius: 6px;
      padding: 3px;
      gap: 2px;
    }
    .mode-switch button {
      padding: 6px 18px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-foreground);
      font-size: 0.85em;
      font-weight: 500;
      cursor: pointer;
      opacity: 0.5;
      transition: all 0.15s ease;
    }
    .mode-switch button:hover:not(.active) {
      opacity: 0.75;
    }
    .mode-switch button.active {
      background: var(--vscode-editor-background, #fff);
      box-shadow: 0 1px 3px rgba(0,0,0,0.15);
      opacity: 1;
      font-weight: 600;
    }
    .mode-content { display: none; }
    .mode-content.active { display: block; }
    .dropdown-create-btn {
      padding: 8px 10px;
      font-size: 0.85em;
      color: var(--vscode-textLink-foreground, #3794ff);
      cursor: pointer;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      margin-top: 4px;
    }
    .dropdown-create-btn:hover {
      background: rgba(55, 148, 255, 0.1);
    }
    .wizard-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 200;
    }
    .wizard-panel {
      background: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
      border-radius: 8px;
      padding: 20px;
      min-width: 300px;
      max-width: 400px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
    }
    .wizard-panel h3 {
      margin: 0 0 8px;
      font-size: 1.1em;
      font-weight: 600;
    }
    .wizard-params {
      margin: 12px 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .wizard-param-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 0.9em;
    }
    .wizard-param-option:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    .wizard-param-option input[type="checkbox"] {
      margin: 0;
      cursor: pointer;
    }
    .wizard-filename {
      margin: 14px 0;
    }
    .wizard-filename label {
      display: block;
      margin-bottom: 4px;
      font-weight: 500;
      font-size: 0.9em;
    }
    .wizard-filename input {
      width: 100%;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, #ccc);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #000);
      border-radius: 3px;
      font-size: inherit;
      box-sizing: border-box;
    }
    .wizard-actions {
      display: flex;
      gap: 10px;
      margin-top: 16px;
    }
    .user-count {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      font-size: 0.85em;
      color: #4ec963;
    }
    .user-count-icon {
      font-weight: bold;
    }
    .param-coverage {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
    }
    .param-item {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 0.85em;
      padding: 3px 8px;
      border-radius: 3px;
      background: rgba(128,128,128,0.08);
    }
    .param-item.uncovered {
      color: #f44747;
    }
    .param-item.covered {
      color: #4ec963;
    }
    .param-icon {
      font-weight: bold;
    }
    .hint {
      font-weight: normal;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .field-error {
      font-size: 0.85em;
      color: #f44747;
      margin-top: 4px;
    }
    .cycle-warning {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 10px;
      font-size: 0.85em;
      color: #cca700;
      background: rgba(204, 167, 0, 0.08);
      padding: 6px 10px;
      border-radius: 4px;
    }
    .cycle-warning-icon {
      font-size: 1.1em;
    }
    .multi-select {
      position: relative;
      width: 100%;
      max-width: 350px;
    }
    .multi-select-trigger {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, #ccc);
      background: var(--vscode-input-background, #fff);
      color: var(--vscode-input-foreground, #000);
      border-radius: 3px;
      font-size: inherit;
      cursor: pointer;
      box-sizing: border-box;
    }
    .multi-select-trigger:hover {
      border-color: var(--vscode-focusBorder);
    }
    .multi-select-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      opacity: 0.6;
    }
    .multi-select-text.has-selection {
      opacity: 1;
    }
    .multi-select-arrow {
      font-size: 0.7em;
      margin-left: 8px;
      opacity: 0.6;
    }
    .multi-select-dropdown {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      background: var(--vscode-dropdown-background, var(--vscode-input-background, #fff));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, #ccc));
      border-radius: 3px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 100;
      max-height: 160px;
      overflow-y: auto;
      padding: 4px 0;
    }
    .multi-select-dropdown.open {
      display: block;
    }
    .multi-select-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: inherit;
    }
    .multi-select-option:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    .multi-select-option input[type="checkbox"] {
      margin: 0;
      cursor: pointer;
    }
    .multi-select-option.selected {
      background: var(--vscode-list-activeSelectionBackground, rgba(55, 148, 255, 0.15));
    }
    .custom-params-heading {
      font-size: 0.8em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 10px;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="SF UI Recorder" />
    <h2>Playback — ${escapeHtml(specFileName)}</h2>
  </div>

  <div class="section">
    <div class="mode-switch">
      <button id="mode-single" class="active">&#9655; Single Run</button>
      <button id="mode-bulk">&#9776; Bulk / Parallel</button>
    </div>

    <div id="single-content" class="mode-content active">
      <p class="description">Run the test once with the credentials and parameters below.</p>
      ${paramNames.length > 0 ? `
        ${credentialFields}
        ${dataParams.length > 0 ? `
        <div class="custom-params-heading">Custom Params</div>
        ${customParamFields}` : ''}
      ` : '<p>No parameters required. Press Run to start.</p>'}
    </div>

    <div id="bulk-content" class="mode-content">
      <p class="description">
        Run multiple test instances in parallel. Credentials and data are assigned per session from the CSV rows — if there are more sessions than rows, values cycle from the beginning.
      </p>

      <div class="field">
        <label for="users-file-select">User credentials <span class="hint">(user-files/)</span></label>
        <div class="multi-select" id="users-file-select">
          <div class="multi-select-trigger" id="users-select-trigger">
            <span class="multi-select-text">Select user file...</span>
            <span class="multi-select-arrow">&#9662;</span>
          </div>
          <div class="multi-select-dropdown" id="users-select-dropdown">
            ${userCsvFiles.map((f) => `
              <label class="multi-select-option" data-value="${escapeHtml(f)}" data-rows="${userCsvMeta[f]?.rows || 0}">
                <span>${escapeHtml(f)}</span>
              </label>
            `).join('')}
            <div class="dropdown-create-btn" id="gen-users-btn">+ Create CSV</div>
          </div>
        </div>
        <div class="user-count" id="user-count" style="display: none;">
          <span class="user-count-icon">&#10003;</span>
          <span id="user-count-text"></span>
        </div>
        <div class="cycle-warning" id="user-cycle-warning" style="display: none;">
          <span class="cycle-warning-icon">&#9888;</span>
          <span id="user-cycle-warning-text"></span>
        </div>
      </div>

      <div class="field">
        <label for="data-files-select">Custom param data <span class="hint">(data-files/)</span></label>
        <div class="multi-select" id="data-files-select">
          <div class="multi-select-trigger" id="data-select-trigger">
            <span class="multi-select-text">Select data files...</span>
            <span class="multi-select-arrow">&#9662;</span>
          </div>
          <div class="multi-select-dropdown" id="data-select-dropdown">
            ${dataCsvFiles.map((f) => `
              <label class="multi-select-option">
                <input type="checkbox" value="${escapeHtml(f)}" data-columns="${escapeHtml(JSON.stringify(dataCsvMeta[f]?.columns || []))}" data-rows="${dataCsvMeta[f]?.rows || 0}" />
                <span>${escapeHtml(f)}</span>
              </label>
            `).join('')}
            <div class="dropdown-create-btn" id="create-data-btn">+ Create CSV</div>
          </div>
        </div>
        ${dataParams.length > 0 ? `
        <div class="param-coverage" id="param-coverage">
          ${dataParams.map((p) => `<span class="param-item uncovered" data-param="${escapeHtml(p)}"><span class="param-icon">&#10007;</span> ${escapeHtml(p)}</span>`).join('')}
        </div>
        ` : ''}
        <div class="cycle-warning" id="cycle-warning" style="display: none;">
          <span class="cycle-warning-icon">&#9888;</span>
          <span id="cycle-warning-text"></span>
        </div>
      </div>

      <div class="field">
        <label for="parallel-count">Parallel scripts</label>
        <input type="number" id="parallel-count" min="1" max="100" value="2" style="width: 80px;" />
        <div class="field-error" id="parallel-error" style="display: none;"></div>
      </div>
    </div>

    <div class="buttons">
      <button class="primary" id="run-btn" ${paramNames.length > 0 ? 'disabled' : ''}><svg width="12" height="14" viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 1.5L10.5 7L1.5 12.5V1.5Z" stroke="#4ec963" stroke-width="1.5" stroke-linejoin="round"/></svg> Run</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const paramNames = ${JSON.stringify(paramNames)};
    const dataParamNames = ${JSON.stringify(dataParams)};
    const runBtn = document.getElementById('run-btn');
    const modeSingleBtn = document.getElementById('mode-single');
    const modeBulkBtn = document.getElementById('mode-bulk');
    const singleContent = document.getElementById('single-content');
    const bulkContent = document.getElementById('bulk-content');
    let mode = 'single';

    // User file custom dropdown
    const usersTrigger = document.getElementById('users-select-trigger');
    const usersDropdown = document.getElementById('users-select-dropdown');
    const userCountEl = document.getElementById('user-count');
    const userCountText = document.getElementById('user-count-text');
    const parallelInput = document.getElementById('parallel-count');
    let selectedUserFile = null;
    let selectedUserRows = 0;

    if (usersTrigger && usersDropdown) {
      const options = usersDropdown.querySelectorAll('.multi-select-option');

      usersTrigger.addEventListener('click', () => {
        usersDropdown.classList.toggle('open');
      });

      options.forEach((opt) => {
        opt.addEventListener('click', () => {
          options.forEach((o) => o.classList.remove('selected'));
          opt.classList.add('selected');
          selectedUserFile = opt.dataset.value;
          selectedUserRows = parseInt(opt.dataset.rows, 10) || 0;
          const textEl = usersTrigger.querySelector('.multi-select-text');
          textEl.textContent = selectedUserFile;
          textEl.classList.add('has-selection');
          usersDropdown.classList.remove('open');
          userCountEl.style.display = 'flex';
          userCountText.textContent = selectedUserRows + ' user account' + (selectedUserRows === 1 ? '' : 's') + ' loaded';
          updateCycleWarning();
          validateForm();
        });
      });

      document.getElementById('gen-users-btn').addEventListener('click', () => {
        usersDropdown.classList.remove('open');
        vscode.postMessage({ type: 'generateUsersFile' });
      });

      document.addEventListener('click', (e) => {
        if (!e.target.closest('#users-file-select')) {
          usersDropdown.classList.remove('open');
        }
      });
    }
    if (parallelInput) {
      parallelInput.addEventListener('input', () => {
        updateCycleWarning();
        validateForm();
      });
    }

    // Multi-select dropdown
    const trigger = document.getElementById('data-select-trigger');
    const dropdown = document.getElementById('data-select-dropdown');

    function updateParamCoverage() {
      if (dataParamNames.length === 0) return;
      const checked = dropdown ? [...dropdown.querySelectorAll('input:checked')] : [];
      const coveredColumns = new Set();
      checked.forEach((cb) => {
        const cols = JSON.parse(cb.dataset.columns || '[]');
        cols.forEach((c) => coveredColumns.add(c));
      });
      dataParamNames.forEach((p) => {
        const el = document.querySelector('.param-item[data-param="' + p + '"]');
        if (!el) return;
        if (coveredColumns.has(p)) {
          el.classList.remove('uncovered');
          el.classList.add('covered');
          el.querySelector('.param-icon').innerHTML = '&#10003;';
        } else {
          el.classList.remove('covered');
          el.classList.add('uncovered');
          el.querySelector('.param-icon').innerHTML = '&#10007;';
        }
      });
    }

    function updateCycleWarning() {
      const parallel = parseInt(parallelInput?.value, 10) || 0;

      // User file cycle warning
      const userWarningEl = document.getElementById('user-cycle-warning');
      const userWarningText = document.getElementById('user-cycle-warning-text');
      if (userWarningEl) {
        const userRows = selectedUserRows;
        if (userRows > 0 && userRows < parallel) {
          userWarningEl.style.display = 'flex';
          userWarningText.textContent = 'User file has ' + userRows + ' row' + (userRows === 1 ? '' : 's') + ' but ' + parallel + ' sessions requested — credentials will cycle from the beginning.';
        } else {
          userWarningEl.style.display = 'none';
        }
      }

      // Data file cycle warning
      const dataWarningEl = document.getElementById('cycle-warning');
      const dataWarningText = document.getElementById('cycle-warning-text');
      if (!dataWarningEl) return;
      const checked = dropdown ? [...dropdown.querySelectorAll('input:checked')] : [];
      if (checked.length === 0) {
        dataWarningEl.style.display = 'none';
        return;
      }
      const maxDataRows = Math.max(...checked.map((cb) => parseInt(cb.dataset.rows, 10) || 0));
      if (maxDataRows > 0 && maxDataRows < parallel) {
        dataWarningEl.style.display = 'flex';
        dataWarningText.textContent = 'Data files have ' + maxDataRows + ' row' + (maxDataRows === 1 ? '' : 's') + ' but ' + parallel + ' sessions requested — data will cycle from the beginning.';
      } else {
        dataWarningEl.style.display = 'none';
      }
    }

    if (trigger && dropdown) {
      trigger.addEventListener('click', () => {
        dropdown.classList.toggle('open');
      });
      document.addEventListener('click', (e) => {
        if (!e.target.closest('#data-files-select')) {
          dropdown.classList.remove('open');
        }
      });
      dropdown.addEventListener('change', () => {
        const checked = [...dropdown.querySelectorAll('input:checked')];
        const textEl = trigger.querySelector('.multi-select-text');
        if (checked.length === 0) {
          textEl.textContent = 'Select data files...';
          textEl.classList.remove('has-selection');
        } else {
          textEl.textContent = checked.map((cb) => cb.value).join(', ');
          textEl.classList.add('has-selection');
        }
        updateParamCoverage();
        updateCycleWarning();
        validateForm();
      });
    }

    function setMode(newMode) {
      mode = newMode;
      modeSingleBtn.classList.toggle('active', mode === 'single');
      modeBulkBtn.classList.toggle('active', mode === 'bulk');
      singleContent.classList.toggle('active', mode === 'single');
      bulkContent.classList.toggle('active', mode === 'bulk');
      validateForm();
    }

    modeSingleBtn.addEventListener('click', () => setMode('single'));
    modeBulkBtn.addEventListener('click', () => setMode('bulk'));

    function validateForm() {
      if (mode === 'bulk') {
        const hasUsers = selectedUserRows > 0;
        let allParamsCovered = true;
        if (dataParamNames.length > 0) {
          const checked = dropdown ? [...dropdown.querySelectorAll('input:checked')] : [];
          const coveredColumns = new Set();
          checked.forEach((cb) => {
            const cols = JSON.parse(cb.dataset.columns || '[]');
            cols.forEach((c) => coveredColumns.add(c));
          });
          allParamsCovered = dataParamNames.every((p) => coveredColumns.has(p));
        }
        const parallelValid = validateParallelInput();
        runBtn.disabled = !(hasUsers && allParamsCovered && parallelValid);
        return;
      }
      const allFilled = paramNames.every((name) => {
        return document.getElementById('param-' + name).value.trim() !== '';
      });
      runBtn.disabled = !allFilled;
    }

    function validateParallelInput() {
      const errorEl = document.getElementById('parallel-error');
      if (!parallelInput || !errorEl) return true;
      const val = parallelInput.value.trim();
      const num = parseInt(val, 10);
      if (val === '' || isNaN(num)) {
        errorEl.textContent = 'Enter a valid number.';
        errorEl.style.display = 'block';
        return false;
      }
      if (num < 1) {
        errorEl.textContent = 'Must be at least 1.';
        errorEl.style.display = 'block';
        return false;
      }
      if (num > 100) {
        errorEl.textContent = 'Maximum is 100 parallel scripts.';
        errorEl.style.display = 'block';
        return false;
      }
      errorEl.style.display = 'none';
      return true;
    }

    paramNames.forEach((name) => {
      document.getElementById('param-' + name).addEventListener('input', validateForm);
    });

    validateForm();

    runBtn.addEventListener('click', () => {
      if (runBtn.disabled) return;
      if (mode === 'single') {
        const params = {};
        paramNames.forEach((name) => {
          params[name] = document.getElementById('param-' + name).value;
        });
        vscode.postMessage({ type: 'run', data: { params } });
      } else {
        const parallelCount = document.getElementById('parallel-count').value;
        const usersFile = selectedUserFile;
        const dataCheckboxes = dropdown ? [...dropdown.querySelectorAll('input:checked')] : [];
        const dataFiles = dataCheckboxes.map((cb) => cb.value);
        vscode.postMessage({ type: 'run', data: { mode: 'bulk', parallelCount: parseInt(parallelCount, 10), usersFile, dataFiles } });
      }
    });

    // Data file create wizard
    const createDataBtn = document.getElementById('create-data-btn');
    if (createDataBtn) {
      createDataBtn.addEventListener('click', () => {
        if (dropdown) dropdown.classList.remove('open');
        showDataWizard();
      });
    }

    function showDataWizard() {
      const overlay = document.createElement('div');
      overlay.className = 'wizard-overlay';
      overlay.innerHTML = \`
        <div class="wizard-panel">
          <h3>Create Data CSV</h3>
          <p class="description">Select the parameters to include as columns in the new data file.</p>
          <div class="wizard-params">
            \${dataParamNames.map((p) => \`
              <label class="wizard-param-option">
                <input type="checkbox" value="\${p}" checked />
                <span>\${p}</span>
              </label>
            \`).join('')}
          </div>
          <div class="wizard-filename">
            <label>File name</label>
            <input type="text" id="wizard-filename" value="data.csv" />
          </div>
          <div class="wizard-actions">
            <button class="primary" id="wizard-create">Create</button>
            <button class="secondary" id="wizard-cancel">Cancel</button>
          </div>
        </div>
      \`;
      document.body.appendChild(overlay);

      overlay.querySelector('#wizard-cancel').addEventListener('click', () => {
        overlay.remove();
      });
      overlay.querySelector('#wizard-create').addEventListener('click', () => {
        const selected = [...overlay.querySelectorAll('.wizard-params input:checked')].map((cb) => cb.value);
        const filename = overlay.querySelector('#wizard-filename').value.trim() || 'data.csv';
        overlay.remove();
        vscode.postMessage({ type: 'generateDataFile', data: { columns: selected, filename } });
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !runBtn.disabled) {
        runBtn.click();
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
    'SF UI Recorder: Created config/config.js in test-plans/playwright folder.'
  );
}

module.exports = { register };
