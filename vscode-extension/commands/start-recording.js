const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function register(context, outputChannel) {
  return vscode.commands.registerCommand(
    'sf-ui-recorder.startRecording',
    async () => {
      const url = await vscode.window.showInputBox({
        prompt: 'Enter the URL to record',
        placeHolder: 'https://myorg.salesforce.com',
        validateInput: (value) => {
          if (!value || !value.trim()) return 'URL is required';
          try { new URL(value); return null; } catch { return 'Please enter a valid URL'; }
        },
      });

      if (!url) return;

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('SF UI Recorder: Please open a workspace folder first.');
        return;
      }

      const recordingsDir = path.join(workspaceFolder.uri.fsPath, 'recordings');
      if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir, { recursive: true });
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, -5);
      const outputPath = path.join(recordingsDir, `recording_${timestamp}.json`);

      const cliPath = path.resolve(__dirname, '..', '..', 'bin', 'cli.js');
      const cliRoot = path.resolve(__dirname, '..', '..');
      const args = [cliPath, 'record', '--url', url, '--output', outputPath];

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
            outputChannel.appendLine(`  cwd: ${cliRoot}`);
            outputChannel.appendLine('');

            const proc = spawn('node', args, {
              cwd: cliRoot,
              stdio: ['ignore', 'pipe', 'pipe'],
            });

            proc.stdout.on('data', (data) => outputChannel.append(data.toString()));
            proc.stderr.on('data', (data) => outputChannel.append(data.toString()));

            token.onCancellationRequested(() => proc.kill());

            proc.on('close', async (code) => {
              outputChannel.appendLine(`\n[Process exited with code ${code}]`);
              if (code === 0 || code === null) {
                let eventCount = 0;
                try {
                  const recording = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
                  eventCount = Array.isArray(recording)
                    ? recording.length
                    : (recording.steps?.length || recording.events?.length || 0);
                } catch {}

                vscode.window.showInformationMessage(
                  `SF UI Recorder: Recording successfully saved with ${eventCount} events.`
                );

                const specPath = outputPath.replace(/\.json$/, '.spec.js');
                if (fs.existsSync(specPath)) {
                  const doc = await vscode.workspace.openTextDocument(specPath);
                  await vscode.window.showTextDocument(doc);
                }
              } else {
                vscode.window.showErrorMessage(`SF UI Recorder: Process exited with code ${code}.`);
              }
              resolve();
            });

            proc.on('error', (err) => {
              outputChannel.appendLine(`\n[Error: ${err.message}]`);
              vscode.window.showErrorMessage(`SF UI Recorder: Failed to start — ${err.message}`);
              resolve();
            });
          });
        }
      );
    }
  );
}

module.exports = { register };
