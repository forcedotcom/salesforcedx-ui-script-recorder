const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Output channel for logging
let outputChannel;

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  outputChannel = vscode.window.createOutputChannel('SF UI Recorder');
  const disposable = vscode.commands.registerCommand(
    'sf-ui-recorder.startRecording',
    async () => {
      // Prompt user for the URL
      const url = await vscode.window.showInputBox({
        prompt: 'Enter the URL to record',
        placeHolder: 'https://myorg.salesforce.com',
        validateInput: (value) => {
          if (!value || !value.trim()) {
            return 'URL is required';
          }
          try {
            new URL(value);
            return null;
          } catch {
            return 'Please enter a valid URL';
          }
        },
      });

      if (!url) {
        return; // User cancelled
      }

      // Ensure there's an open workspace to save recordings into
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage(
          'SF UI Recorder: Please open a workspace folder first.'
        );
        return;
      }

      // Create a recordings directory in the workspace
      const recordingsDir = path.join(workspaceFolder.uri.fsPath, 'recordings');
      if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir, { recursive: true });
      }

      // Generate a timestamped output file path
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, -5);
      const outputPath = path.join(recordingsDir, `recording_${timestamp}.json`);

      // Resolve the CLI path (sibling to the extension directory)
      const cliPath = path.resolve(__dirname, '..', 'bin', 'cli.js');

      // Build the command args
      const args = [cliPath, 'record', '--url', url, '--output', outputPath];

      // Show progress while recording is active
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'SF UI Recorder',
          cancellable: true,
        },
        (progress, token) => {
          return new Promise((resolve) => {
            progress.report({ message: `Recording: ${url} — use the overlay controls or press Cancel to stop and save` });

            outputChannel.clear();
            outputChannel.show(true);
            outputChannel.appendLine(`> node ${args.join(' ')}`);
            outputChannel.appendLine(`  cwd: ${path.resolve(__dirname, '..')}`);
            outputChannel.appendLine('');

            const proc = spawn('node', args, {
              cwd: path.resolve(__dirname, '..'),
              stdio: ['ignore', 'pipe', 'pipe'],
            });

            let output = '';

            proc.stdout.on('data', (data) => {
              const text = data.toString();
              output += text;
              outputChannel.append(text);
            });

            proc.stderr.on('data', (data) => {
              const text = data.toString();
              output += text;
              outputChannel.append(text);
            });

            token.onCancellationRequested(() => {
              // Use default signal — SIGTERM on Unix, TerminateProcess on Windows
              proc.kill();
            });

            proc.on('close', async (code) => {
              outputChannel.appendLine(`\n[Process exited with code ${code}]`);
              if (code === 0 || code === null) {
                // Read the recording JSON to count events
                let eventCount = 0;
                try {
                  const recording = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
                  eventCount = Array.isArray(recording)
                    ? recording.length
                    : (recording.steps?.length || recording.events?.length || 0);
                } catch {
                  // If we can't parse, just show 0
                }

                vscode.window.showInformationMessage(
                  `SF UI Recorder: Recording successfully saved with ${eventCount} events.`
                );

                // Open the generated .spec.js file
                const specPath = outputPath.replace(/\.json$/, '.spec.js');
                if (fs.existsSync(specPath)) {
                  const doc = await vscode.workspace.openTextDocument(specPath);
                  await vscode.window.showTextDocument(doc);
                }
              } else {
                vscode.window.showErrorMessage(
                  `SF UI Recorder: Process exited with code ${code}.`
                );
              }
              resolve();
            });

            proc.on('error', (err) => {
              outputChannel.appendLine(`\n[Error: ${err.message}]`);
              vscode.window.showErrorMessage(
                `SF UI Recorder: Failed to start — ${err.message}`
              );
              resolve();
            });
          });
        }
      );
    }
  );

  context.subscriptions.push(disposable);

  // Playback command — runs the .spec.js Playwright test
  const playbackDisposable = vscode.commands.registerCommand(
    'sf-ui-recorder.playbackScript',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('SF UI Recorder: No file open.');
        return;
      }

      const specPath = editor.document.uri.fsPath;

      if (!specPath.endsWith('.spec.js')) {
        vscode.window.showErrorMessage(
          'SF UI Recorder: This command only works on .spec.js files.'
        );
        return;
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage(
          'SF UI Recorder: Please open a workspace folder first.'
        );
        return;
      }

      // Check if config and random utility files exist in the recordings directory
      const recordingsDir = path.dirname(specPath);
      const configDir = path.join(recordingsDir, 'config');
      const utilsDir = path.join(recordingsDir, 'utils');
      const configPath = path.join(configDir, 'config.js');
      const randomPath = path.join(utilsDir, 'random.js');

      const missingFiles = [];
      if (!fs.existsSync(configPath)) {
        missingFiles.push(configPath);
      }
      if (!fs.existsSync(randomPath)) {
        missingFiles.push(randomPath);
      }

      if (missingFiles.length > 0) {
        const choice = await vscode.window.showWarningMessage(
          'SF UI Recorder: The config and/or random utility files required by this script are missing.',
          'Create Files',
          'Cancel'
        );

        if (choice !== 'Create Files') {
          return;
        }

        // Create config/config.js
        if (!fs.existsSync(configPath)) {
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(
            configPath,
            [
              '/**',
              ' * Simple config provider for generated Playwright scripts.',
              ' * Set credentials via environment variables:',
              ' *   SF_UI_RECORDER_USERNAME, SF_UI_RECORDER_PASSWORD',
              ' * Or override any key via SF_UI_RECORDER_<KEY> (uppercase).',
              ' */',
              'const config = {',
              '  get(key) {',
              '    const envKey = `RECORDER_${key.toUpperCase()}`',
              '    const value = process.env[envKey]',
              '    if (!value) {',
              '      throw new Error(',
              '        `Missing config "${key}". Set environment variable ${envKey} before running the test.`',
              '      )',
              '    }',
              '    return value',
              '  }',
              '}',
              '',
              'export default config',
              '',
            ].join('\n')
          );
        }

        // Create utils/random.js
        if (!fs.existsSync(randomPath)) {
          fs.mkdirSync(utilsDir, { recursive: true });
          fs.writeFileSync(
            randomPath,
            [
              '/**',
              ' * Random utility for generated Playwright scripts.',
              ' */',
              'export function randomString(length = 8) {',
              '  return Math.random().toString(36).substring(2, 2 + length)',
              '}',
              '',
              'export function randomInt(min = 0, max = 100) {',
              '  return Math.floor(Math.random() * (max - min + 1)) + min',
              '}',
              '',
              'export default { randomString, randomInt }',
              '',
            ].join('\n')
          );
        }

        vscode.window.showInformationMessage(
          'SF UI Recorder: Created config/config.js and utils/random.js in recordings folder.'
        );
      }

      // Show options quick pick
      const headedOption = {
        label: '$(eye) Headed',
        description: 'Run with a visible browser window',
        picked: true,
      };

      const options = await vscode.window.showQuickPick([headedOption], {
        canPickMany: true,
        title: 'Playback Options',
        placeHolder: 'Select options then press Enter to run',
      });

      if (!options) {
        return; // User cancelled
      }

      const headed = options.some((opt) => opt.label === headedOption.label);

      // Build playwright command — quote the path for Windows compatibility
      const quotedSpecPath = `"${specPath}"`;
      const playwrightArgs = ['playwright', 'test', quotedSpecPath];

      if (headed) {
        playwrightArgs.push('--headed');
      }

      // Reuse existing terminal or create one
      let terminal = vscode.window.terminals.find(
        (t) => t.name === 'SF UI Recorder: Playback'
      );
      if (!terminal) {
        terminal = vscode.window.createTerminal({
          name: 'SF UI Recorder: Playback',
          cwd: workspaceFolder.uri.fsPath,
        });
      }
      terminal.show();
      terminal.sendText(`npx ${playwrightArgs.join(' ')}`);
    }
  );

  context.subscriptions.push(playbackDisposable);
}

function deactivate() {}

module.exports = { activate, deactivate };
