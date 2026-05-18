const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

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

      // Build quick pick items: headed option + parameter inputs
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

      if (!options) return;

      const headed = options.some((opt) => opt.label === headedOption.label);

      // Prompt for each parameter value
      const envVars = {};
      for (const paramName of paramNames) {
        const envKey = `SF_UI_RECORDER_${paramName.toUpperCase()}`;
        const value = await vscode.window.showInputBox({
          title: `Parameter: ${paramName}`,
          prompt: `Enter value for "${paramName}" (env: ${envKey})`,
          placeHolder: paramName,
        });
        if (value === undefined) return; // user cancelled
        envVars[envKey] = value;
      }

      const specFileName = path.basename(specPath);
      const playwrightArgs = ['playwright', 'test', specFileName];

      if (headed) {
        playwrightArgs.push('--headed');
      }

      let terminal = vscode.window.terminals.find(
        (t) => t.name === 'SF UI Recorder: Playback'
      );
      if (!terminal) {
        terminal = vscode.window.createTerminal({
          name: 'SF UI Recorder: Playback',
          cwd: workspaceFolder.uri.fsPath,
          env: envVars,
        });
      } else {
        // Recreate terminal to pick up new env vars
        terminal.dispose();
        terminal = vscode.window.createTerminal({
          name: 'SF UI Recorder: Playback',
          cwd: workspaceFolder.uri.fsPath,
          env: envVars,
        });
      }
      terminal.show();
      terminal.sendText(`npx ${playwrightArgs.join(' ')}`);
    }
  );
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
