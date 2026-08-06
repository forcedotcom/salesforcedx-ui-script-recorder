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
const { getStepLabel, getParamStatusLabel } = require('./step-labels');

class RecordingCodeLensProvider {
  constructor() {
    this._onDidChangeCodeLenses = new vscode.EventEmitter();
    this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  }

  refresh() {
    this._onDidChangeCodeLenses.fire();
  }

  provideCodeLenses(document) {
    if (document.fileName.endsWith('.spec.js')) {
      return this._provideSpecLenses(document);
    }
    return this._provideJsonLenses(document);
  }

  _provideJsonLenses(document) {
    const text = document.getText();
    let recording;
    try {
      recording = JSON.parse(text);
    } catch {
      return [];
    }

    if (!recording || !Array.isArray(recording.steps)) {
      return [];
    }

    // Only show the reconvert lens on JSON files
    return [
      new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
        title: '$(refresh) Re-convert to Playwright',
        command: 'sf-ui-recorder.reconvert',
        arguments: [document.uri],
      })
    ];
  }

  _provideSpecLenses(document) {
    const lenses = [];

    // Top-of-file lens to view playback results, shown only when this spec has
    // associated result folders in playback-results/.
    const resultsLens = this._buildResultsLens(document);
    if (resultsLens) lenses.push(resultsLens);

    // Find the corresponding JSON file
    const jsonPath = document.fileName.replace(/\.spec\.js$/, '.json');
    if (!fs.existsSync(jsonPath)) {
      return lenses;
    }

    let recording;
    try {
      recording = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    } catch {
      return lenses;
    }

    if (!recording?.steps) return lenses;

    const jsonUri = vscode.Uri.file(jsonPath);
    const text = document.getText();
    const lines = text.split('\n');

    // Map fill/click lines back to change steps by finding page.fill() calls
    // and matching them in order to change steps
    let changeStepIndex = 0;
    const changeSteps = [];
    for (let i = 0; i < recording.steps.length; i++) {
      const step = recording.steps[i];
      if (step.type === 'change') {
        changeSteps.push({ step, originalIndex: i });
      }
    }

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];

      if (/await\s+page\.fill\(/.test(line) && changeStepIndex < changeSteps.length) {
        const { step, originalIndex } = changeSteps[changeStepIndex];
        const range = new vscode.Range(lineNum, 0, lineNum, 0);
        const paramStatus = getParamStatusLabel(step);

        // Skip username/password auto-parameterized steps
        const ariaSelector = step.selectors?.find((sel) => sel[0]?.startsWith('aria/'));
        const isAutoParam = ariaSelector &&
          (ariaSelector[0].startsWith('aria/Username') || ariaSelector[0].startsWith('aria/Password'));

        if (!isAutoParam) {
          if (paramStatus) {
            lenses.push(
              new vscode.CodeLens(range, {
                title: `$(symbol-parameter) ${paramStatus}`,
                command: 'sf-ui-recorder.parameterizeStep',
                arguments: [jsonUri, originalIndex],
              })
            );
          } else {
            const label = getStepLabel(step);
            lenses.push(
              new vscode.CodeLens(range, {
                title: `$(add) Parameterize "${label}"`,
                command: 'sf-ui-recorder.parameterizeStep',
                arguments: [jsonUri, originalIndex],
              })
            );
          }
        }

        changeStepIndex++;
      }
    }

    return lenses;
  }

  // Returns a "View Playback Results" CodeLens for the top of a spec file when
  // that spec has at least one matching result folder, otherwise null.
  _buildResultsLens(document) {
    const workspaceFolder =
      vscode.workspace.getWorkspaceFolder(document.uri) ||
      vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return null;

    const resultsDir = path.join(workspaceFolder.uri.fsPath, 'playback-results');
    if (!fs.existsSync(resultsDir)) return null;

    // Spec name is the file basename without the .spec.js suffix; result folders
    // are named "<specName>---...". Match on the first "---" segment exactly.
    const specName = path.basename(document.fileName).replace(/\.spec\.js$/, '');

    let hasResults = false;
    try {
      const entries = fs.readdirSync(resultsDir);
      hasResults = entries.some((entry) => {
        if (entry.split('---')[0] !== specName) return false;
        const full = path.join(resultsDir, entry);
        try {
          if (!fs.statSync(full).isDirectory()) return false;
          if (fs.existsSync(path.join(full, 'results.json'))) return true;
          // Nested BULK folder — check for session subfolders with results
          if (entry.endsWith('---BULK')) {
            return fs.readdirSync(full).some((sub) => {
              return fs.existsSync(path.join(full, sub, 'results.json'));
            });
          }
          return false;
        } catch {
          return false;
        }
      });
    } catch {
      return null;
    }

    if (!hasResults) return null;

    return new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      title: '$(graph) View Playback Results',
      command: 'sf-ui-recorder.viewResults',
      arguments: [document.uri],
    });
  }
}

function findStepPositions(text, steps) {
  const lines = text.split('\n');
  const positions = new Array(steps.length).fill(-1);

  // Find the "steps" array start
  let inSteps = false;
  let braceDepth = 0;
  let stepIndex = 0;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    if (!inSteps) {
      if (/"steps"\s*:\s*\[/.test(line)) {
        inSteps = true;
        braceDepth = 0;
        // Check if the opening { of first step is on this same line
        if (line.includes('{')) {
          braceDepth = 1;
          if (stepIndex < steps.length) {
            positions[stepIndex] = lineNum;
          }
        }
      }
      continue;
    }

    // Inside the steps array
    for (let ch = 0; ch < line.length; ch++) {
      const c = line[ch];
      if (c === '{') {
        braceDepth++;
        if (braceDepth === 1) {
          // Start of a new step object
          if (stepIndex < steps.length) {
            positions[stepIndex] = lineNum;
          }
        }
      } else if (c === '}') {
        braceDepth--;
        if (braceDepth === 0) {
          stepIndex++;
        }
      } else if (c === ']' && braceDepth === 0) {
        // End of steps array
        inSteps = false;
        break;
      }
    }

    if (!inSteps) break;
  }

  return positions;
}

module.exports = { RecordingCodeLensProvider };
