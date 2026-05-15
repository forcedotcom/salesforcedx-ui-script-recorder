const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

function register(context) {
  return vscode.commands.registerCommand(
    'sf-ui-recorder.installAgentforceMcpConfig',
    async () => {
      const settingsPath = path.join(
        process.env.HOME ?? '',
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'salesforce.salesforcedx-einstein-gpt',
        'settings',
        'a4d_mcp_settings.json'
      );

      if (!process.env.HOME) {
        vscode.window.showErrorMessage(
          'SF UI Recorder: Could not resolve HOME directory for Agentforce MCP settings.'
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
