const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

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

      const cliRoot = path.resolve(__dirname, '..', '..');
      const cliPath = path.resolve(cliRoot, 'bin', 'cli.js');
      const args = [cliPath, 'convert', jsonPath];

      const proc = spawn('node', args, {
        cwd: cliRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stderr = '';
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
          vscode.window.showErrorMessage(`SF UI Recorder: Conversion failed — ${stderr.trim()}`);
        }
      });

      proc.on('error', (err) => {
        vscode.window.showErrorMessage(`SF UI Recorder: Conversion error — ${err.message}`);
      });
    }
  );
}

module.exports = { register };
