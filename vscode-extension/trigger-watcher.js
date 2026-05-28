const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ensurePlaywrightConfig } = require('./ensure-playwright-config');
const { resolveNodePath } = require('./resolve-node');

const TRIGGER_DIR = '.sf-ui-recorder';
const TRIGGER_FILE = 'trigger.json';
const RESULT_FILE = 'result.json';

/**
 * Set up a file-system watcher on .sf-ui-recorder/trigger.json in the workspace.
 * When the MCP server writes a command to that file, this watcher picks it up,
 * executes it in the VS Code terminal, and writes the result back.
 */
function register(context, outputChannel) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) return;

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const triggerDir = path.join(workspaceRoot, TRIGGER_DIR);
  const triggerPath = path.join(triggerDir, TRIGGER_FILE);
  const resultPath = path.join(triggerDir, RESULT_FILE);

  // Ensure the trigger directory exists
  if (!fs.existsSync(triggerDir)) {
    fs.mkdirSync(triggerDir, { recursive: true });
  }

  // Watch for trigger file creation/changes
  const pattern = new vscode.RelativePattern(workspaceFolder, `${TRIGGER_DIR}/${TRIGGER_FILE}`);
  const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, true);

  const handleTrigger = async () => {
    let trigger;
    try {
      if (!fs.existsSync(triggerPath)) return;
      const raw = fs.readFileSync(triggerPath, 'utf-8').trim();
      if (!raw) return;
      trigger = JSON.parse(raw);
    } catch (err) {
      writeResult(resultPath, { ok: false, error: `Failed to parse trigger: ${err.message}` });
      cleanupTrigger(triggerPath);
      return;
    }

    // Delete trigger file immediately to avoid re-processing
    cleanupTrigger(triggerPath);

    const { command, args = {} } = trigger;
    outputChannel.appendLine(`[MCP Trigger] Received command: ${command}`);

    try {
      switch (command) {
        case 'record':
          await handleRecord(args, workspaceRoot, outputChannel, resultPath, context);
          break;
        case 'playback':
          await handlePlayback(args, workspaceRoot, outputChannel, resultPath);
          break;
        case 'convert':
          await handleConvert(args, workspaceRoot, outputChannel, resultPath, context);
          break;
        case 'list_recordings':
          handleListRecordings(workspaceRoot, resultPath);
          break;
        default:
          writeResult(resultPath, { ok: false, error: `Unknown command: ${command}` });
      }
    } catch (err) {
      writeResult(resultPath, { ok: false, error: err.message });
    }
  };

  watcher.onDidCreate(handleTrigger);
  watcher.onDidChange(handleTrigger);

  context.subscriptions.push(watcher);
}

// ─── Command Handlers ────────────────────────────────────────────────────────

