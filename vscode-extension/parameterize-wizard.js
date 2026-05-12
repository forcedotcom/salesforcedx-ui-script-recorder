const vscode = require('vscode');
const { getStepLabel } = require('./step-labels');

const DATA_TYPES = [
  { label: 'email', description: 'Random email address' },
  { label: 'phone', description: 'Random phone number' },
  { label: 'number', description: 'Random number within range' },
  { label: 'string', description: 'Random alphanumeric string' },
  { label: 'date', description: 'Random date within range' },
  { label: 'currency', description: 'Random currency amount' },
  { label: 'paragraph', description: 'Random text paragraph' },
  { label: 'url', description: 'Random URL' },
  { label: 'boolean', description: 'Random true/false' },
];

async function runParameterizeWizard(step) {
  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Config Variable', description: 'Read value from environment variable' },
      { label: 'Random Data', description: 'Generate random values at runtime' },
      { label: 'Remove Parameterization', description: 'Use the recorded value as-is' },
    ],
    { title: `Parameterize: ${getStepLabel(step)}`, placeHolder: 'Choose parameterization mode' }
  );

  if (!mode) return null;

  if (mode.label === 'Remove Parameterization') {
    return { remove: true };
  }

  if (mode.label === 'Config Variable') {
    return await configVariableFlow(step);
  }

  return await randomDataFlow(step);
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
    random: false,
    paramName,
  };
}

async function randomDataFlow(step) {
  const suggested = inferDataType(step);
  const sortedTypes = [...DATA_TYPES].sort((a, b) => {
    if (a.label === suggested) return -1;
    if (b.label === suggested) return 1;
    return 0;
  });

  if (suggested) {
    sortedTypes[0] = { ...sortedTypes[0], description: `${sortedTypes[0].description} (suggested)` };
  }

  const dataType = await vscode.window.showQuickPick(sortedTypes, {
    title: 'Data Type',
    placeHolder: 'Choose the type of random data to generate',
  });

  if (!dataType) return null;

  const params = {
    parameterise: true,
    random: true,
    dataType: dataType.label,
  };

  const typeParams = await getTypeSpecificParams(dataType.label, step);
  if (typeParams === null) return null;

  return { ...params, ...typeParams };
}

async function getTypeSpecificParams(dataType, step) {
  switch (dataType) {
    case 'email': {
      const domain = inferEmailDomain(step.value);
      const emailDomain = await vscode.window.showInputBox({
        title: 'Email Domain',
        prompt: 'Domain for generated emails',
        value: domain || 'example.com',
      });
      if (!emailDomain) return null;
      return { emailDomain };
    }

    case 'phone': {
      const country = await vscode.window.showInputBox({
        title: 'Country Code',
        prompt: 'Country code for phone number (e.g., US, GB, AU)',
        value: 'US',
      });
      if (!country) return null;
      return { country };
    }

    case 'number': {
      const min = await vscode.window.showInputBox({
        title: 'Minimum Value',
        prompt: 'Minimum number',
        value: '0',
        validateInput: (v) => isNaN(Number(v)) ? 'Must be a number' : null,
      });
      if (min === undefined) return null;

      const max = await vscode.window.showInputBox({
        title: 'Maximum Value',
        prompt: 'Maximum number',
        value: '100',
        validateInput: (v) => isNaN(Number(v)) ? 'Must be a number' : null,
      });
      if (max === undefined) return null;

      return { min: Number(min), max: Number(max), decimal: false };
    }

    case 'currency': {
      const country = await vscode.window.showInputBox({
        title: 'Country',
        prompt: 'Country for currency format (e.g., US, GB)',
        value: 'US',
      });
      if (!country) return null;

      const min = await vscode.window.showInputBox({
        title: 'Minimum Amount',
        prompt: 'Minimum currency amount',
        value: '1',
        validateInput: (v) => isNaN(Number(v)) ? 'Must be a number' : null,
      });
      if (min === undefined) return null;

      const max = await vscode.window.showInputBox({
        title: 'Maximum Amount',
        prompt: 'Maximum currency amount',
        value: '1000',
        validateInput: (v) => isNaN(Number(v)) ? 'Must be a number' : null,
      });
      if (max === undefined) return null;

      return { country, min: Number(min), max: Number(max), decimal: true };
    }

    case 'date': {
      const dateFormat = await vscode.window.showInputBox({
        title: 'Date Format',
        prompt: 'Date format pattern (e.g., MM/DD/YYYY, YYYY-MM-DD)',
        value: 'MM/DD/YYYY',
      });
      if (!dateFormat) return null;

      return { dateFormat };
    }

    case 'string':
    case 'paragraph': {
      const minLength = await vscode.window.showInputBox({
        title: 'Minimum Length',
        prompt: 'Minimum character length',
        value: dataType === 'paragraph' ? '50' : '5',
        validateInput: (v) => isNaN(Number(v)) ? 'Must be a number' : null,
      });
      if (minLength === undefined) return null;

      const maxLength = await vscode.window.showInputBox({
        title: 'Maximum Length',
        prompt: 'Maximum character length',
        value: dataType === 'paragraph' ? '200' : '15',
        validateInput: (v) => isNaN(Number(v)) ? 'Must be a number' : null,
      });
      if (maxLength === undefined) return null;

      return { minLength: Number(minLength), maxLength: Number(maxLength) };
    }

    case 'url': {
      const domain = await vscode.window.showInputBox({
        title: 'Domain',
        prompt: 'Base domain for generated URLs',
        value: 'example.com',
      });
      if (!domain) return null;
      return { domain };
    }

    case 'boolean':
      return {};

    default:
      return {};
  }
}

function inferDataType(step) {
  if (step.inputType === 'email' || /email/i.test(getStepLabel(step))) return 'email';
  if (step.inputType === 'tel' || /phone/i.test(getStepLabel(step))) return 'phone';
  if (step.inputType === 'number') return 'number';
  if (step.inputType === 'url') return 'url';
  if (step.inputType === 'date') return 'date';
  if (step.inputType === 'checkbox' || step.inputType === 'radio') return 'boolean';

  const value = step.value || '';
  if (/^[^@]+@[^@]+\.[^@]+$/.test(value)) return 'email';
  if (/^\+?\d[\d\s\-()]{6,}$/.test(value)) return 'phone';
  if (/^\d+(\.\d+)?$/.test(value)) return 'number';
  if (/^https?:\/\//.test(value)) return 'url';

  return 'string';
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

function inferEmailDomain(value) {
  if (!value) return null;
  const match = value.match(/@([^@]+)$/);
  return match ? match[1] : null;
}

module.exports = { runParameterizeWizard };
