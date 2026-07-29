const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Singleton panel state
let activePanel = null;
let panelState = null;

function register(context) {
  const cmd = vscode.commands.registerCommand(
    'sf-ui-recorder.viewResults',
    // Optional arg: a spec name (string), a spec file Uri, or an options object
    // { specUri, inProgress } to open the panel with an active run.
    async (arg) => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('SF UI Recorder: Please open a workspace folder first.');
        return;
      }

      const workspacePath = workspaceFolder.uri.fsPath;
      const resultsDir = path.join(workspacePath, 'playback-results');
      fs.mkdirSync(resultsDir, { recursive: true });

      // Handle options object from playback command
      let inProgress = null;
      let specArg = arg;
      if (arg && typeof arg === 'object' && arg.inProgress) {
        inProgress = arg.inProgress;
        specArg = arg.specUri || null;
      }

      const allRuns = loadAllRuns(resultsDir);

      const specName = specNameFromArg(specArg);
      let initialSpec = null;
      if (specName && allRuns.some((r) => runSpecName(r) === specName)) {
        initialSpec = specName;
      }

      // Reuse existing panel if open
      if (activePanel && panelState) {
        activePanel.reveal(vscode.ViewColumn.Active);
        if (initialSpec !== null) panelState.setSpec(initialSpec);
        if (inProgress) panelState.addInProgress(inProgress);
        panelState.refresh();
        return;
      }

      showResultsPanel(context, resultsDir, initialSpec, inProgress);
    }
  );
  return cmd;
}

// Distinct recording (spec) names across all runs, sorted for a stable dropdown.
function listSpecNames(runs) {
  return [...new Set(runs.map((r) => runSpecName(r)).filter(Boolean))].sort();
}

// Derive the spec base name (without .spec.js) from a command argument that may
// be a string spec name, a vscode.Uri, or a { fsPath } / { path } object.
function specNameFromArg(arg) {
  if (!arg) return null;
  if (typeof arg === 'string') {
    return path.basename(arg).replace(/\.spec\.js$/, '');
  }
  const fsPath = arg.fsPath || arg.path;
  if (typeof fsPath === 'string') {
    return path.basename(fsPath).replace(/\.spec\.js$/, '');
  }
  return null;
}

// A run folder is named "<specName>---<timestamp>" (single),
// or bulk runs live under "<specName>---<timestamp>---BULK/session-<n>".
// Legacy flat naming "<specName>---batch-<id>---session-<n>" is also supported.
function runSpecName(run) {
  return (run._dirName || '').split('---')[0];
}

function loadAllRuns(resultsDir) {
  const runs = [];

  for (const entry of fs.readdirSync(resultsDir)) {
    const full = path.join(resultsDir, entry);
    if (!fs.statSync(full).isDirectory()) continue;

    if (entry.endsWith('---BULK')) {
      // Nested bulk folder — each subfolder is a session
      for (const sub of fs.readdirSync(full)) {
        const subFull = path.join(full, sub);
        if (!fs.statSync(subFull).isDirectory()) continue;
        if (!fs.existsSync(path.join(subFull, 'results.json'))) continue;
        const data = JSON.parse(fs.readFileSync(path.join(subFull, 'results.json'), 'utf-8'));
        data._dirName = `${entry}/${sub}`;
        data._bulkParent = entry;
        runs.push(data);
      }
    } else if (fs.existsSync(path.join(full, 'results.json'))) {
      // Single run or legacy flat bulk session
      const data = JSON.parse(fs.readFileSync(path.join(full, 'results.json'), 'utf-8'));
      data._dirName = entry;
      runs.push(data);
    }
  }

  runs.sort((a, b) => (a._dirName || '').localeCompare(b._dirName || ''));
  return runs;
}