async function handleRecord(args, workspaceRoot, outputChannel, resultPath, context) {
  const recordingsDir = path.join(workspaceRoot, 'test-plans', 'playwright');
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }

  // Ensure playwright.config.js exists in the workspace
  const { created } = ensurePlaywrightConfig(workspaceRoot);
  if (created) {
    outputChannel.appendLine('[MCP] Created playwright.config.js in workspace');
  }

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, -5);
  const outputPath = args.output || path.join(recordingsDir, `recording_${timestamp}.json`);

  const cliPath = path.resolve(context.extensionPath, 'recorder-cli', 'bin', 'cli.js');
  const authStatePath = args.saveAuth || path.join(workspaceRoot, 'auth-state.json');
  const cliArgs = [cliPath, 'record', '--url', args.url || 'about:blank', '--output', outputPath, '--save-auth', authStatePath];

  if (args.headless) cliArgs.push('--headless');
  if (args.viewportWidth) cliArgs.push('--viewport-width', String(args.viewportWidth));
  if (args.viewportHeight) cliArgs.push('--viewport-height', String(args.viewportHeight));
  if (args.profileDir) cliArgs.push('--profile-dir', args.profileDir);
  if (args.cloud) cliArgs.push('--cloud', args.cloud);
  if (args.user) cliArgs.push('--user', args.user);
  if (args.team) cliArgs.push('--team', args.team);
  if (args.dataAttribute) cliArgs.push('--data-attribute', args.dataAttribute);

  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`[MCP] Starting recording: ${args.url || 'about:blank'}`);
  outputChannel.appendLine(`> node ${cliArgs.join(' ')}`);
  outputChannel.appendLine('');

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'SF UI Recorder',
      cancellable: true,
    },
    (progress, token) => {
      return new Promise((resolve) => {
        progress.report({ message: `Recording: ${args.url || 'about:blank'} — use the overlay controls or press Cancel to stop` });

        const nodePath = resolveNodePath();
        outputChannel.appendLine(`  node: ${nodePath}`);

        const proc = spawn(nodePath, cliArgs, {
          cwd: workspaceRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        token.onCancellationRequested(() => proc.kill());

        proc.stdout.on('data', (data) => outputChannel.append(data.toString()));
        proc.stderr.on('data', (data) => outputChannel.append(data.toString()));

        proc.on('close', async (code) => {
          outputChannel.appendLine(`\n[Process exited with code ${code}]`);

          if (code === 0 || code === null) {
            const specPath = outputPath.replace(/\.json$/, '.spec.js');
            let eventCount = 0;
            try {
              const recording = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
              eventCount = Array.isArray(recording)
                ? recording.length
                : (recording.steps?.length || recording.events?.length || 0);
            } catch {}

            vscode.window.showInformationMessage(
              `SF UI Recorder: Recording saved with ${eventCount} events.`
            );

            // Open the spec file in the editor
            if (fs.existsSync(specPath)) {
              const doc = await vscode.workspace.openTextDocument(specPath);
              await vscode.window.showTextDocument(doc);
            }

            writeResult(resultPath, {
              ok: true,
              jsonFile: outputPath,
              specFile: fs.existsSync(specPath) ? specPath : null,
              eventCount,
            });
          } else {
            const codeDescriptions = {
              '-2': 'Recording was interrupted (browser closed or SIGINT).',
              '1': 'The recording script encountered an error.',
              '127': 'Node.js command not found.',
            };
            const description = codeDescriptions[String(code)] || `Process exited unexpectedly with code ${code}.`;
            outputChannel.appendLine(`\n[Exit code ${code}]: ${description}`);
            writeResult(resultPath, { ok: false, error: description });
          }
          resolve();
        });

        proc.on('error', (err) => {
          const hint = err.code === 'ENOENT'
            ? `Could not find Node.js at "${nodePath}". Ensure Node is installed and available on your PATH.`
            : `Failed to start recording: ${err.message}`;
          outputChannel.appendLine(`\n[Error] ${hint}`);
          outputChannel.appendLine(`[Error] Code: ${err.code || 'unknown'}`);
          writeResult(resultPath, { ok: false, error: hint });
          resolve();
        });
      });
    }
  );
}

async function handlePlayback(args, workspaceRoot, outputChannel, resultPath) {
  let specFile = args.specFile;

  // Resolve relative paths against workspace
  if (!path.isAbsolute(specFile)) {
    specFile = path.resolve(workspaceRoot, specFile);
  }

  if (!fs.existsSync(specFile)) {
    writeResult(resultPath, { ok: false, error: `Spec file not found: ${specFile}` });
    return;
  }

  if (!specFile.endsWith('.spec.js')) {
    writeResult(resultPath, { ok: false, error: `File must be a .spec.js file: ${specFile}` });
    return;
  }

  const headed = args.headed !== false;
  const playwrightArgs = ['playwright', 'test', `"${specFile}"`];
  if (headed) playwrightArgs.push('--headed');

  const terminalCommand = `npx ${playwrightArgs.join(' ')}`;

  outputChannel.appendLine(`[MCP] Starting playback: ${specFile}`);
  outputChannel.appendLine(`> ${terminalCommand}`);

  // Run in VS Code terminal so the user can see it
  let terminal = vscode.window.terminals.find(
    (t) => t.name === 'SF UI Recorder: Playback'
  );
  if (!terminal) {
    terminal = vscode.window.createTerminal({
      name: 'SF UI Recorder: Playback',
      cwd: workspaceRoot,
    });
  }
  terminal.show();
  terminal.sendText(terminalCommand);

  vscode.window.showInformationMessage(
    `SF UI Recorder: Playback started for ${path.basename(specFile)}`
  );

  writeResult(resultPath, {
    ok: true,
    message: `Playback started in terminal for: ${path.basename(specFile)}`,
    specFile,
  });
}

