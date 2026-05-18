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
  const utilsDir = path.join(recordingsDir, 'utils');
  const configPath = path.join(configDir, 'config.js');
  const randomPath = path.join(utilsDir, 'random.js');

  const missingFiles = [];
  if (!fs.existsSync(configPath)) missingFiles.push('config');
  if (!fs.existsSync(randomPath)) missingFiles.push('random');

  if (missingFiles.length === 0) return;

  const choice = await vscode.window.showWarningMessage(
    'SF UI Recorder: The config and/or random utility files required by this script are missing.',
    'Create Files',
    'Cancel'
  );

  if (choice !== 'Create Files') return;

  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(configDir, { recursive: true });
    const sourceConfigPath = path.resolve(__dirname, '..', 'config', 'config.js');
    fs.copyFileSync(sourceConfigPath, configPath);
  }

  if (!fs.existsSync(randomPath)) {
    fs.mkdirSync(utilsDir, { recursive: true });
    const sourceRandomPath = path.resolve(__dirname, '..', 'utils', 'random.js');
    fs.copyFileSync(sourceRandomPath, randomPath);
  }

  vscode.window.showInformationMessage(
    'SF UI Recorder: Created config/config.js and utils/random.js in recordings folder.'
  );
}

module.exports = { register };