function groupRuns(runs) {
  const groups = [];
  const bulkMap = new Map();

  for (const run of runs) {
    const groupKey = run._bulkParent || run.bulkFolder || (run.batchId ? `batch-${run.batchId}` : null);
    if (groupKey) {
      if (!bulkMap.has(groupKey)) {
        const group = { batchId: run.batchId || groupKey, bulkFolder: run._bulkParent || run.bulkFolder || null, runs: [] };
        bulkMap.set(groupKey, group);
        groups.push(group);
      }
      bulkMap.get(groupKey).runs.push(run);
    } else {
      groups.push({ batchId: null, bulkFolder: null, runs: [run] });
    }
  }

  for (const group of groups) {
    if (group.batchId) {
      group.runs.sort((a, b) => (a.sessionIndex || 0) - (b.sessionIndex || 0));
    }
  }

  return groups;
}

function showResultsPanel(context, resultsDir, initialSpec, inProgress = null) {
  const extensionRoot = path.resolve(__dirname, '..', '..');
  const panel = vscode.window.createWebviewPanel(
    'sfUiRecorderResults',
    'Playback Results',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(extensionRoot, 'images')),
        vscode.Uri.file(resultsDir),
      ],
    }
  );

  const iconUri = panel.webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionRoot, 'images', 'icon.png'))
  );

  const resultsBaseUri = panel.webview.asWebviewUri(vscode.Uri.file(resultsDir)).toString();

  let activeInProgress = inProgress ? [inProgress] : [];
  let activeSpec = initialSpec || null;

  const renderPanel = () => {
    const runs = loadAllRuns(resultsDir);
    const specNames = listSpecNames(runs);
    if (activeSpec && !specNames.includes(activeSpec)) activeSpec = null;
    const filtered = activeSpec ? runs.filter((r) => runSpecName(r) === activeSpec) : runs;
    const groups = groupRuns(filtered);

    // Remove in-progress entries whose results have landed
    activeInProgress = activeInProgress.filter((ip) => {
      if (ip.mode === 'bulk' && ip.bulkFolder) {
        const bulkDir = path.join(resultsDir, ip.bulkFolder);
        if (!fs.existsSync(bulkDir)) return true;
        const completed = fs.readdirSync(bulkDir).filter((sub) =>
          fs.existsSync(path.join(bulkDir, sub, 'results.json'))
        ).length;
        return completed < ip.sessions;
      }
      const hasNewResult = runs.some((r) => {
        return runSpecName(r) === ip.specName && new Date(r.timestamp) >= new Date(ip.startTime);
      });
      return !hasNewResult;
    });

    panel.webview.html = getResultsHtml(
      groups,
      iconUri,
      resultsBaseUri,
      panel.webview.cspSource,
      specNames,
      activeSpec,
      activeInProgress
    );
  };

  renderPanel();

  // Watch for new results to auto-refresh
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(resultsDir, '**/results.json')
  );
  const refresh = () => renderPanel();
  watcher.onDidCreate(refresh);
  watcher.onDidChange(refresh);

  // Register as singleton
  activePanel = panel;
  panelState = {
    refresh: renderPanel,
    setSpec(spec) { activeSpec = spec; },
    addInProgress(ip) {
      const isDupe = activeInProgress.some((existing) =>
        existing.specName === ip.specName && existing.startTime === ip.startTime
      );
      if (!isDupe) activeInProgress.push(ip);
    },
  };

  panel.onDidDispose(() => {
    watcher.dispose();
    activePanel = null;
    panelState = null;
  });

  panel.webview.onDidReceiveMessage((message) => {
    if (message.type === 'filterSpec') {
      activeSpec = message.data ? message.data : null;
      renderPanel();
      return;
    }
    if (message.type === 'openFolder') {
      const folderPath = path.join(resultsDir, message.data);
      if (fs.existsSync(folderPath)) {
        vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folderPath));
      }
    } else if (message.type === 'openFile') {
      const filePath = path.join(resultsDir, message.data);
      if (fs.existsSync(filePath)) {
        vscode.workspace.openTextDocument(filePath).then((doc) => {
          vscode.window.showTextDocument(doc, { preview: true });
        });
      } else {
        vscode.window.showWarningMessage(`SF UI Recorder: File not found: ${message.data}`);
      }
    } else if (message.type === 'openImage') {
      const filePath = path.join(resultsDir, message.data);
      if (fs.existsSync(filePath)) {
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), vscode.ViewColumn.Beside);
      } else {
        vscode.window.showWarningMessage(`SF UI Recorder: Screenshot not found: ${message.data}`);
      }
    }
  });
}

