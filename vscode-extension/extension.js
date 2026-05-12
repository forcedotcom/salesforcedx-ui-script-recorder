const vscode = require('vscode');
const { RecordingCodeLensProvider } = require('./recording-codelens-provider');
const startRecording = require('./commands/start-recording');
const playback = require('./commands/playback');
const parameterize = require('./commands/parameterize');
const reconvert = require('./commands/reconvert');
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

  // Register commands
  context.subscriptions.push(
    startRecording.register(context, outputChannel),
    playback.register(context),
    parameterize.register(context, codeLensProvider),
    reconvert.register(context)
  );

  // Register gutter decorations for parameterized steps
  decorations.register(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
