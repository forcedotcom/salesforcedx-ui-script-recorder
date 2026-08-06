/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

/**
 * Resolve the Agentforce MCP settings path cross-platform.
 * VS Code globalStorage location:
 *   macOS:   ~/Library/Application Support/Code/User/globalStorage/
 *   Linux:   ~/.config/Code/User/globalStorage/
 *   Windows: %APPDATA%/Code/User/globalStorage/
 */
function getAgentforceMcpSettingsPath() {
  const platform = process.platform;
  let baseDir;

  if (platform === 'darwin') {
    baseDir = path.join(process.env.HOME || '', 'Library', 'Application Support');
  } else if (platform === 'win32') {
    baseDir = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  } else {
    // Linux / others
    baseDir = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  }

  return path.join(
    baseDir,
    'Code',
    'User',
    'globalStorage',
    'salesforce.salesforcedx-einstein-gpt',
    'settings',
    'a4d_mcp_settings.json'
  );
}

function register(context) {
  return vscode.commands.registerCommand(
    'sf-ui-recorder.installAgentforceMcpConfig',
    async () => {
      const settingsPath = getAgentforceMcpSettingsPath();

      if (!settingsPath) {
        vscode.window.showErrorMessage(
          'SF UI Recorder: Could not resolve Agentforce MCP settings path for this platform.'
        );
        return;
      }

      const mcpServerEntry = {
        type: 'stdio',
        command: 'node',
        args: [path.join(context.extensionPath, 'mcp-server', 'index.js')],
      };

      try {
        const settingsDir = path.dirname(settingsPath);
        fs.mkdirSync(settingsDir, { recursive: true });

        let raw = '{}';
        if (fs.existsSync(settingsPath)) {
          raw = fs.readFileSync(settingsPath, 'utf-8').trim() || '{}';
        }

        const parsed = JSON.parse(raw);
        const existingMcpServers = parsed.mcpServers;

        if (
          existingMcpServers !== undefined &&
          (typeof existingMcpServers !== 'object' ||
            existingMcpServers === null ||
            Array.isArray(existingMcpServers))
        ) {
          vscode.window.showErrorMessage(
            'SF UI Recorder: Expected "mcpServers" to be an object in Agentforce MCP settings.'
          );
          return;
        }

        const next = {
          ...parsed,
          mcpServers: {
            ...existingMcpServers,
            ['sf-ui-recorder']: mcpServerEntry,
          },
        };

        fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), 'utf-8');

        vscode.window
          .showInformationMessage(
            'SF UI Recorder: Installed Agentforce MCP config for sf-ui-recorder.',
            'Open File'
          )
          .then((selection) => {
            if (selection === 'Open File') {
              vscode.commands.executeCommand(
                'vscode.open',
                vscode.Uri.file(settingsPath)
              );
            }
          });
      } catch (error) {
        vscode.window.showErrorMessage(
          `SF UI Recorder: Failed to install Agentforce MCP config: ${error}`
        );
      }
    }
  );
}

module.exports = { register };
