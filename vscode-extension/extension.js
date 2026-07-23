const vscode = require('vscode');
const { RecordingCodeLensProvider } = require('./recording-codelens-provider');
const startRecording = require('./commands/start-recording');
const playback = require('./commands/playback');
const parameterize = require('./commands/parameterize');
const reconvert = require('./commands/reconvert');
const installMcpConfig = require('./commands/install-mcp-config');
const resultsViewer = require('./commands/results-viewer');
const triggerWatcher = require('./trigger-watcher');
const decorations = require('./decorations');

let outputChannel;

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('SF UI Recorder');

  // CodeLens provider for recording JSON and spec files
  const codeLensProvider = new RecordingCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: 'json', pattern: '**/recording*.json' },
      codeLensProvider
    ),
    vscode.languages.registerCodeLensProvider(
      { language: 'javascript', pattern: '**/recording*.spec.js' },
      codeLensProvider
    )
  );

  // Refresh CodeLenses when playback results change, so the "View Playback
  // Results" lens appears/disappears promptly after a run completes.
  const resultsWatcher = vscode.workspace.createFileSystemWatcher('**/playback-results/**');
  resultsWatcher.onDidCreate(() => codeLensProvider.refresh());
  resultsWatcher.onDidDelete(() => codeLensProvider.refresh());
  context.subscriptions.push(resultsWatcher);

  // Register commands
  context.subscriptions.push(
    startRecording.register(context, outputChannel),
    playback.register(context),
    parameterize.register(context, codeLensProvider),
    reconvert.register(context),
    installMcpConfig.register(context),
    resultsViewer.register(context)
  );

  // Watch for MCP trigger file (file-based IPC with MCP server)
  triggerWatcher.register(context, outputChannel);

  // Register gutter decorations for parameterized steps
  decorations.register(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
