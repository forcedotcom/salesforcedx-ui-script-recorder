/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { ensurePlaywrightConfig } = require('../ensure-playwright-config');
const { clearInProgress } = require('./results-viewer');
const { listSalesforceCliOrgs } = require('../sf-cli');

// Session cache for parameter values (cleared when extension reloads)
const paramCache = new Map();

// Singleton playback panel tracking
let activePlaybackPanel = null;
let playbackInProgress = false;
let previousTaskExecutions = [];

// Credential-like parameter names that belong in user-files (not data-files)
const CREDENTIAL_PARAMS = new Set(['username', 'password', 'user', 'pass', 'email', 'login']);

function isCredentialParam(name) {
  return CREDENTIAL_PARAMS.has(name.toLowerCase());
}

// True when playback-results/ contains at least one completed run whose folder
// matches this spec (folders are named "<specName>---..." with a results.json,
// or "<specName>---...---BULK/" with session subfolders).
function specHasResults(workspacePath, specPath) {
  const resultsDir = path.join(workspacePath, 'playback-results');
  if (!fs.existsSync(resultsDir)) return false;
  const specName = path.basename(specPath).replace(/\.spec\.js$/, '');
  try {
    const entries = fs.readdirSync(resultsDir);
    return entries.some((entry) => {
      if (entry.split('---')[0] !== specName) return false;
      const full = path.join(resultsDir, entry);
      try {
        if (!fs.statSync(full).isDirectory()) return false;
        if (fs.existsSync(path.join(full, 'results.json'))) return true;
        // Nested BULK folder — check for session subfolders with results
        if (entry.endsWith('---BULK')) {
          return fs.readdirSync(full).some((sub) => {
            return fs.existsSync(path.join(full, sub, 'results.json'));
          });
        }
        return false;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function register(context) {
  return vscode.commands.registerCommand(
    'salesforce-ui-script-recorder.playbackScript',
    async () => {
      if (playbackInProgress) {
        vscode.window.showInformationMessage('Salesforce UI Script Recorder: A playback is already running. Please wait for it to finish before starting another.');
        return;
      }

      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('Salesforce UI Script Recorder: No file open.');
        return;
      }

      const specPath = editor.document.uri.fsPath;

      if (!specPath.endsWith('.spec.js')) {
        vscode.window.showErrorMessage('Salesforce UI Script Recorder: This command only works on .spec.js files.');
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('Salesforce UI Script Recorder: Please open a workspace folder first.');
        return;
      }

      ensurePlaywrightConfig(workspaceFolder.uri.fsPath, context.extensionPath);

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

      // List Salesforce CLI-authenticated orgs for the org selector — additive
      // alongside username/password params, so users on orgs with 2FA/SSO can
      // skip the login form entirely. Non-fatal if "sf" isn't installed: the
      // selector just shows the error inline and playback falls back to
      // credentials as before.
      let availableOrgs = [];
      let orgListError = null;
      try {
        availableOrgs = await listSalesforceCliOrgs();
      } catch (err) {
        orgListError = err.message;
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
        workspacePath,
        usersDir,
        dataDir,
        specPath,
        specFileName: path.basename(specPath),
        availableOrgs,
        orgListError,
      });
      if (!result) return;

      // Use the spec path from the form (may have changed via recording dropdown)
      const activeSpecPath = result.specPath || specPath;

      playbackInProgress = true;

      // Close terminals from previous playback runs
      for (const prev of previousTaskExecutions) {
        prev.terminate();
      }
      previousTaskExecutions = [];

      const specFileName = path.basename(activeSpecPath);
      const headless = result.headed === false;
      const playwrightArgs = ['playwright', 'test', specFileName];
      if (!headless) playwrightArgs.push('--headed');

      // Same org, N sessions: every spawned Playwright process (single or
      // bulk) resolves its own fresh frontdoor URL from this one org, so
      // there's no shared/racing session state across parallel sessions.
      const selectedOrg = result.org || null;

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

        // Spawn parallel tasks with cycling
        const count = parallelCount;
        const userRowCount = userRows.length;
        const dataRowCount = dataRows.length;

        if (userRowCount > 0 && userRowCount < count) {
          vscode.window.showWarningMessage(
            `Salesforce UI Script Recorder: User file has ${userRowCount} row${userRowCount === 1 ? '' : 's'} but ${count} sessions requested — credentials will cycle.`
          );
        }
        if (dataRowCount > 0 && dataRowCount < count) {
          vscode.window.showWarningMessage(
            `Salesforce UI Script Recorder: Data files have ${dataRowCount} row${dataRowCount === 1 ? '' : 's'} but ${count} sessions requested — data will cycle.`
          );
        }

        const batchId = Date.now().toString(36);
        const batchTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const specBaseName = path.basename(activeSpecPath).replace(/\.spec\.js$/, '');
        const bulkFolder = `${specBaseName}---${batchTimestamp}---BULK`;

        let pendingCount = count;
        for (let i = 0; i < count; i++) {
          const envVars = {
            SALESFORCE_UI_SCRIPT_RECORDER_BATCH_ID: batchId,
            SALESFORCE_UI_SCRIPT_RECORDER_BATCH_TIMESTAMP: batchTimestamp,
            SALESFORCE_UI_SCRIPT_RECORDER_SESSION_INDEX: String(i + 1),
            ...(headless && { SALESFORCE_UI_SCRIPT_RECORDER_HEADLESS: '1' }),
            ...(selectedOrg && { SALESFORCE_UI_SCRIPT_RECORDER_ORG: selectedOrg }),
          };
          const userRow = userRowCount > 0 ? userRows[i % userRowCount] : {};
          for (const [key, value] of Object.entries(userRow)) {
            envVars[`SALESFORCE_UI_SCRIPT_RECORDER_${key.toUpperCase()}`] = value;
          }
          const dataRow = dataRowCount > 0 ? dataRows[i % dataRowCount] : {};
          for (const [key, value] of Object.entries(dataRow)) {
            envVars[`SALESFORCE_UI_SCRIPT_RECORDER_${key.toUpperCase()}`] = value;
          }

          // Resolve auth state for this session's username
          const sessionUsername = userRow.username || userRow.email || userRow.user;
          const sessionAuthState = resolveAuthState(workspacePath, activeSpecPath, sessionUsername);
          if (sessionAuthState) envVars.SALESFORCE_UI_SCRIPT_RECORDER_AUTH_STATE = sessionAuthState;

          // Each bulk session gets its own outputDir — Playwright wipes and
          // recreates the shared outputDir on every invocation, so sessions
          // launched concurrently against the same folder race on that
          // cleanup and can fail with ENOENT mid-run.
          const sessionArgs = [...playwrightArgs, '--output', `.salesforce-ui-script-recorder/test-output/session-${i + 1}`];

          runPlaybackTask(`Bulk #${i + 1}`, workspacePath, sessionArgs, envVars, () => {
            pendingCount--;
            if (pendingCount === 0) {
              playbackInProgress = false;
              clearInProgress();
            }
          });
        }

        // Open results viewer with in-progress state
        vscode.commands.executeCommand('salesforce-ui-script-recorder.viewResults', {
          specUri: vscode.Uri.file(activeSpecPath),
          inProgress: {
            specName: specBaseName,
            mode: 'bulk',
            sessions: count,
            bulkFolder,
            startTime: new Date().toISOString(),
          },
        });
      } else {
        const { params } = result;

        // Cache parameter values for this session
        for (const [name, value] of Object.entries(params)) {
          if (value) paramCache.set(name, value);
        }

        // Build env vars from parameter values
        const envVars = {};
        if (headless) envVars.SALESFORCE_UI_SCRIPT_RECORDER_HEADLESS = '1';
        if (selectedOrg) envVars.SALESFORCE_UI_SCRIPT_RECORDER_ORG = selectedOrg;
        for (const [paramName, value] of Object.entries(params)) {
          envVars[`SALESFORCE_UI_SCRIPT_RECORDER_${paramName.toUpperCase()}`] = value;
        }

        // Resolve auth state for this spec + username
        const username = params.username || params.email || params.user;
        const authStatePath = resolveAuthState(workspacePath, activeSpecPath, username);
        if (authStatePath) envVars.SALESFORCE_UI_SCRIPT_RECORDER_AUTH_STATE = authStatePath;

        const specBaseName = path.basename(activeSpecPath).replace(/\.spec\.js$/, '');

        runPlaybackTask('Playback', workspacePath, playwrightArgs, envVars, () => {
          playbackInProgress = false;
          clearInProgress();
        });

        vscode.commands.executeCommand('salesforce-ui-script-recorder.viewResults', {
          specUri: vscode.Uri.file(activeSpecPath),
          inProgress: {
            specName: specBaseName,
            mode: 'single',
            sessions: 1,
            startTime: new Date().toISOString(),
          },
        });
      }
    }
  );
}

// Resolve the auth-state file for a spec given a username.
// Auth states are stored as: auth-states/<hostname>---<username>.json
function resolveAuthState(workspacePath, specPath, username) {
  if (!username) return null;
  const authDir = path.join(workspacePath, 'auth-states');
  if (!fs.existsSync(authDir)) return null;

  const specContent = fs.readFileSync(specPath, 'utf-8');
  const gotoMatch = specContent.match(/page\.goto\(\s*['"`]([^'"`]+)['"`]/);
  if (!gotoMatch) return null;

  let hostname;
  try {
    hostname = new URL(gotoMatch[1]).hostname;
  } catch {
    return null;
  }

  const sanitizedUsername = username.replace(/[/\\:*?"<>|]/g, '_');
  const fileName = `${hostname}---${sanitizedUsername}.json`;
  const filePath = path.join(authDir, fileName);
  if (fs.existsSync(filePath)) return filePath;

  // Fallback: check for any auth state matching just the hostname
  try {
    const entries = fs.readdirSync(authDir);
    const match = entries.find((f) => f.startsWith(hostname + '---') && f.endsWith('.json'));
    if (match) return path.join(authDir, match);
  } catch {}

  return null;
}

// Runs a playback command as a VS Code Task, which gives us proper process exit detection.
// The onDone callback fires as soon as the process exits (success or failure).
function runPlaybackTask(label, cwd, playwrightArgs, envVars, onDone) {
  const execution = new vscode.ShellExecution(`npx ${playwrightArgs.join(' ')}`, {
    cwd,
    env: envVars,
  });

  const task = new vscode.Task(
    { type: 'salesforce-ui-script-recorder', task: label },
    vscode.TaskScope.Workspace,
    `Salesforce UI Script Recorder: ${label}`,
    'salesforce-ui-script-recorder',
    execution,
    []
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.New,
    close: false,
  };

  vscode.tasks.executeTask(task).then((taskExecution) => {
    previousTaskExecutions.push(taskExecution);
    const listener = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution === taskExecution) {
        listener.dispose();
        previousTaskExecutions = previousTaskExecutions.filter((t) => t !== taskExecution);
        if (onDone) onDone();
      }
    });
  });
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
  const { credentialParams = [], dataParams = [], workspacePath, usersDir, dataDir, specFileName = '' } = bulkOptions;
  let specPath = bulkOptions.specPath;

  // Gather list of available recordings for the dropdown
  const recordingsDir = path.join(workspacePath, 'test-plans', 'playwright');
  let availableRecordings = [];
  if (fs.existsSync(recordingsDir)) {
    availableRecordings = fs.readdirSync(recordingsDir)
      .filter((f) => f.endsWith('.spec.js'))
      .map((f) => f.replace(/\.spec\.js$/, ''))
      .sort();
  }

  // If panel is already open for this same spec, just reveal it
  if (activePlaybackPanel && activePlaybackPanel._specPath === specPath) {
    activePlaybackPanel.reveal(vscode.ViewColumn.Active);
    return new Promise(() => {});
  }

  // Dispose existing panel if it's for a different spec
  if (activePlaybackPanel) {
    activePlaybackPanel.dispose();
    activePlaybackPanel = null;
  }

  return new Promise((resolve) => {
    const extensionRoot = path.resolve(__dirname, '..', '..');
    const panel = vscode.window.createWebviewPanel(
      'salesforceUiScriptRecorderPlayback',
      'Playback Options',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(path.join(extensionRoot, 'images'))],
      }
    );

    activePlaybackPanel = panel;
    panel._specPath = specPath;

    const iconUri = panel.webview.asWebviewUri(
      vscode.Uri.file(path.join(extensionRoot, 'images', 'icon.png'))
    );

    let activeMode = 'single';
    let selectedUserFile = null;
    let selectedDataFiles = [];
    let selectedOrg = null;

    function refreshPanel() {
      const freshUserCsvFiles = fs.existsSync(usersDir)
        ? fs.readdirSync(usersDir).filter((f) => f.endsWith('.csv'))
        : [];
      const freshDataCsvFiles = fs.existsSync(dataDir)
        ? fs.readdirSync(dataDir).filter((f) => f.endsWith('.csv'))
        : [];
      const freshUserCsvMeta = {};
      for (const f of freshUserCsvFiles) {
        const lines = fs.readFileSync(path.join(usersDir, f), 'utf-8').split('\n').filter((l) => l.trim());
        freshUserCsvMeta[f] = { rows: Math.max(0, lines.length - 1) };
      }
      const freshDataCsvMeta = {};
      for (const f of freshDataCsvFiles) {
        const lines = fs.readFileSync(path.join(dataDir, f), 'utf-8').split('\n').filter((l) => l.trim());
        const headers = lines.length > 0 ? lines[0].split(',').map((h) => h.trim()) : [];
        freshDataCsvMeta[f] = { columns: headers, rows: Math.max(0, lines.length - 1) };
      }
      panel.webview.html = getWebviewHtml(paramNames, cachedValues, iconUri, {
        ...bulkOptions,
        userCsvFiles: freshUserCsvFiles,
        dataCsvFiles: freshDataCsvFiles,
        userCsvMeta: freshUserCsvMeta,
        dataCsvMeta: freshDataCsvMeta,
        usersFileExists: freshUserCsvFiles.length > 0,
        dataFileExists: freshDataCsvFiles.length > 0,
        hasResults: specHasResults(workspacePath, specPath),
        activeMode,
        selectedUserFile,
        selectedDataFiles,
        selectedOrg,
        availableRecordings,
      });
    }

    refreshPanel();

    let resolved = false;

    panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'run') {
        resolved = true;
        panel.dispose();
        resolve({ ...message.data, specPath });
      } else if (message.type === 'cancel') {
        resolved = true;
        panel.dispose();
        resolve(null);
      } else if (message.type === 'switchRecording') {
        const newBaseName = message.data;
        const newSpecPath = path.join(workspacePath, 'test-plans', 'playwright', newBaseName + '.spec.js');
        if (fs.existsSync(newSpecPath)) {
          // Rebuild context for new spec in-place
          const newSpecContent = fs.readFileSync(newSpecPath, 'utf-8');
          const newParamMatches = [...newSpecContent.matchAll(/config\.get\(['"]([^'"]+)['"]\)/g)];
          const newParamNames = [...new Set(newParamMatches.map((m) => m[1]))];
          const newCredentialParams = newParamNames.filter((n) => isCredentialParam(n));
          const newDataParams = newParamNames.filter((n) => !isCredentialParam(n));
          const newSpecFileName = newBaseName + '.spec.js';

          // Update closure state
          specPath = newSpecPath;
          bulkOptions.specPath = newSpecPath;
          bulkOptions.specFileName = newSpecFileName;
          bulkOptions.credentialParams = newCredentialParams;
          bulkOptions.dataParams = newDataParams;
          paramNames.length = 0;
          paramNames.push(...newParamNames);
          panel._specPath = newSpecPath;
          activeMode = 'single';
          selectedUserFile = null;
          selectedDataFiles = [];

          // Re-render
          const freshUserCsvFiles = fs.existsSync(usersDir)
            ? fs.readdirSync(usersDir).filter((f) => f.endsWith('.csv'))
            : [];
          const freshDataCsvFiles = fs.existsSync(dataDir)
            ? fs.readdirSync(dataDir).filter((f) => f.endsWith('.csv'))
            : [];
          const freshUserCsvMeta = {};
          for (const f of freshUserCsvFiles) {
            const lines = fs.readFileSync(path.join(usersDir, f), 'utf-8').split('\n').filter((l) => l.trim());
            freshUserCsvMeta[f] = { rows: Math.max(0, lines.length - 1) };
          }
          const freshDataCsvMeta = {};
          for (const f of freshDataCsvFiles) {
            const lines = fs.readFileSync(path.join(dataDir, f), 'utf-8').split('\n').filter((l) => l.trim());
            const headers = lines.length > 0 ? lines[0].split(',').map((h) => h.trim()) : [];
            freshDataCsvMeta[f] = { columns: headers, rows: Math.max(0, lines.length - 1) };
          }
          panel.webview.html = getWebviewHtml(newParamNames, {}, iconUri, {
            credentialParams: newCredentialParams,
            dataParams: newDataParams,
            workspacePath,
            usersDir,
            dataDir,
            specPath: newSpecPath,
            specFileName: newSpecFileName,
            userCsvFiles: freshUserCsvFiles,
            dataCsvFiles: freshDataCsvFiles,
            userCsvMeta: freshUserCsvMeta,
            dataCsvMeta: freshDataCsvMeta,
            usersFileExists: freshUserCsvFiles.length > 0,
            dataFileExists: freshDataCsvFiles.length > 0,
            hasResults: specHasResults(workspacePath, newSpecPath),
            activeMode,
            selectedUserFile,
            selectedDataFiles,
            selectedOrg,
            availableOrgs: bulkOptions.availableOrgs,
            orgListError: bulkOptions.orgListError,
            availableRecordings,
          });
        }
      } else if (message.type === 'openSpecFile') {
        if (specPath && fs.existsSync(specPath)) {
          vscode.workspace.openTextDocument(specPath).then((doc) => {
            vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
          });
        }
      } else if (message.type === 'openHistory') {
        // Open the Playback Results panel focused on this spec's runs.
        vscode.commands.executeCommand('salesforce-ui-script-recorder.viewResults', vscode.Uri.file(specPath));
      } else if (message.type === 'openFile') {
        const filePath = path.join(workspacePath, message.data);
        if (fs.existsSync(filePath)) {
          vscode.workspace.openTextDocument(filePath).then((doc) => {
            vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
          });
        }
      } else if (message.type === 'revealFolder') {
        vscode.commands.executeCommand('salesforce-ui-script-recorder.revealFileSection', message.data);
      } else if (message.type === 'modeChange') {
        activeMode = message.data;
      } else if (message.type === 'dataSelectionChange') {
        selectedDataFiles = message.data;
      } else if (message.type === 'userSelectionChange') {
        selectedUserFile = message.data;
      } else if (message.type === 'orgSelectionChange') {
        selectedOrg = message.data || null;
      } else if (message.type === 'generateUsersFile') {
        const filename = message.data?.filename || 'users.csv';
        const currentCredParams = bulkOptions.credentialParams || credentialParams;
        generateSkeletonCsv(workspacePath, 'user-files', filename, currentCredParams.length > 0 ? currentCredParams : ['username', 'password']);
        vscode.window.showInformationMessage(`Salesforce UI Script Recorder: Created user-files/${filename}`);
        vscode.workspace.openTextDocument(path.join(usersDir, filename)).then((doc) => {
          vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
        selectedUserFile = filename;
        refreshPanel();
      } else if (message.type === 'generateDataFile') {
        const currentDataParams = bulkOptions.dataParams || dataParams;
        const columns = message.data?.columns?.length > 0 ? message.data.columns : (currentDataParams.length > 0 ? currentDataParams : ['param1', 'param2']);
        const filename = message.data?.filename || 'data.csv';
        generateSkeletonCsv(workspacePath, 'data-files', filename, columns);
        vscode.window.showInformationMessage(`Salesforce UI Script Recorder: Created data-files/${filename}`);
        vscode.workspace.openTextDocument(path.join(dataDir, filename)).then((doc) => {
          vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        });
        selectedDataFiles = [...selectedDataFiles, filename];
        refreshPanel();
      }
    });

    // Watch CSV directories for changes and refresh
    const usersPattern = new vscode.RelativePattern(workspacePath, 'user-files/*.csv');
    const dataPattern = new vscode.RelativePattern(workspacePath, 'data-files/*.csv');
    const usersWatcher = vscode.workspace.createFileSystemWatcher(usersPattern);
    const dataWatcher = vscode.workspace.createFileSystemWatcher(dataPattern);

    const onCsvChange = () => { if (!resolved) refreshPanel(); };
    usersWatcher.onDidChange(onCsvChange);
    usersWatcher.onDidCreate(onCsvChange);
    usersWatcher.onDidDelete(onCsvChange);
    dataWatcher.onDidChange(onCsvChange);
    dataWatcher.onDidCreate(onCsvChange);
    dataWatcher.onDidDelete(onCsvChange);

    panel.onDidDispose(() => {
      activePlaybackPanel = null;
      usersWatcher.dispose();
      dataWatcher.dispose();
      if (!resolved) resolve(null);
    });
  });
}

function getWebviewHtml(paramNames, cachedValues = {}, iconUri, bulkOptions = {}) {
  const { credentialParams = [], dataParams = [], usersFileExists = false, dataFileExists = false, userCsvFiles = [], dataCsvFiles = [], userCsvMeta = {}, dataCsvMeta = {}, activeMode = 'single', selectedUserFile = null, selectedDataFiles = [], selectedOrg = null, availableOrgs = [], orgListError = null, specFileName = '', hasResults = false, availableRecordings = [] } = bulkOptions;

  const orgOptions = availableOrgs
    .map(
      (o) => `<option value="${escapeHtml(o.username)}"${o.username === selectedOrg ? ' selected' : ''}>${escapeHtml(o.alias || o.username)} — ${escapeHtml(o.instanceUrl)}</option>`
    )
    .join('');

  const orgField = `
      <div class="field" id="org-field">
        <label for="org-select">Salesforce CLI org <span class="hint">(optional — skips the login form, no credentials or MFA needed)</span></label>
        <select id="org-select" class="recording-select" style="width: 100%; max-width: 350px;">
          <option value="">None — use credentials below</option>
          ${orgOptions}
        </select>
        ${orgListError ? `<div class="field-error">${escapeHtml(orgListError)}</div>` : ''}
      </div>`;

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
    .header-actions {
      margin-left: auto;
    }
    .history-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
      border-radius: 5px;
      background: transparent;
      color: var(--vscode-textLink-foreground, #3794ff);
      font-size: 0.85em;
      cursor: pointer;
    }
    .history-btn:hover {
      background: rgba(55, 148, 255, 0.1);
      border-color: var(--vscode-focusBorder, #3794ff);
    }
    .history-btn svg { flex-shrink: 0; }
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
    .headed-toggle {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-top: 18px;
      margin-bottom: 4px;
    }
    .headed-toggle label {
      font-size: 0.85em;
      color: var(--vscode-foreground);
      cursor: pointer;
      user-select: none;
    }
    .toggle-switch {
      position: relative;
      width: 36px;
      height: 20px;
      flex-shrink: 0;
    }
    .toggle-switch input {
      opacity: 0;
      width: 0;
      height: 0;
    }
    .toggle-slider {
      position: absolute;
      inset: 0;
      background: var(--vscode-input-background, rgba(128,128,128,0.3));
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.4));
      border-radius: 10px;
      cursor: pointer;
      transition: background 0.2s;
    }
    .toggle-slider::before {
      content: '';
      position: absolute;
      width: 14px;
      height: 14px;
      left: 2px;
      top: 2px;
      background: var(--vscode-foreground);
      border-radius: 50%;
      transition: transform 0.2s;
    }
    .toggle-switch input:checked + .toggle-slider {
      background: rgba(78, 201, 99, 0.3);
      border-color: #4ec963;
    }
    .toggle-switch input:checked + .toggle-slider::before {
      transform: translateX(16px);
      background: #4ec963;
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
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
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
    .dropdown-divider {
      border: none;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
      margin: 6px 0 0;
    }
    .dropdown-create-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      font-size: 0.85em;
      color: var(--vscode-textLink-foreground, #3794ff);
      cursor: pointer;
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
      font-family: var(--vscode-editor-font-family, monospace);
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
      font-family: var(--vscode-font-family, sans-serif);
      font-weight: bold;
    }
    .hint {
      font-weight: normal;
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .file-badge {
      font-weight: normal;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      background: rgba(128,128,128,0.1);
      border: 1px solid rgba(128,128,128,0.2);
      padding: 2px 8px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      vertical-align: middle;
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .file-badge:hover {
      background: rgba(128,128,128,0.2);
      border-color: rgba(128,128,128,0.4);
      color: var(--vscode-foreground);
    }
    .folder-badge {
      font-weight: normal;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      background: rgba(128,128,128,0.1);
      border: 1px solid rgba(128,128,128,0.2);
      padding: 1px 6px;
      border-radius: 3px;
      margin-left: 6px;
      font-family: var(--vscode-editor-font-family, monospace);
      cursor: pointer;
      transition: all 0.1s ease;
    }
    .folder-badge:hover {
      background: rgba(128,128,128,0.2);
      border-color: rgba(128,128,128,0.4);
      color: var(--vscode-foreground);
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
      font-size: 1.3em;
      align-self: center;
    }
    .cycle-warning ul {
      margin: 4px 0 0;
      padding-left: 16px;
      list-style: none;
    }
    .cycle-warning li {
      margin-bottom: 2px;
    }
    .cycle-warning li::before {
      content: '•';
      margin-right: 6px;
      opacity: 0.6;
    }
    .cycle-warning code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: rgba(204, 167, 0, 0.12);
      padding: 1px 4px;
      border-radius: 3px;
      color: #cca700;
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
      margin-left: 8px;
      opacity: 0.6;
      width: 6px;
      height: 6px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(45deg);
      display: inline-block;
      position: relative;
      top: -2px;
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
      padding: 7px 10px;
      cursor: pointer;
      font-size: inherit;
    }
    .multi-select-option:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    .multi-select-option.selected {
      background: var(--vscode-list-activeSelectionBackground, rgba(55, 148, 255, 0.15));
    }
    .multi-select-option input[type="checkbox"] {
      display: none;
    }
    .multi-select-option.hidden {
      display: none;
    }
    .chip-trigger {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 5px 8px;
      min-height: 32px;
      border: 1px solid var(--vscode-input-border, #ccc);
      background: var(--vscode-input-background, #fff);
      border-radius: 3px;
      cursor: pointer;
      box-sizing: border-box;
      max-width: 350px;
    }
    .chip-trigger:hover:not(.disabled) {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .chip-trigger.disabled {
      opacity: 0.5;
      cursor: default;
    }
    .chip-trigger .placeholder {
      color: var(--vscode-input-placeholderForeground, rgba(128,128,128,0.6));
      font-size: inherit;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: var(--vscode-badge-background, rgba(128,128,128,0.2));
      color: var(--vscode-badge-foreground, inherit);
      padding: 2px 6px 2px 8px;
      border-radius: 3px;
      font-size: 0.85em;
    }
    .chip-remove {
      cursor: pointer;
      opacity: 0.6;
      font-size: 1.1em;
      line-height: 1;
      padding: 0 2px;
    }
    .chip-remove:hover {
      opacity: 1;
    }
    .chip-trigger .arrow {
      margin-left: auto;
      opacity: 0.6;
      width: 6px;
      height: 6px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(45deg);
      display: inline-block;
      position: relative;
      top: -2px;
    }
    .warning-file-link {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      cursor: pointer;
      text-decoration: underline;
      text-decoration-style: dotted;
      text-underline-offset: 2px;
      position: relative;
      transition: opacity 0.1s ease;
    }
    .warning-file-link:hover {
      opacity: 0.8;
    }
    .warning-file-link::after {
      content: 'Edit CSV';
      position: absolute;
      bottom: calc(100% + 4px);
      left: 50%;
      transform: translateX(-50%);
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-foreground, #ccc);
      padding: 3px 8px;
      border-radius: 3px;
      font-size: 0.85em;
      white-space: nowrap;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
    }
    .warning-file-link:hover::after {
      opacity: 1;
    }
    .recording-select {
      font-size: 0.85em;
      font-weight: 500;
      padding: 3px 8px;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.35));
      border-radius: 4px;
      background: var(--vscode-input-background, transparent);
      color: var(--vscode-foreground);
      cursor: pointer;
      max-width: 300px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .recording-select:hover {
      border-color: var(--vscode-focusBorder, #3794ff);
    }
    .recording-select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      border-color: var(--vscode-focusBorder);
    }
    .custom-parameters-heading {
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
    <img src="${iconUri}" alt="Salesforce UI Script Recorder" />
    <h2>Playback —
      <select id="recording-select" class="recording-select">
        ${availableRecordings.map((r) => `<option value="${escapeHtml(r)}"${r === specFileName.replace(/\.spec\.js$/, '') ? ' selected' : ''}>${escapeHtml(r)}</option>`).join('')}
      </select>
    </h2>
    ${hasResults ? `
    <div class="header-actions">
      <button class="history-btn" id="history-btn" title="View playback history for this recording">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 4v4l2.5 1.5M8 1.5a6.5 6.5 0 1 0 6.5 6.5A6.5 6.5 0 0 0 8 1.5Z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        View History
      </button>
    </div>` : ''}
  </div>

  <div class="section">
    ${orgField}

    <div class="mode-switch">
      <button id="mode-single" class="${activeMode === 'single' ? 'active' : ''}">&#9655; Single Run</button>
      <button id="mode-bulk" class="${activeMode === 'bulk' ? 'active' : ''}">&#9776; Bulk / Parallel</button>
    </div>

    <div id="single-content" class="mode-content${activeMode === 'single' ? ' active' : ''}">
      <p class="description">Run the test once with the credentials and parameters below.</p>
      ${paramNames.length > 0 ? `
        ${credentialFields}
        ${dataParams.length > 0 ? `
        <div class="custom-parameters-heading">Custom Parameters</div>
        ${customParamFields}` : ''}
      ` : '<p>No parameters required. Press Run to start.</p>'}
    </div>

    <div id="bulk-content" class="mode-content${activeMode === 'bulk' ? ' active' : ''}">
      <p class="description">
        Run multiple sessions in parallel. Credentials and data are assigned per session from the CSV rows — if there are more sessions than rows, values cycle from the beginning.
      </p>

      <div class="field">
        <label for="users-file-select">User credentials <span class="folder-badge" data-folder="user-files">&#128193; user-files/</span></label>
        <div class="multi-select" id="users-file-select">
          <div class="multi-select-trigger" id="users-select-trigger">
            <span class="multi-select-text${selectedUserFile ? ' has-selection' : ''}">${selectedUserFile ? escapeHtml(selectedUserFile) : 'Select user file...'}</span>
            <span class="multi-select-arrow"></span>
          </div>
          <div class="multi-select-dropdown" id="users-select-dropdown">
            ${userCsvFiles.map((f) => `
              <label class="multi-select-option${f === selectedUserFile ? ' selected' : ''}" data-value="${escapeHtml(f)}" data-rows="${userCsvMeta[f]?.rows || 0}">
                <span>${escapeHtml(f)}</span>
              </label>
            `).join('')}
            <hr class="dropdown-divider" /><div class="dropdown-create-btn" id="gen-users-btn"><strong style="font-size: 1.2em;">+</strong>&thinsp;Create CSV</div>
          </div>
        </div>
        <div class="user-count" id="user-count" style="display: ${selectedUserFile ? 'flex' : 'none'};">
          <span class="user-count-icon">&#10003;</span>
          <span id="user-count-text">${selectedUserFile ? `${userCsvMeta[selectedUserFile]?.rows || 0} user account${(userCsvMeta[selectedUserFile]?.rows || 0) === 1 ? '' : 's'} loaded` : ''}</span>
        </div>
        <div class="cycle-warning" id="user-cycle-warning" style="display: none;">
          <span class="cycle-warning-icon">&#9888;</span>
          <span id="user-cycle-warning-text"></span>
        </div>
      </div>

      <div class="field">
        <label for="data-files-select">Custom parameter data <span class="folder-badge" data-folder="data-files">&#128193; data-files/</span></label>
        ${dataParams.length > 0 ? `
        <div class="multi-select" id="data-files-select">
          <div class="chip-trigger" id="data-select-trigger">
            ${selectedDataFiles.length > 0
              ? selectedDataFiles.map((f) => `<span class="chip" data-value="${escapeHtml(f)}">${escapeHtml(f)} <span class="chip-remove">&times;</span></span>`).join('')
              : '<span class="placeholder">Select data files...</span>'}
            <span class="arrow"></span>
          </div>
          <div class="multi-select-dropdown" id="data-select-dropdown">
            ${dataCsvFiles.map((f) => `
              <label class="multi-select-option${selectedDataFiles.includes(f) ? ' hidden' : ''}" data-value="${escapeHtml(f)}" data-columns="${escapeHtml(JSON.stringify(dataCsvMeta[f]?.columns || []))}" data-rows="${dataCsvMeta[f]?.rows || 0}">
                <span>${escapeHtml(f)}</span>
              </label>
            `).join('')}
            <hr class="dropdown-divider" /><div class="dropdown-create-btn" id="create-data-btn"><strong style="font-size: 1.2em;">+</strong>&thinsp;Create CSV</div>
          </div>
        </div>
        <div class="param-coverage" id="param-coverage">
          ${dataParams.map((p) => `<span class="param-item uncovered" data-param="${escapeHtml(p)}"><span class="param-icon">&#10007;</span> ${escapeHtml(p)}</span>`).join('')}
        </div>
        ` : `
        <div class="chip-trigger disabled">
          <span class="placeholder">No custom parameters in this script</span>
        </div>
        `}
        <div class="cycle-warning" id="cycle-warning" style="display: none;">
          <span class="cycle-warning-icon">&#9888;</span>
          <span id="cycle-warning-text"></span>
        </div>
        <div class="cycle-warning" id="overlap-warning" style="display: none;">
          <span class="cycle-warning-icon">&#9888;</span>
          <span id="overlap-warning-text"></span>
        </div>
      </div>

      <div class="field">
        <label for="parallel-count">Sessions</label>
        <input type="number" id="parallel-count" min="1" max="100" value="2" style="width: 80px;" />
        <div class="field-error" id="parallel-error" style="display: none;"></div>
      </div>
    </div>

    <div class="headed-toggle">
      <label class="toggle-switch">
        <input type="checkbox" id="headed-toggle" ${activeMode === 'bulk' ? '' : 'checked'} />
        <span class="toggle-slider"></span>
      </label>
      <label for="headed-toggle">Headed (show browser)</label>
    </div>

    <div class="buttons">
      <button class="primary" id="run-btn" ${paramNames.length > 0 ? 'disabled' : ''}><svg width="12" height="14" viewBox="0 0 12 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 1.5L10.5 7L1.5 12.5V1.5Z" stroke="#4ec963" stroke-width="1.5" stroke-linejoin="round"/></svg> Run</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const paramNames = ${JSON.stringify(paramNames)};
    const dataParamNames = ${JSON.stringify(dataParams)};
    const existingUserFiles = ${JSON.stringify(userCsvFiles)};
    const existingDataFiles = ${JSON.stringify(dataCsvFiles)};
    const runBtn = document.getElementById('run-btn');
    const modeSingleBtn = document.getElementById('mode-single');
    const modeBulkBtn = document.getElementById('mode-bulk');
    const singleContent = document.getElementById('single-content');
    const bulkContent = document.getElementById('bulk-content');
    function makeFileLink(filePath, displayName) {
      return '<span class="warning-file-link" data-file="' + filePath + '">' + displayName + '</span>';
    }

    let mode = '${activeMode}';

    const orgSelect = document.getElementById('org-select');
    if (orgSelect) {
      orgSelect.addEventListener('change', () => {
        vscode.postMessage({ type: 'orgSelectionChange', data: orgSelect.value });
      });
    }

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
      const initialSelected = usersDropdown.querySelector('.multi-select-option.selected');
      if (initialSelected) {
        selectedUserFile = initialSelected.dataset.value;
        selectedUserRows = parseInt(initialSelected.dataset.rows, 10) || 0;
      }

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
          vscode.postMessage({ type: 'userSelectionChange', data: selectedUserFile });
          updateCycleWarning();
          validateForm();
        });
      });

      document.getElementById('gen-users-btn').addEventListener('click', () => {
        usersDropdown.classList.remove('open');
        showUsersWizard();
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

    // Chip-based multi-select for data files
    const trigger = document.getElementById('data-select-trigger');
    const dropdown = document.getElementById('data-select-dropdown');
    let dataSelected = ${JSON.stringify(selectedDataFiles)};

    function getSelectedOptions() {
      return dataSelected.map((val) => dropdown?.querySelector('.multi-select-option[data-value="' + val + '"]')).filter(Boolean);
    }

    function renderChips() {
      const chips = trigger.querySelectorAll('.chip');
      chips.forEach((c) => c.remove());
      const placeholder = trigger.querySelector('.placeholder');
      if (dataSelected.length === 0) {
        if (!placeholder) {
          const ph = document.createElement('span');
          ph.className = 'placeholder';
          ph.textContent = 'Select data files...';
          trigger.insertBefore(ph, trigger.querySelector('.arrow'));
        }
      } else {
        if (placeholder) placeholder.remove();
        const arrow = trigger.querySelector('.arrow');
        dataSelected.forEach((val) => {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.dataset.value = val;
          chip.innerHTML = val + ' <span class="chip-remove">&times;</span>';
          trigger.insertBefore(chip, arrow);
        });
      }
      // Hide/show options in dropdown
      if (dropdown) {
        dropdown.querySelectorAll('.multi-select-option').forEach((opt) => {
          opt.classList.toggle('hidden', dataSelected.includes(opt.dataset.value));
        });
      }
    }

    function addDataFile(val) {
      if (!dataSelected.includes(val)) dataSelected.push(val);
      renderChips();
      onDataSelectionChange();
    }

    function removeDataFile(val) {
      dataSelected = dataSelected.filter((v) => v !== val);
      renderChips();
      onDataSelectionChange();
    }

    function onDataSelectionChange() {
      vscode.postMessage({ type: 'dataSelectionChange', data: dataSelected });
      updateParamCoverage();
      updateOverlapWarning();
      updateCycleWarning();
      validateForm();
    }

    function updateParamCoverage() {
      if (dataParamNames.length === 0) return;
      const selectedOpts = getSelectedOptions();
      const coveredColumns = new Set();
      selectedOpts.forEach((opt) => {
        const cols = JSON.parse(opt.dataset.columns || '[]');
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

    function updateOverlapWarning() {
      const warningEl = document.getElementById('overlap-warning');
      const warningText = document.getElementById('overlap-warning-text');
      if (!warningEl) return;
      const selectedOpts = getSelectedOptions();
      if (selectedOpts.length < 2) {
        warningEl.style.display = 'none';
        return;
      }
      const fileColumns = {};
      selectedOpts.forEach((opt) => {
        const cols = JSON.parse(opt.dataset.columns || '[]');
        fileColumns[opt.dataset.value] = cols;
      });
      const seen = {};
      const overlaps = {};
      for (const [file, cols] of Object.entries(fileColumns)) {
        for (const col of cols) {
          if (seen[col]) {
            if (!overlaps[col]) overlaps[col] = [seen[col]];
            overlaps[col].push(file);
          } else {
            seen[col] = file;
          }
        }
      }
      const overlapKeys = Object.keys(overlaps);
      if (overlapKeys.length === 0) {
        warningEl.style.display = 'none';
        return;
      }
      const items = overlapKeys.map((col) => {
        const lastFile = overlaps[col][overlaps[col].length - 1];
        return '<li><code>' + col + '</code> — using ' + makeFileLink('data-files/' + lastFile, lastFile) + '</li>';
      });
      warningEl.style.display = 'flex';
      warningText.innerHTML = 'Overlapping columns (last file takes precedence):<ul>' + items.join('') + '</ul>';
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
          userWarningText.innerHTML = makeFileLink('user-files/' + selectedUserFile, selectedUserFile) + ' has ' + userRows + ' row' + (userRows === 1 ? '' : 's') + ' but ' + parallel + ' sessions requested — credentials will cycle.';
        } else {
          userWarningEl.style.display = 'none';
        }
      }

      // Data file cycle warning
      const dataWarningEl = document.getElementById('cycle-warning');
      const dataWarningText = document.getElementById('cycle-warning-text');
      if (!dataWarningEl) return;
      const selectedOpts = getSelectedOptions();
      if (selectedOpts.length === 0) {
        dataWarningEl.style.display = 'none';
        return;
      }
      const shortFiles = selectedOpts
        .filter((opt) => {
          const rows = parseInt(opt.dataset.rows, 10) || 0;
          return rows > 0 && rows < parallel;
        })
        .map((opt) => {
          const name = opt.dataset.value;
          const rows = opt.dataset.rows;
          return '<li>' + makeFileLink('data-files/' + name, name) + ' — ' + rows + ' row' + (rows === '1' ? '' : 's') + '</li>';
        });
      if (shortFiles.length > 0) {
        dataWarningEl.style.display = 'flex';
        dataWarningText.innerHTML = parallel + ' sessions requested but these files will cycle:<ul>' + shortFiles.join('') + '</ul>';
      } else {
        dataWarningEl.style.display = 'none';
      }
    }

    if (trigger && dropdown) {
      trigger.addEventListener('click', (e) => {
        if (e.target.closest('.chip-remove')) {
          const chip = e.target.closest('.chip');
          if (chip) removeDataFile(chip.dataset.value);
          return;
        }
        dropdown.classList.toggle('open');
      });
      document.addEventListener('click', (e) => {
        if (!e.target.closest('#data-files-select')) {
          dropdown.classList.remove('open');
        }
      });
      dropdown.querySelectorAll('.multi-select-option').forEach((opt) => {
        opt.addEventListener('click', () => {
          addDataFile(opt.dataset.value);
          dropdown.classList.remove('open');
        });
      });
    }

    function setMode(newMode) {
      mode = newMode;
      modeSingleBtn.classList.toggle('active', mode === 'single');
      modeBulkBtn.classList.toggle('active', mode === 'bulk');
      singleContent.classList.toggle('active', mode === 'single');
      bulkContent.classList.toggle('active', mode === 'bulk');
      document.getElementById('headed-toggle').checked = mode === 'single';
      updateHeadedLabel();
      vscode.postMessage({ type: 'modeChange', data: mode });
      validateForm();
    }

    modeSingleBtn.addEventListener('click', () => setMode('single'));
    modeBulkBtn.addEventListener('click', () => setMode('bulk'));

    const headedToggle = document.getElementById('headed-toggle');
    const headedLabel = document.querySelector('label[for="headed-toggle"]');
    function updateHeadedLabel() {
      headedLabel.textContent = headedToggle.checked ? 'Headed (show browser)' : 'Headless (hidden browser)';
    }
    headedToggle.addEventListener('change', updateHeadedLabel);
    updateHeadedLabel();

    function validateForm() {
      if (mode === 'bulk') {
        const hasUsers = selectedUserRows > 0;
        let allParamsCovered = true;
        if (dataParamNames.length > 0) {
          const selectedOpts = getSelectedOptions();
          const coveredColumns = new Set();
          selectedOpts.forEach((opt) => {
            const cols = JSON.parse(opt.dataset.columns || '[]');
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
        errorEl.textContent = 'Maximum is 100 sessions.';
        errorEl.style.display = 'block';
        return false;
      }
      errorEl.style.display = 'none';
      return true;
    }

    paramNames.forEach((name) => {
      document.getElementById('param-' + name).addEventListener('input', validateForm);
    });

    updateParamCoverage();
    updateOverlapWarning();
    updateCycleWarning();
    validateForm();

    runBtn.addEventListener('click', () => {
      if (runBtn.disabled) return;
      const headed = document.getElementById('headed-toggle').checked;
      const org = orgSelect ? orgSelect.value || null : null;
      if (mode === 'single') {
        const params = {};
        paramNames.forEach((name) => {
          params[name] = document.getElementById('param-' + name).value;
        });
        vscode.postMessage({ type: 'run', data: { params, headed, org } });
      } else {
        const parallelCount = document.getElementById('parallel-count').value;
        const usersFile = selectedUserFile;
        vscode.postMessage({ type: 'run', data: { mode: 'bulk', parallelCount: parseInt(parallelCount, 10), usersFile, dataFiles: dataSelected, headed, org } });
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
            <label>File name <span class="hint">(.csv)</span></label>
            <input type="text" id="wizard-filename" value="data" />
            <div class="field-error" id="wizard-filename-error" style="display: none;"></div>
          </div>
          <div class="wizard-actions">
            <button class="primary" id="wizard-create">Create</button>
            <button class="secondary" id="wizard-cancel">Cancel</button>
          </div>
        </div>
      \`;
      document.body.appendChild(overlay);

      const input = overlay.querySelector('#wizard-filename');
      const createBtn = overlay.querySelector('#wizard-create');
      const errorEl = overlay.querySelector('#wizard-filename-error');

      function validateWizard() {
        const raw = input.value.trim();
        if (!raw) {
          errorEl.textContent = 'File name is required.';
          errorEl.style.display = 'block';
          createBtn.disabled = true;
          return;
        }
        const filename = raw.endsWith('.csv') ? raw : raw + '.csv';
        if (existingDataFiles.includes(filename)) {
          errorEl.textContent = filename + ' already exists.';
          errorEl.style.display = 'block';
          createBtn.disabled = true;
          return;
        }
        errorEl.style.display = 'none';
        createBtn.disabled = false;
      }

      input.addEventListener('input', validateWizard);
      validateWizard();

      overlay.querySelector('#wizard-cancel').addEventListener('click', () => {
        overlay.remove();
      });
      createBtn.addEventListener('click', () => {
        if (createBtn.disabled) return;
        const selected = [...overlay.querySelectorAll('.wizard-params input:checked')].map((cb) => cb.value);
        const raw = input.value.trim() || 'data';
        const filename = raw.endsWith('.csv') ? raw : raw + '.csv';
        overlay.remove();
        vscode.postMessage({ type: 'generateDataFile', data: { columns: selected, filename } });
      });
    }

    function showUsersWizard() {
      const overlay = document.createElement('div');
      overlay.className = 'wizard-overlay';
      overlay.innerHTML = \`
        <div class="wizard-panel">
          <h3>Create Users CSV</h3>
          <p class="description">This will create a credentials file with username and password columns.</p>
          <div class="wizard-filename">
            <label>File name <span class="hint">(.csv)</span></label>
            <input type="text" id="wizard-users-filename" value="users" />
            <div class="field-error" id="wizard-users-error" style="display: none;"></div>
          </div>
          <div class="wizard-actions">
            <button class="primary" id="wizard-users-create">Create</button>
            <button class="secondary" id="wizard-users-cancel">Cancel</button>
          </div>
        </div>
      \`;
      document.body.appendChild(overlay);

      const input = overlay.querySelector('#wizard-users-filename');
      const createBtn = overlay.querySelector('#wizard-users-create');
      const errorEl = overlay.querySelector('#wizard-users-error');

      function validateWizard() {
        const raw = input.value.trim();
        if (!raw) {
          errorEl.textContent = 'File name is required.';
          errorEl.style.display = 'block';
          createBtn.disabled = true;
          return;
        }
        const filename = raw.endsWith('.csv') ? raw : raw + '.csv';
        if (existingUserFiles.includes(filename)) {
          errorEl.textContent = filename + ' already exists.';
          errorEl.style.display = 'block';
          createBtn.disabled = true;
          return;
        }
        errorEl.style.display = 'none';
        createBtn.disabled = false;
      }

      input.addEventListener('input', validateWizard);
      validateWizard();

      overlay.querySelector('#wizard-users-cancel').addEventListener('click', () => {
        overlay.remove();
      });
      createBtn.addEventListener('click', () => {
        if (createBtn.disabled) return;
        const raw = input.value.trim() || 'users';
        const filename = raw.endsWith('.csv') ? raw : raw + '.csv';
        overlay.remove();
        vscode.postMessage({ type: 'generateUsersFile', data: { filename } });
      });
    }

    document.getElementById('recording-select').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'switchRecording', data: e.target.value });
    });

    document.addEventListener('click', (e) => {
      const historyBtn = e.target.closest('#history-btn');
      if (historyBtn) {
        vscode.postMessage({ type: 'openHistory' });
        return;
      }
      const fileLink = e.target.closest('.warning-file-link');
      if (fileLink) {
        vscode.postMessage({ type: 'openFile', data: fileLink.dataset.file });
        return;
      }
      const folderBadge = e.target.closest('.folder-badge');
      if (folderBadge) {
        vscode.postMessage({ type: 'revealFolder', data: folderBadge.dataset.folder });
      }
    });

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

module.exports = { register };
