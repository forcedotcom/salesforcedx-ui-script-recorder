/**
 * Extracts human-readable labels from recording steps for display in CodeLens and QuickPick.
 */

function getStepLabel(step) {
  const ariaSelector = step.selectors?.find((sel) => sel[0]?.startsWith('aria/'));
  if (ariaSelector) {
    const match = ariaSelector[0].match(/^aria\/([^[]+)/);
    if (match) {
      return match[1].trim();
    }
  }

  const cssSelector = step.selectors?.find((sel) => sel[0])?.[0];
  if (cssSelector) {
    const nameMatch = cssSelector.match(/\[name="([^"]+)"\]/);
    if (nameMatch) return nameMatch[1];

    const idMatch = cssSelector.match(/#([a-zA-Z0-9_-]+)/);
    if (idMatch) return idMatch[1];

    const placeholderMatch = cssSelector.match(/\[placeholder="([^"]+)"\]/);
    if (placeholderMatch) return placeholderMatch[1];

    if (cssSelector.length > 40) {
      return cssSelector.substring(0, 37) + '...';
    }
    return cssSelector;
  }

  return `Step (${step.type})`;
}

function getStepDescription(step) {
  const label = getStepLabel(step);
  const value = step.value || '';
  const truncatedValue = value.length > 30 ? value.substring(0, 27) + '...' : value;

  if (step.type === 'change') {
    const inputType = step.inputType ? `${step.inputType} ` : '';
    return `${inputType}${label} = "${truncatedValue}"`;
  }

  if (step.type === 'click') {
    return `click ${label}`;
  }

  if (step.type === 'assert') {
    const kind = step.assertionType === 'containsText' ? 'text' : 'visible'
    return `assert ${kind}: ${label}`;
  }

  return label;
}

function getParamStatusLabel(step) {
  if (!step.params?.parameterise) return null;

  if (step.params.paramName) {
    return `Config: ${step.params.paramName}`;
  }

  return 'Parameterized';
}

module.exports = { getStepLabel, getStepDescription, getParamStatusLabel };