async function handleConvert(args, workspaceRoot, outputChannel, resultPath, context) {
  let inputFile = args.inputFile;

  if (!path.isAbsolute(inputFile)) {
    inputFile = path.resolve(workspaceRoot, inputFile);
  }

  if (!fs.existsSync(inputFile)) {
    writeResult(resultPath, { ok: false, error: `Input file not found: ${inputFile}` });
    return;
  }

  const cliPath = path.resolve(context.extensionPath, 'recorder-cli', 'bin', 'cli.js');
  const cliArgs = [cliPath, 'convert', inputFile];
  if (args.output) cliArgs.push('--output', args.output);
  if (args.cloud) cliArgs.push('--cloud', args.cloud);
  if (args.user) cliArgs.push('--user', args.user);
  if (args.team) cliArgs.push('--team', args.team);

  outputChannel.appendLine(`[MCP] Converting: ${inputFile}`);
  outputChannel.appendLine(`> node ${cliArgs.join(' ')}`);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'SF UI Recorder',
      cancellable: false,
    },
    (progress) => {
      return new Promise((resolve) => {
        progress.report({ message: `Converting ${path.basename(inputFile)} to Playwright script...` });

        let stdout = '';
        let stderr = '';

        const nodePath = resolveNodePath();
        outputChannel.appendLine(`  node: ${nodePath}`);

        const proc = spawn(nodePath, cliArgs, {
          cwd: workspaceRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
          outputChannel.append(data.toString());
        });
        proc.stderr.on('data', (data) => {
          stderr += data.toString();
          outputChannel.append(data.toString());
        });

        proc.on('close', (code) => {
          if (code === 0) {
            const specPath = args.output || inputFile.replace(/\.json$/, '.spec.js');
            vscode.window.showInformationMessage(
              `SF UI Recorder: Converted to ${path.basename(specPath)}`
            );
            writeResult(resultPath, { ok: true, specFile: specPath, output: stdout });
          } else {
            const details = stderr.trim() || `Exit code ${code}`;
            outputChannel.appendLine(`\n[Convert failed] ${details}`);
            writeResult(resultPath, { ok: false, error: `Conversion failed: ${details}` });
          }
          resolve();
        });

        proc.on('error', (err) => {
          const hint = err.code === 'ENOENT'
            ? `Could not find Node.js at "${nodePath}". Ensure Node is installed and available on your PATH.`
            : err.message;
          outputChannel.appendLine(`\n[Error] ${hint}`);
          writeResult(resultPath, { ok: false, error: hint });
          resolve();
        });
      });
    }
  );
}

function handleListRecordings(workspaceRoot, resultPath) {
  const recordingsDir = path.join(workspaceRoot, 'test-plans', 'playwright');

  if (!fs.existsSync(recordingsDir)) {
    writeResult(resultPath, { ok: true, recordings: [], count: 0 });
    return;
  }

  const files = fs.readdirSync(recordingsDir).sort();
  const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  const specFiles = files.filter((f) => f.endsWith('.spec.js'));

  const recordings = jsonFiles.map((jsonFile) => {
    const baseName = jsonFile.replace(/\.json$/, '');
    const hasSpec = specFiles.includes(`${baseName}.spec.js`);
    const filePath = path.join(recordingsDir, jsonFile);
    const stats = fs.statSync(filePath);

    return {
      name: baseName,
      jsonFile: path.join('test-plans', 'playwright', jsonFile),
      specFile: hasSpec ? path.join('test-plans', 'playwright', `${baseName}.spec.js`) : null,
      size: stats.size,
      modified: stats.mtime.toISOString(),
    };
  });

  writeResult(resultPath, { ok: true, count: recordings.length, recordings });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function writeResult(resultPath, data) {
  const resultDir = path.dirname(resultPath);
  if (!fs.existsSync(resultDir)) {
    fs.mkdirSync(resultDir, { recursive: true });
  }
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2), 'utf-8');
}

function cleanupTrigger(triggerPath) {
  try {
    if (fs.existsSync(triggerPath)) {
      fs.unlinkSync(triggerPath);
    }
  } catch {}
}

module.exports = { register };
