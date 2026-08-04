const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { RecordingCodeLensProvider } = require('./recording-codelens-provider');
const { RecordingsTreeProvider } = require('./recordings-tree-provider');
const { FileListTreeProvider } = require('./file-list-tree-provider');
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
      { language: 'json', pattern: '**/test-plans/playwright/*.json' },
      codeLensProvider
    ),
    vscode.languages.registerCodeLensProvider(
      { language: 'javascript', pattern: '**/test-plans/playwright/*.spec.js' },
      codeLensProvider
    )
  );

  // Sidebar tree views
  const recordingsTree = new RecordingsTreeProvider();
  const userFilesTree = new FileListTreeProvider('user-files');
  const dataFilesTree = new FileListTreeProvider('data-files');
  const recordingsTreeView = vscode.window.createTreeView('sfUiRecorderRecordings', { treeDataProvider: recordingsTree, showCollapseAll: true });
  const userFilesTreeView = vscode.window.createTreeView('sfUiRecorderUserFiles', { treeDataProvider: userFilesTree });
  const dataFilesTreeView = vscode.window.createTreeView('sfUiRecorderDataFiles', { treeDataProvider: dataFilesTree });
  const recordingsWatcher = vscode.workspace.createFileSystemWatcher('**/test-plans/playwright/**');
  recordingsWatcher.onDidCreate(() => { recordingsTree.refresh(); userFilesTree.refresh(); dataFilesTree.refresh(); });
  recordingsWatcher.onDidDelete(() => { recordingsTree.refresh(); userFilesTree.refresh(); dataFilesTree.refresh(); });
  recordingsWatcher.onDidChange(() => { recordingsTree.refresh(); userFilesTree.refresh(); dataFilesTree.refresh(); });
  context.subscriptions.push(recordingsWatcher);

  // Refresh CodeLenses when playback results change, so the "View Playback
  // Results" lens appears/disappears promptly after a run completes.
  const resultsWatcher = vscode.workspace.createFileSystemWatcher('**/playback-results/**');
  resultsWatcher.onDidCreate(() => { codeLensProvider.refresh(); recordingsTree.refresh(); });
  resultsWatcher.onDidDelete(() => { codeLensProvider.refresh(); recordingsTree.refresh(); });
  context.subscriptions.push(resultsWatcher);

  // Register commands
  context.subscriptions.push(
    startRecording.register(context, outputChannel),
    playback.register(context),
    parameterize.register(context, codeLensProvider),
    reconvert.register(context),
    installMcpConfig.register(context),
    resultsViewer.register(context),
    vscode.commands.registerCommand('sf-ui-recorder.viewRecordingHistory', (treeItem) => {
      if (treeItem && treeItem.baseName) {
        vscode.commands.executeCommand('sf-ui-recorder.viewResults', treeItem.baseName);
      }
    }),
    vscode.commands.registerCommand('sf-ui-recorder.playRecording', async (treeItem) => {
      if (treeItem && treeItem.baseName) {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return;
        const specPath = path.join(workspaceFolder.uri.fsPath, 'test-plans', 'playwright', treeItem.baseName + '.spec.js');
        const doc = await vscode.workspace.openTextDocument(specPath);
        await vscode.window.showTextDocument(doc);
        vscode.commands.executeCommand('sf-ui-recorder.playbackScript');
      }
    }),
    vscode.commands.registerCommand('sf-ui-recorder.renameRecording', async (treeItem) => {
      if (!treeItem || !treeItem.baseName) return;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const oldName = treeItem.baseName;
      const recordingsDir = path.join(workspaceFolder.uri.fsPath, 'test-plans', 'playwright');
      const resultsDir = path.join(workspaceFolder.uri.fsPath, 'playback-results');

      const newName = await vscode.window.showInputBox({
        prompt: 'Enter new name for this recording',
        value: oldName,
        validateInput: (value) => {
          if (!value || !value.trim()) return 'Name cannot be empty';
          if (value.trim() === oldName) return null;
          const trimmed = value.trim();
          if (/[/\\:*?"<>|]/.test(trimmed)) return 'Name contains invalid characters';
          if (fs.existsSync(path.join(recordingsDir, trimmed + '.json'))) return 'A recording with this name already exists';
          return null;
        },
      });

      if (!newName || newName.trim() === oldName) return;
      const trimmedName = newName.trim();

      // Gather all files/folders that need renaming
      const filesToRename = [];
      const jsonPath = path.join(recordingsDir, oldName + '.json');
      const specPath = path.join(recordingsDir, oldName + '.spec.js');
      if (fs.existsSync(jsonPath)) filesToRename.push({ from: jsonPath, to: path.join(recordingsDir, trimmedName + '.json') });
      if (fs.existsSync(specPath)) filesToRename.push({ from: specPath, to: path.join(recordingsDir, trimmedName + '.spec.js') });

      // Find playback result folders that match the old name
      const resultFolders = [];
      if (fs.existsSync(resultsDir)) {
        for (const entry of fs.readdirSync(resultsDir)) {
          if (entry.split('---')[0] === oldName) {
            const newEntry = trimmedName + entry.slice(oldName.length);
            resultFolders.push({ from: path.join(resultsDir, entry), to: path.join(resultsDir, newEntry) });
          }
        }
      }

      const parts = [];
      if (filesToRename.length > 0) parts.push(`${filesToRename.length} recording file${filesToRename.length === 1 ? '' : 's'}`);
      if (resultFolders.length > 0) parts.push(`${resultFolders.length} playback result folder${resultFolders.length === 1 ? '' : 's'}`);
      const confirm = await vscode.window.showWarningMessage(
        `Rename "${oldName}" to "${trimmedName}"?\n\nThis will rename ${parts.join(' and ')} associated with this recording.`,
        { modal: true },
        'Rename'
      );

      if (confirm !== 'Rename') return;

      try {
        for (const { from, to } of filesToRename) {
          fs.renameSync(from, to);
        }
        for (const { from, to } of resultFolders) {
          fs.renameSync(from, to);
        }
        vscode.window.showInformationMessage(`SF UI Recorder: Renamed to "${trimmedName}"`);
      } catch (e) {
        vscode.window.showErrorMessage(`SF UI Recorder: Rename failed — ${e.message}`);
      }
    }),
    vscode.commands.registerCommand('sf-ui-recorder.deleteRecording', async (treeItem) => {
      if (!treeItem || !treeItem.baseName) return;
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;

      const baseName = treeItem.baseName;
      const recordingsDir = path.join(workspaceFolder.uri.fsPath, 'test-plans', 'playwright');
      const resultsDir = path.join(workspaceFolder.uri.fsPath, 'playback-results');

      // Gather files and result folders to delete
      const filesToDelete = [];
      const jsonPath = path.join(recordingsDir, baseName + '.json');
      const specPath = path.join(recordingsDir, baseName + '.spec.js');
      if (fs.existsSync(jsonPath)) filesToDelete.push(jsonPath);
      if (fs.existsSync(specPath)) filesToDelete.push(specPath);

      const resultFoldersToDelete = [];
      if (fs.existsSync(resultsDir)) {
        for (const entry of fs.readdirSync(resultsDir)) {
          if (entry.split('---')[0] === baseName) {
            resultFoldersToDelete.push(path.join(resultsDir, entry));
          }
        }
      }

      const parts = [];
      if (filesToDelete.length > 0) parts.push(`${filesToDelete.length} recording file${filesToDelete.length === 1 ? '' : 's'}`);
      if (resultFoldersToDelete.length > 0) parts.push(`${resultFoldersToDelete.length} playback result folder${resultFoldersToDelete.length === 1 ? '' : 's'}`);

      const confirm = await vscode.window.showWarningMessage(
        `Delete "${baseName}"?\n\nThis will permanently delete ${parts.join(' and ')}.`,
        { modal: true },
        'Delete'
      );

      if (confirm !== 'Delete') return;

      try {
        for (const filePath of filesToDelete) {
          fs.unlinkSync(filePath);
        }
        for (const folderPath of resultFoldersToDelete) {
          fs.rmSync(folderPath, { recursive: true, force: true });
        }
        vscode.window.showInformationMessage(`SF UI Recorder: Deleted "${baseName}"`);
      } catch (e) {
        vscode.window.showErrorMessage(`SF UI Recorder: Delete failed — ${e.message}`);
      }
    }),
    vscode.commands.registerCommand('sf-ui-recorder.revealResultFolder', async (resultFolderName) => {
      if (!resultFolderName) return;
      const element = recordingsTree.findResultElement(resultFolderName);
      if (element) {
        try {
          await recordingsTreeView.reveal(element, { expand: true, focus: true });
        } catch {
          vscode.commands.executeCommand('sfUiRecorderRecordings.focus');
        }
      } else {
        vscode.commands.executeCommand('sfUiRecorderRecordings.focus');
      }
    }),
    vscode.commands.registerCommand('sf-ui-recorder.infoUserFiles', () => {
      vscode.window.showInformationMessage(
        'User Files contain credential CSVs (username, password) used during bulk playback. Each row represents a different user account that sessions cycle through.'
      );
    }),
    vscode.commands.registerCommand('sf-ui-recorder.infoDataFiles', () => {
      vscode.window.showInformationMessage(
        'Data Files contain CSVs with custom parameter values for bulk playback. Column headers map to parameterized fields in your scripts, and each row provides data for a session.'
      );
    }),
    vscode.commands.registerCommand('sf-ui-recorder.revealUserFilesInExplorer', () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;
      const folderPath = path.join(workspaceFolder.uri.fsPath, 'user-files');
      if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
      vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folderPath));
    }),
    vscode.commands.registerCommand('sf-ui-recorder.revealDataFilesInExplorer', () => {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) return;
      const folderPath = path.join(workspaceFolder.uri.fsPath, 'data-files');
      if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
      vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(folderPath));
    }),
    vscode.commands.registerCommand('sf-ui-recorder.revealFileSection', async (folder) => {
      if (folder === 'user-files') {
        const first = userFilesTree.getFirstChild();
        if (first) {
          await userFilesTreeView.reveal(first, { select: true, focus: true });
        } else {
          vscode.commands.executeCommand('sfUiRecorderUserFiles.focus');
        }
      } else if (folder === 'data-files') {
        const first = dataFilesTree.getFirstChild();
        if (first) {
          await dataFilesTreeView.reveal(first, { select: true, focus: true });
        } else {
          vscode.commands.executeCommand('sfUiRecorderDataFiles.focus');
        }
      }
    })
  );

  // Watch for MCP trigger file (file-based IPC with MCP server)
  triggerWatcher.register(context, outputChannel);

  // Register gutter decorations for parameterized steps
  decorations.register(context);
}

function deactivate() {}

module.exports = { activate, deactivate };