function getResultsHtml(groups, iconUri, resultsBaseUri, cspSource, specNames = [], activeSpec = null, inProgress = []) {
  const reversedGroups = [...groups].reverse();

  // Recording filter dropdown: "All recordings" plus one option per spec.
  const options = [
    `<option value=""${!activeSpec ? ' selected' : ''}>All recordings</option>`,
    ...specNames.map((name) => {
      const selected = name === activeSpec ? ' selected' : '';
      return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)}</option>`;
    }),
  ].join('');
  const filterHtml = `
    <div class="filter-row">
      <label class="filter-label" for="spec-filter">Recording</label>
      <select id="spec-filter" class="filter-select">${options}</select>
    </div>`;

  // In-progress section
  const inProgressHtml = inProgress.length > 0 ? inProgress.map((ip) => {
    const label = ip.mode === 'bulk'
      ? `${escapeHtml(ip.specName)} — ${ip.sessions} session${ip.sessions > 1 ? 's' : ''}`
      : escapeHtml(ip.specName);
    const modeLabel = ip.mode === 'bulk' ? 'Bulk' : 'Single';
    const modeBadgeClass = ip.mode === 'bulk' ? 'bulk-badge' : 'single-badge';
    return `
      <div class="run-card in-progress-card">
        <div class="run-header in-progress-header">
          <span class="spinner"></span>
          <span class="${modeBadgeClass}">${modeLabel}</span>
          <span class="run-title">${label}</span>
          <span class="run-meta">Running...</span>
        </div>
      </div>`;
  }).join('') : '';

  const inProgressSection = inProgress.length > 0 ? `
    <div class="in-progress-section">
      <div class="in-progress-label">In Progress</div>
      ${inProgressHtml}
    </div>` : '';

  // All runs, most recent first. The latest is auto-expanded (only if nothing in progress).
  const historyHtml = reversedGroups.map((group, idx) => {
    const startOpen = idx === 0 && inProgress.length === 0;
    if (group.batchId) {
      return renderBatchGroup(group, resultsBaseUri, startOpen);
    }
    return renderSingleRun(group.runs[0], resultsBaseUri, startOpen);
  }).join('');

  const totalRuns = groups.length;
  const passedRuns = groups.filter((g) => g.runs.every((r) => r.status === 'passed')).length;
  const trendDots = groups.map((g) => {
    const passed = g.runs.every((r) => r.status === 'passed');
    return `<span class="dot ${passed ? 'pass' : 'fail'}"></span>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https: data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
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
      margin-bottom: 20px;
    }
    .header img { width: 48px; height: 48px; }
    h2 { margin: 0; font-size: 1.2em; font-weight: 600; }
    .filter-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 18px;
    }
    .filter-label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .filter-select {
      flex: 0 1 320px;
      max-width: 100%;
      padding: 4px 8px;
      font-family: inherit;
      font-size: 0.9em;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, rgba(128,128,128,0.3)));
      border-radius: 4px;
      cursor: pointer;
    }
    .filter-select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .in-progress-section {
      margin-bottom: 20px;
    }
    .in-progress-label {
      font-size: 0.8em;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-textLink-foreground, #3794ff);
      margin-bottom: 8px;
    }
    .in-progress-card {
      border-color: var(--vscode-textLink-foreground, rgba(55, 148, 255, 0.4));
    }
    .in-progress-header {
      cursor: default;
    }
    .in-progress-header:hover {
      background: rgba(128,128,128,0.04);
    }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid rgba(55, 148, 255, 0.2);
      border-top-color: var(--vscode-textLink-foreground, #3794ff);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .trend-bar {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 20px;
      padding: 10px 14px;
      background: rgba(128,128,128,0.06);
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-radius: 6px;
    }
    .trend-label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-right: 10px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
    }
    .dot.pass { background: #4ec963; }
    .dot.fail { background: #f44747; }
    .trend-summary {
      margin-left: auto;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .run-card {
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-radius: 6px;
      margin-bottom: 12px;
      overflow: hidden;
    }
    .run-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      cursor: pointer;
      background: rgba(128,128,128,0.04);
    }
    .run-header:hover {
      background: rgba(128,128,128,0.08);
    }
    .status-badge {
      font-size: 0.75em;
      font-weight: 700;
      padding: 2px 8px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .status-badge.pass {
      background: rgba(78, 201, 99, 0.15);
      color: #4ec963;
    }
    .status-badge.fail {
      background: rgba(244, 71, 71, 0.15);
      color: #f44747;
    }
    .bulk-badge {
      font-size: 0.7em;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(55, 148, 255, 0.15);
      color: var(--vscode-textLink-foreground, #3794ff);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .single-badge {
      font-size: 0.7em;
      font-weight: 600;
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(203, 145, 47, 0.18);
      color: #cb912f;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .run-title {
      font-weight: 500;
      flex: 1;
    }
    .run-meta {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .run-details {
      display: none;
      padding: 12px 14px;
      border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
    }
    .run-details.open { display: block; }
    .session-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid rgba(128,128,128,0.1);
    }
    .session-row:last-child { border-bottom: none; }
    .session-icon { font-size: 1em; }
    .session-icon.pass { color: #4ec963; }
    .session-icon.fail { color: #f44747; }
    .session-icon.timeout { color: #b180d7; }
    .session-label { font-weight: 500; font-size: 0.9em; }
    .session-duration {
      margin-left: auto;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    .session-row.expandable { cursor: pointer; }
    .session-row.expandable:hover { background: rgba(128,128,128,0.06); }
    .session-caret {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      font-size: 1em;
      color: var(--vscode-descriptionForeground);
      transition: transform 0.15s ease;
      transform-origin: center;
    }
    .session-row.open .session-caret { transform: rotate(90deg); }
    .session-detail { display: none; }
    .session-detail.open { display: block; }
    .error-block {
      margin: 6px 0 6px 24px;
      padding: 8px 10px;
      background: rgba(244, 71, 71, 0.06);
      border-left: 3px solid #f44747;
      border-radius: 0 4px 4px 0;
      font-size: 0.85em;
    }
    /* Shared base for ANSI-rendered blocks (message, code frame, stack). */
    .ansi {
      font-family: var(--vscode-editor-font-family, monospace);
      line-height: 1.5;
      tab-size: 2;
    }
    .error-message {
      color: var(--vscode-foreground);
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
    }
    /* Code frame (Playwright snippet) — terminal-like, own scroll for long lines. */
    .code-frame {
      margin: 8px 0 0;
      padding: 10px 12px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.25));
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.2));
      border-radius: 4px;
      font-size: 0.95em;
      white-space: pre;
      overflow-x: auto;
      color: var(--vscode-foreground);
    }
    .error-stack {
      color: var(--vscode-descriptionForeground);
      margin: 6px 0 0;
      padding: 8px 10px;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
      border-radius: 4px;
      font-size: 0.9em;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 260px;
      overflow: auto;
    }
    .stdout-block {
      margin: 6px 0 6px 24px;
      padding: 8px 10px;
      background: rgba(128,128,128,0.06);
      border-left: 3px solid var(--vscode-descriptionForeground);
      border-radius: 0 4px 4px 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.85em;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 150px;
      overflow-y: auto;
    }
    .counts {
      display: flex;
      gap: 12px;
      margin-top: 8px;
      font-size: 0.85em;
    }
    .count-pass { color: #4ec963; }
    .count-fail { color: #f44747; }
    .count-total { color: var(--vscode-descriptionForeground); }
    .folder-link {
      font-size: 0.8em;
      color: var(--vscode-textLink-foreground, #3794ff);
      cursor: pointer;
      margin-top: 8px;
      display: inline-block;
    }
    .folder-link:hover { text-decoration: underline; }
    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }
    .toggle-stack {
      font-size: 0.8em;
      color: var(--vscode-textLink-foreground, #3794ff);
      cursor: pointer;
      margin-top: 4px;
    }
    .toggle-stack:hover { text-decoration: underline; }
    .stack-content { display: none; }
    .stack-content.open { display: block; }


    /* Pass/fail rate bar (bulk runs) */
    .rate {
      margin-top: 10px;
    }
    .rate-track {
      display: flex;
      height: 6px;
      border-radius: 3px;
      overflow: hidden;
      background: rgba(244, 71, 71, 0.25);
    }
    .rate-fill {
      background: #4ec963;
      height: 100%;
    }
    .rate-label {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      display: block;
    }

    /* Screenshots */
    .shots {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 6px 0 6px 24px;
    }
    .shot {
      cursor: zoom-in;
      border: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      overflow: hidden;
      background: rgba(128,128,128,0.06);
    }
    .shot img {
      display: block;
      max-width: 220px;
      max-height: 140px;
      object-fit: cover;
    }
    .shot-caption {
      font-size: 0.72em;
      color: var(--vscode-descriptionForeground);
      padding: 2px 6px;
      max-width: 220px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Lightbox */
    .lightbox {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.8);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      cursor: zoom-out;
      padding: 30px;
    }
    .lightbox.open { display: flex; }
    .lightbox img {
      max-width: 100%;
      max-height: 100%;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5);
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="SF UI Recorder" />
    <h2>Playback Results</h2>
  </div>

  ${filterHtml}

  ${inProgressSection}

  ${totalRuns > 1 ? `
  <div class="trend-bar">
    <span class="trend-label">Trend</span>
    ${trendDots}
    <span class="trend-summary">${passedRuns}/${totalRuns} passed (${Math.round((passedRuns / totalRuns) * 100)}%)</span>
  </div>
  ` : ''}
  ${historyHtml || (inProgress.length === 0 ? '<div class="empty-state">No playback results yet.</div>' : '')}

  <div class="lightbox" id="lightbox"><img id="lightbox-img" src="" alt="Screenshot" /></div>

  <script>
    const vscode = acquireVsCodeApi();

    // Recording filter: re-render server-side with the chosen spec (or all).
    const specFilter = document.getElementById('spec-filter');
    if (specFilter) {
      specFilter.addEventListener('change', () => {
        vscode.postMessage({ type: 'filterSpec', data: specFilter.value });
      });
    }

    // Expand/collapse run cards (ignore clicks on interactive children)
    document.querySelectorAll('.run-header').forEach((header) => {
      header.addEventListener('click', () => {
        const details = header.nextElementSibling;
        if (details) details.classList.toggle('open');
      });
    });

    document.querySelectorAll('.toggle-stack').forEach((toggle) => {
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const stack = toggle.nextElementSibling;
        stack.classList.toggle('open');
        toggle.textContent = stack.classList.contains('open') ? 'Hide stack trace' : 'Show stack trace';
      });
    });

    // Expand/collapse a bulk session's detail (errors, screenshots, stdout).
    document.querySelectorAll('.session-row.expandable').forEach((row) => {
      row.addEventListener('click', () => {
        const detail = row.nextElementSibling;
        if (detail && detail.classList.contains('session-detail')) {
          detail.classList.toggle('open');
          row.classList.toggle('open');
        }
      });
    });

    // Lightbox for screenshots
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    lightbox.addEventListener('click', () => {
      lightbox.classList.remove('open');
      lightboxImg.src = '';
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && lightbox.classList.contains('open')) {
        lightbox.classList.remove('open');
        lightboxImg.src = '';
      }
    });

    document.addEventListener('click', (e) => {
      const folderLink = e.target.closest('.folder-link');
      if (folderLink) {
        e.stopPropagation();
        vscode.postMessage({ type: 'openFolder', data: folderLink.dataset.dir });
        return;
      }
      const shot = e.target.closest('.shot');
      if (shot) {
        e.stopPropagation();
        lightboxImg.src = shot.dataset.src;
        lightbox.classList.add('open');
      }
    });
  </script>
</body>
</html>`;
}

function renderBatchGroup(group, resultsBaseUri, startOpen) {
  const { batchId, bulkFolder, runs } = group;
  const totalSessions = runs.length;
  const passedSessions = runs.filter((r) => r.status === 'passed').length;
  const failedSessions = totalSessions - passedSessions;
  const passRate = totalSessions > 0 ? Math.round((passedSessions / totalSessions) * 100) : 0;
  const overallStatus = passedSessions === totalSessions ? 'pass' : 'fail';
  const date = formatDate(runs[0].timestamp);
  const duration = formatDuration(Math.max(...runs.map((r) => r.duration)));
  const specName = runs[0]._dirName.split('---')[0];
  const folderDir = bulkFolder || runs[0]._bulkParent || runs[0]._dirName;

  const sessionsHtml = runs.map((run) => {
    const icon = run.status === 'passed' ? '&#10003;' : '&#10007;';
    const iconClass = run.status === 'passed' ? 'pass' : (run.status === 'timedOut' ? 'timeout' : 'fail');
    const errorsHtml = renderErrors(run);
    const stdoutHtml = renderStdout(run);
    const shotsHtml = renderRunScreenshots(run, run._dirName, resultsBaseUri);
    const detailHtml = `${errorsHtml}${shotsHtml}${stdoutHtml}`;

    // Sessions with any detail (errors, screenshots, stdout) are expandable and
    // collapsed by default; sessions with nothing to show stay static.
    if (!detailHtml.trim()) {
      return `
      <div class="session-row">
        <span class="session-caret" style="visibility:hidden">&#9656;</span>
        <span class="session-icon ${iconClass}">${icon}</span>
        <span class="session-label">Session ${run.sessionIndex || '?'}</span>
        <span class="session-duration">${formatDuration(run.duration)}</span>
      </div>`;
    }

    return `
      <div class="session-row expandable">
        <span class="session-caret">&#9656;</span>
        <span class="session-icon ${iconClass}">${icon}</span>
        <span class="session-label">Session ${run.sessionIndex || '?'}</span>
        <span class="session-duration">${formatDuration(run.duration)}</span>
      </div>
      <div class="session-detail">${detailHtml}</div>`;
  }).join('');

  return `
  <div class="run-card">
    <div class="run-header">
      <span class="status-badge ${overallStatus}">${overallStatus === 'pass' ? 'Pass' : 'Fail'}</span>
      <span class="bulk-badge">Bulk</span>
      <span class="run-title">${escapeHtml(specName)}</span>
      <span class="run-meta">${date} &middot; ${duration} &middot; ${totalSessions} sessions</span>
    </div>
    <div class="run-details${startOpen ? ' open' : ''}">
      <div class="counts">
        <span class="count-pass">${passedSessions} passed</span>
        ${failedSessions > 0 ? `<span class="count-fail">${failedSessions} failed</span>` : ''}
        <span class="count-total">(${totalSessions} total)</span>
      </div>
      <div class="rate">
        <div class="rate-track"><div class="rate-fill" style="width:${passRate}%"></div></div>
        <span class="rate-label">${passedSessions}/${totalSessions} passed &middot; ${passRate}% pass rate</span>
      </div>
      ${sessionsHtml}
      <span class="folder-link" data-dir="${escapeHtml(folderDir)}">&#128193; Open results folder</span>
    </div>
  </div>`;
}

function renderSingleRun(run, resultsBaseUri, startOpen) {
  const status = run.status === 'passed' ? 'pass' : 'fail';
  const date = formatDate(run.timestamp);
  const duration = formatDuration(run.duration);
  const specName = run._dirName.split('---')[0];

  const testsHtml = run.tests.map((test) => {
    const icon = test.status === 'passed' ? '&#10003;' : '&#10007;';
    const iconClass = test.status === 'passed' ? 'pass' : (test.status === 'timedOut' ? 'timeout' : 'fail');
    const errorsHtml = renderTestErrors(test);
    const shotsHtml = renderTestScreenshots(test, run._dirName, resultsBaseUri);
    const stdoutHtml = test.stdout ? `<div class="stdout-block">${escapeHtml(test.stdout)}</div>` : '';
    return `
      <div class="session-row">
        <span class="session-icon ${iconClass}">${icon}</span>
        <span class="session-label">${escapeHtml(test.title)}</span>
        <span class="session-duration">${formatDuration(test.duration)}</span>
      </div>
      ${errorsHtml}${shotsHtml}${stdoutHtml}`;
  }).join('');

  return `
  <div class="run-card">
    <div class="run-header">
      <span class="status-badge ${status}">${status === 'pass' ? 'Pass' : 'Fail'}</span>
      <span class="single-badge">Single</span>
      <span class="run-title">${escapeHtml(specName)}</span>
      <span class="run-meta">${date} &middot; ${duration}</span>
    </div>
    <div class="run-details${startOpen ? ' open' : ''}">
      <div class="counts">
        <span class="count-pass">${run.passed} passed</span>
        ${run.failed > 0 ? `<span class="count-fail">${run.failed} failed</span>` : ''}
        <span class="count-total">(${run.total} total)</span>
      </div>
      ${testsHtml}
      <span class="folder-link" data-dir="${escapeHtml(run._dirName)}">&#128193; Open results folder</span>
    </div>
  </div>`;
}

function renderErrors(run) {
  const failures = run.tests.filter((t) => t.status !== 'passed');
  if (failures.length === 0) return '';

  return failures.map((test) => renderTestErrors(test)).join('');
}

// Renders screenshot thumbnails for every test in a run (used for bulk sessions).
function renderRunScreenshots(run, dirName, resultsBaseUri) {
  if (!run.tests) return '';
  return run.tests.map((test) => renderTestScreenshots(test, dirName, resultsBaseUri)).join('');
}

// Renders image attachments for a single test as clickable thumbnails.
// Attachment paths are stored relative to the run folder (e.g. "failed--foo.png").
function renderTestScreenshots(test, dirName, resultsBaseUri) {
  if (!test.attachments || test.attachments.length === 0 || !resultsBaseUri) return '';

  const images = test.attachments.filter((a) => {
    if (!a.path) return false;
    return (a.contentType && a.contentType.startsWith('image/')) || /\.(png|jpe?g|webp|gif)$/i.test(a.path);
  });
  if (images.length === 0) return '';

  const shots = images.map((att) => {
    // Only render locally-copied relative paths; skip absolute paths that fall
    // outside the results dir (they aren't reachable from the webview).
    if (path.isAbsolute(att.path) || att.path.includes('..')) return '';
    const relPath = `${dirName}/${att.path}`;
    const webUri = `${resultsBaseUri}/${encodeURI(relPath)}`;
    const caption = att.name || path.basename(att.path);
    return `
      <div class="shot" data-src="${escapeHtml(webUri)}" data-file="${escapeHtml(relPath)}" title="Click to enlarge">
        <img src="${escapeHtml(webUri)}" alt="${escapeHtml(caption)}" loading="lazy" />
        <div class="shot-caption">${escapeHtml(caption)}</div>
      </div>`;
  }).join('');

  if (!shots.trim()) return '';
  return `<div class="shots">${shots}</div>`;
}

function renderTestErrors(test) {
  if (!test.errors || test.errors.length === 0) return '';

  return test.errors.map((err) => {
    // The message carries the error title plus Playwright's call log (often with
    // ANSI dim/color codes) and stays visible. The code frame (snippet) and the
    // raw stack are tucked behind the "Show stack trace" toggle together.
    const message = err.message || 'Unknown error';
    const hasSnippet = err.snippet && err.snippet.trim().length > 0;
    const hasStack = err.stack && err.stack.trim().length > 0;
    const hasDetail = hasSnippet || hasStack;

    return `
      <div class="error-block">
        <div class="error-message ansi">${ansiToHtml(message)}</div>
        ${hasDetail ? `
          <div class="toggle-stack">Show stack trace</div>
          <div class="stack-content">
            ${hasStack ? `<pre class="error-stack ansi">${ansiToHtml(err.stack)}</pre>` : ''}
            ${hasSnippet ? `<pre class="code-frame ansi">${ansiToHtml(err.snippet)}</pre>` : ''}
          </div>
        ` : ''}
      </div>`;
  }).join('');
}

// Converts a string containing ANSI SGR escape sequences (as emitted by
// Playwright for error messages, code frames, and stacks) into safe HTML with
// colored <span> runs. HTML is escaped first, so the result is injection-safe.
// Only the SGR subset Playwright uses is handled; unknown codes are ignored.
function ansiToHtml(input) {
  if (!input) return '';

  // Map SGR foreground color codes to VS Code terminal theme variables with a
  // hardcoded fallback close to the default dark theme (matches the screenshot).
  const FG = {
    30: ['--vscode-terminal-ansiBlack', '#000000'],
    31: ['--vscode-terminal-ansiRed', '#cd3131'],
    32: ['--vscode-terminal-ansiGreen', '#0dbc79'],
    33: ['--vscode-terminal-ansiYellow', '#e5e510'],
    34: ['--vscode-terminal-ansiBlue', '#2472c8'],
    35: ['--vscode-terminal-ansiMagenta', '#bc3fbc'],
    36: ['--vscode-terminal-ansiCyan', '#11a8cd'],
    37: ['--vscode-terminal-ansiWhite', '#e5e5e5'],
    90: ['--vscode-terminal-ansiBrightBlack', '#666666'],
    91: ['--vscode-terminal-ansiBrightRed', '#f14c4c'],
    92: ['--vscode-terminal-ansiBrightGreen', '#23d18b'],
    93: ['--vscode-terminal-ansiBrightYellow', '#f5f543'],
    94: ['--vscode-terminal-ansiBrightBlue', '#3b8eea'],
    95: ['--vscode-terminal-ansiBrightMagenta', '#d670d6'],
    96: ['--vscode-terminal-ansiBrightCyan', '#29b8db'],
    97: ['--vscode-terminal-ansiBrightWhite', '#e5e5e5'],
  };

  // Split into text runs and escape sequences. [<params>m is an SGR code.
  // eslint-disable-next-line no-control-regex
  const parts = input.split(/(\[[0-9;]*m)/);
  let out = '';
  let color = null;
  let bold = false;
  let dim = false;
  let open = false;

  const closeSpan = () => {
    if (open) { out += '</span>'; open = false; }
  };
  const openSpan = () => {
    closeSpan();
    if (!color && !bold && !dim) return;
    const styles = [];
    if (color) styles.push(`color:var(${color[0]},${color[1]})`);
    if (bold) styles.push('font-weight:600');
    if (dim) styles.push('opacity:0.7');
    out += `<span style="${styles.join(';')}">`;
    open = true;
  };

  for (const part of parts) {
    // eslint-disable-next-line no-control-regex
    const m = /^\[([0-9;]*)m$/.exec(part);
    if (m) {
      const codes = m[1] === '' ? [0] : m[1].split(';').map((n) => parseInt(n, 10));
      for (const code of codes) {
        if (code === 0) { color = null; bold = false; dim = false; }
        else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) { bold = false; dim = false; }
        else if (code === 39) color = null;
        else if (FG[code]) color = FG[code];
      }
      openSpan();
    } else if (part) {
      out += escapeHtml(part);
    }
  }
  closeSpan();
  return out;
}

function renderStdout(run) {
  const outputs = run.tests
    .filter((t) => t.stdout || t.stderr)
    .map((t) => (t.stdout || '') + (t.stderr || ''))
    .join('');
  if (!outputs) return '';
  return `<div class="stdout-block">${escapeHtml(outputs)}</div>`;
}

function formatDuration(ms) {
  if (!ms) return '0ms';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { register };
