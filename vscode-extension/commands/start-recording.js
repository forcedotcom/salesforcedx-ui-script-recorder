/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensurePlaywrightConfig } = require('../ensure-playwright-config');
const { resolveNodePath } = require('../resolve-node');
const { listSalesforceCliOrgs } = require('../sf-cli');

/**
 * Ask the user whether to log in via a Salesforce CLI-authenticated org
 * (no credentials/MFA needed) or by entering a URL and using the standard
 * login form. Returns `{ org, url }` — exactly one of which is set to a
 * meaningful value for the chosen path — or `null` if the user cancelled.
 */
async function pickLoginMode() {
  const DEFAULT_URL = 'https://login.salesforce.com';

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: '$(key) Log in with a Salesforce CLI org',
        description: 'No password or MFA prompt — uses an org you already authenticated via "sf org login web"',
        mode: 'cli',
      },
      {
        label: '$(globe) Enter a URL manually',
        description: 'Log in with the standard Salesforce login form',
        mode: 'manual',
      },
    ],
    { placeHolder: 'How should the recorder log in?' }
  );
  if (choice === undefined) return null;

  if (choice.mode === 'manual') {
    let url = await vscode.window.showInputBox({
      prompt: 'Enter the URL to record (leave empty for login.salesforce.com)',
      placeHolder: 'https://myorg.salesforce.com',
      validateInput: (value) => {
        if (!value || !value.trim()) return null; // empty is valid — uses default
        const normalized = value.match(/^https?:\/\//) ? value : `https://${value}`;
        try { new URL(normalized); return null; } catch { return 'Please enter a valid URL'; }
      },
    });
    if (url === undefined) return null; // user pressed Escape

    // Default to login.salesforce.com if empty, auto-prepend https:// if no protocol
    url = url.trim() || DEFAULT_URL;
    if (!url.match(/^https?:\/\//)) {
      url = `https://${url}`;
    }
    return { org: null, url };
  }

  // CLI-org path
  let orgs;
  try {
    orgs = await listSalesforceCliOrgs();
  } catch (err) {
    vscode.window.showErrorMessage(
      err.message ||
        'Salesforce UI Script Recorder: Could not list Salesforce CLI orgs. Run "sf org login web" to authenticate an org, then try again.'
    );
    return null;
  }
  if (orgs.length === 0) {
    vscode.window.showErrorMessage(
      'Salesforce UI Script Recorder: No connected orgs found. Run "sf org login web" to authenticate an org, then try again.'
    );
    return null;
  }

  const orgItems = orgs.map((o) => ({
    label: o.alias ? `${o.alias} ($(account) ${o.username})` : o.username,
    detail: o.instanceUrl,
    org: o,
  }));
  const pickedOrg = await vscode.window.showQuickPick(orgItems, {
    placeHolder: 'Select a Salesforce org to record against',
  });
  if (pickedOrg === undefined) return null;

  const landingPath = await vscode.window.showInputBox({
    prompt: 'Path to open after login (optional — leave empty for the org home page)',
    placeHolder: '/lightning/o/Account/list',
  });
  if (landingPath === undefined) return null; // user pressed Escape

  return {
    org: pickedOrg.org.username,
    url: landingPath.trim() || null,
    displayUrl: pickedOrg.org.instanceUrl,
  };
}

function register(context, outputChannel) {
  return vscode.commands.registerCommand(
    'salesforce-ui-script-recorder.startRecording',
    async () => {
      const loginMode = await pickLoginMode();
      if (loginMode === null) return;

      const { org } = loginMode;
      let url = loginMode.url;

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage('Salesforce UI Script Recorder: Please open a workspace folder first.');
        return;
      }

      const recordingsDir = path.join(workspaceFolder.uri.fsPath, 'test-plans', 'playwright');
      if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir, { recursive: true });
      }

      // Ensure playwright.config.js exists in the workspace
      const { created } = ensurePlaywrightConfig(workspaceFolder.uri.fsPath, context.extensionPath);
      if (created) {
        outputChannel.appendLine('[Salesforce UI Script Recorder] Created playwright.config.js in workspace');
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .slice(0, -5);
      const outputPath = path.join(recordingsDir, `recording_${timestamp}.json`);

      const cliPath = path.resolve(__dirname, '..', '..', 'recorder-cli', 'bin', 'cli.js');
      const cliRoot = path.resolve(__dirname, '..', '..');
      const authStatesDir = path.join(workspaceFolder.uri.fsPath, 'auth-states');
      const args = [cliPath, 'record', '--output', outputPath];

      if (org) {
        // CLI-org login: the recorder resolves a fresh, credential-free session
        // from the Salesforce CLI itself — no --save-auth/--load-auth needed.
        args.push('--org', org);
        if (url) {
          args.push('--url', url);
        }
      } else {
        args.push('--url', url, '--save-auth', authStatesDir);

        // If multiple auth-state files exist for this hostname, let the user pick
        let hostname;
        try { hostname = new URL(url).hostname; } catch {}
        if (hostname && fs.existsSync(authStatesDir)) {
          const matches = fs.readdirSync(authStatesDir)
            .filter((f) => f.startsWith(hostname + '---') && f.endsWith('.json'));
          if (matches.length > 1) {
            const items = [
              { label: '$(add) New session', description: 'Start fresh without loading saved auth', file: null },
              ...matches.map((f) => {
                const username = f.replace(`${hostname}---`, '').replace(/\.json$/, '');
                return { label: username, description: f, file: f };
              }),
            ];
            const picked = await vscode.window.showQuickPick(items, {
              placeHolder: 'Multiple accounts found — select which auth state to load',
            });
            if (picked === undefined) return;
            if (picked.file) {
              args.push('--load-auth', path.join(authStatesDir, picked.file));
            }
          }
        }
      }

      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Salesforce UI Script Recorder',
          cancellable: true,
        },
        (progress, token) => {
          return new Promise((resolve) => {
            const target = org ? `${org} (via Salesforce CLI)` : url;
            progress.report({ message: `Recording: ${target} — use the overlay controls or press Cancel to stop and save` });

            outputChannel.clear();
            outputChannel.show(true);
            outputChannel.appendLine(`> node ${args.join(' ')}`);
            outputChannel.appendLine(`  cwd: ${cliRoot}`);
            outputChannel.appendLine('');

            const nodePath = resolveNodePath();
            outputChannel.appendLine(`  node: ${nodePath}`);
            outputChannel.appendLine('');

            const proc = spawn(nodePath, args, {
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
                  `Salesforce UI Script Recorder: Recording successfully saved with ${eventCount} events.`
                );

                const specPath = outputPath.replace(/\.json$/, '.spec.js');
                if (fs.existsSync(specPath)) {
                  const doc = await vscode.workspace.openTextDocument(specPath);
                  await vscode.window.showTextDocument(doc);
                }
              } else {
                const codeDescriptions = {
                  '-2': 'Process was interrupted (SIGINT). The recording browser may have been closed manually.',
                  '1': 'The recording script encountered an error. Check the output panel for details.',
                  '127': 'Command not found. Node.js may not be installed correctly.',
                };
                const description = codeDescriptions[String(code)] || 'An unexpected error occurred.';
                outputChannel.appendLine(`\n[Exit code ${code}]: ${description}`);
                vscode.window.showErrorMessage(
                  `Salesforce UI Script Recorder: Recording stopped — ${description}`,
                  'Show Output'
                ).then((choice) => {
                  if (choice === 'Show Output') outputChannel.show();
                });
              }
              resolve();
            });

            proc.on('error', (err) => {
              const hint = err.code === 'ENOENT'
                ? `Could not find Node.js at "${nodePath}". Ensure Node is installed and available on your PATH.`
                : `Failed to start recording process: ${err.message}`;
              outputChannel.appendLine(`\n[Error] ${hint}`);
              outputChannel.appendLine(`[Error] Code: ${err.code || 'unknown'}`);
              outputChannel.appendLine(`[Error] Node path: ${nodePath}`);
              vscode.window.showErrorMessage(
                `Salesforce UI Script Recorder: ${hint}`,
                'Show Output'
              ).then((choice) => {
                if (choice === 'Show Output') outputChannel.show();
              });
              resolve();
            });
          });
        }
      );
    }
  );
}

module.exports = { register };
