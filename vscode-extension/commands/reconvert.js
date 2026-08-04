const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveNodePath } = require('../resolve-node');

function register(context) {
  return vscode.commands.registerCommand(
    'sf-ui-recorder.reconvert',
    async (documentUri) => {
      const uri = documentUri || vscode.window.activeTextEditor?.document.uri;
      if (!uri) {
        vscode.window.showErrorMessage('SF UI Recorder: No recording file open.');
        return;
      }

      let jsonPath = uri.fsPath;
      if (jsonPath.endsWith('.spec.js')) {
        jsonPath = jsonPath.replace(/\.spec\.js$/, '.json');
      }

      if (!jsonPath.endsWith('.json') || !fs.existsSync(jsonPath)) {
        vscode.window.showErrorMessage('SF UI Recorder: No recording JSON found.');
        return;
      }

      const specPath = jsonPath.replace(/\.json$/, '.spec.js');
      if (fs.existsSync(specPath)) {
        const confirm = await vscode.window.showWarningMessage(
          `This will regenerate the Playwright script and overwrite any manual changes you've made to ${path.basename(specPath)}.`,
          { modal: true },
          'Re-convert'
        );
        if (confirm !== 'Re-convert') return;
      }

      const cliRoot = path.resolve(__dirname, '..', '..');
      const cliPath = path.resolve(cliRoot, 'recorder-cli', 'bin', 'cli.js');

      const nodePath = resolveNodePath();
      const proc = spawn(nodePath, [cliPath, 'convert', jsonPath], {
        cwd: cliRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });

      proc.on('close', async (code) => {
        if (code === 0) {
          const specPath = jsonPath.replace(/\.json$/, '.spec.js');
          if (fs.existsSync(specPath)) {
            const doc = await vscode.workspace.openTextDocument(specPath);
            await vscode.window.showTextDocument(doc);
          }
          vscode.window.showInformationMessage('SF UI Recorder: Playwright script regenerated.');
        } else {
          const details = stderr.trim() || stdout.trim() || `Exit code ${code}`;
          const outputChannel = vscode.window.createOutputChannel('SF UI Recorder');
          outputChannel.appendLine(`[Convert] Failed with exit code ${code}`);
          outputChannel.appendLine(`[Convert] Node: ${nodePath}`);
          outputChannel.appendLine(`[Convert] Command: ${nodePath} ${cliPath} convert ${jsonPath}`);
          outputChannel.appendLine(`[Convert] stderr: ${stderr}`);
          outputChannel.appendLine(`[Convert] stdout: ${stdout}`);
          outputChannel.show(true);
          vscode.window.showErrorMessage(`SF UI Recorder: Conversion failed — ${details}`, 'Show Output').then((choice) => {
            if (choice === 'Show Output') outputChannel.show();
          });
        }
      });

      proc.on('error', (err) => {
        const hint = err.code === 'ENOENT'
          ? `Could not find Node.js at "${nodePath}". Ensure Node is installed and available on your PATH.`
          : err.message;
        const outputChannel = vscode.window.createOutputChannel('SF UI Recorder');
        outputChannel.appendLine(`[Convert] Spawn error: ${err.message}`);
        outputChannel.appendLine(`[Convert] Error code: ${err.code || 'unknown'}`);
        outputChannel.appendLine(`[Convert] Node path attempted: ${nodePath}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`SF UI Recorder: ${hint}`, 'Show Output').then((choice) => {
          if (choice === 'Show Output') outputChannel.show();
        });
      });
    }
  );
}

module.exports = { register };
