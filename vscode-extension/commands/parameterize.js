/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

const vscode = require('vscode');
const { runParameterizeWizard } = require('../parameterize-wizard');
const { getParamStatusLabel } = require('../step-labels');

function register(context, codeLensProvider) {
  return vscode.commands.registerCommand(
    'salesforce-ui-script-recorder.parameterizeStep',
    async (documentUri, stepIndex) => {
      const document = await vscode.workspace.openTextDocument(documentUri);
      let recording;
      try {
        recording = JSON.parse(document.getText());
      } catch {
        vscode.window.showErrorMessage('Salesforce UI Script Recorder: Could not parse recording JSON.');
        return;
      }

      const step = recording.steps[stepIndex];
      if (!step) {
        vscode.window.showErrorMessage('Salesforce UI Script Recorder: Step not found.');
        return;
      }

      const result = await runParameterizeWizard(step);
      if (!result) return;

      if (result.remove) {
        delete recording.steps[stepIndex].params;
      } else {
        recording.steps[stepIndex].params = result;
      }

      const updatedJson = JSON.stringify(recording, null, 2);
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      edit.replace(documentUri, fullRange, updatedJson);
      await vscode.workspace.applyEdit(edit);
      await document.save();

      codeLensProvider.refresh();

      const status = getParamStatusLabel(recording.steps[stepIndex]);
      if (status) {
        vscode.window.showInformationMessage(`Salesforce UI Script Recorder: Step parameterized — ${status}`);
      } else {
        vscode.window.showInformationMessage('Salesforce UI Script Recorder: Parameterization removed.');
      }

      await vscode.commands.executeCommand('salesforce-ui-script-recorder.reconvert', documentUri);
    }
  );
}

module.exports = { register };
