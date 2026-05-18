const vscode = require('vscode');
const { getStepLabel } = require('./step-labels');

async function runParameterizeWizard(step) {
  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Config Variable', description: 'Read value from environment variable' },
      { label: 'Remove Parameterization', description: 'Use the recorded value as-is' },
    ],
    { title: `Parameterize: ${getStepLabel(step)}`, placeHolder: 'Choose parameterization mode' }
  );

  if (!mode) return null;

  if (mode.label === 'Remove Parameterization') {
    return { remove: true };
  }

  return await configVariableFlow(step);
}

async function configVariableFlow(step) {
  const suggestedName = inferParamName(step);

  const paramName = await vscode.window.showInputBox({
    title: 'Config Variable Name',
    prompt: 'Enter the parameter name (will be read from SF_UI_RECORDER_<NAME> env var)',
    value: suggestedName,
    validateInput: (value) => {
      if (!value || !value.trim()) return 'Parameter name is required';
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) return 'Must be a valid identifier';
      return null;
    },
  });

  if (!paramName) return null;

  return {
    parameterise: true,
    paramName,
  };
}


function inferParamName(step) {
  const label = getStepLabel(step);
  const cleaned = label
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  return cleaned || 'param_value';
}

module.exports = { runParameterizeWizard };
