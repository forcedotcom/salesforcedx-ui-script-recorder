/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

const vscode = require('vscode');
const path = require('path');

function register(context) {
  const paramDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: path.join(__dirname, '..', 'images', 'param-icon.svg'),
    gutterIconSize: '80%',
    overviewRulerColor: '#4ec9b0',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  function updateDecorations(editor) {
    if (!editor) return;

    const fileName = editor.document.fileName;

    if (fileName.match(/recording.*\.spec\.js$/)) {
      updateSpecDecorations(editor, paramDecoration);
    } else if (fileName.match(/recording.*\.json$/)) {
      updateJsonDecorations(editor, paramDecoration);
    }
  }

  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => updateDecorations(editor)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && e.document === editor.document) {
        updateDecorations(editor);
      }
    })
  );
}

function updateJsonDecorations(editor, paramDecoration) {
  let recording;
  try {
    recording = JSON.parse(editor.document.getText());
  } catch {
    return;
  }

  if (!recording?.steps) return;

  const text = editor.document.getText();
  const lines = text.split('\n');
  const decorations = [];

  let inSteps = false;
  let braceDepth = 0;
  let stepIndex = 0;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];

    if (!inSteps) {
      if (/"steps"\s*:\s*\[/.test(line)) {
        inSteps = true;
        braceDepth = 0;
        if (line.includes('{')) {
          braceDepth = 1;
          if (recording.steps[stepIndex]?.params?.parameterise) {
            decorations.push({ range: new vscode.Range(lineNum, 0, lineNum, 0) });
          }
        }
      }
      continue;
    }

    for (let ch = 0; ch < line.length; ch++) {
      const c = line[ch];
      if (c === '{') {
        braceDepth++;
        if (braceDepth === 1) {
          if (recording.steps[stepIndex]?.params?.parameterise) {
            decorations.push({ range: new vscode.Range(lineNum, 0, lineNum, 0) });
          }
        }
      } else if (c === '}') {
        braceDepth--;
        if (braceDepth === 0) stepIndex++;
      } else if (c === ']' && braceDepth === 0) {
        inSteps = false;
        break;
      }
    }

    if (!inSteps) break;
  }

  editor.setDecorations(paramDecoration, decorations);
}

function updateSpecDecorations(editor, paramDecoration) {
  const fs = require('fs');
  const jsonPath = editor.document.fileName.replace(/\.spec\.js$/, '.json');
  if (!fs.existsSync(jsonPath)) return;

  let recording;
  try {
    recording = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  } catch {
    return;
  }

  if (!recording?.steps) return;

  const changeSteps = [];
  for (let i = 0; i < recording.steps.length; i++) {
    if (recording.steps[i].type === 'change') {
      changeSteps.push(recording.steps[i]);
    }
  }

  const text = editor.document.getText();
  const lines = text.split('\n');
  const decorations = [];
  let changeStepIndex = 0;

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    if (/await\s+page\.fill\(/.test(line) && changeStepIndex < changeSteps.length) {
      if (changeSteps[changeStepIndex].params?.parameterise) {
        decorations.push({ range: new vscode.Range(lineNum, 0, lineNum, 0) });
      }
      changeStepIndex++;
    }
  }

  editor.setDecorations(paramDecoration, decorations);
}

module.exports = { register };
