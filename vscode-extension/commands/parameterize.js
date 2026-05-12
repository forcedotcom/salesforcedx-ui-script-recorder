const vscode = require('vscode');
const { runParameterizeWizard } = require('../parameterize-wizard');
const { getParamStatusLabel } = require('../step-labels');

function register(context, codeLensProvider) {
  return vscode.commands.registerCommand(
    'sf-ui-recorder.parameterizeStep',
    async (documentUri, stepIndex) => {
      const document = await vscode.workspace.openTextDocument(documentUri);
      let recording;
      try {
        recording = JSON.parse(document.getText());
      } catch {
        vscode.window.showErrorMessage('SF UI Recorder: Could not parse recording JSON.');
        return;
      }

      const step = recording.steps[stepIndex];
      if (!step) {
        vscode.window.showErrorMessage('SF UI Recorder: Step not found.');
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
        vscode.window.showInformationMessage(`SF UI Recorder: Step parameterized — ${status}`);
      } else {
        vscode.window.showInformationMessage('SF UI Recorder: Parameterization removed.');
      }

      await vscode.commands.executeCommand('sf-ui-recorder.reconvert', documentUri);
    }
  );
}

module.exports = { register };
