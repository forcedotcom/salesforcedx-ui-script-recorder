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
    if (!editor || !editor.document.fileName.match(/recording.*\.json$/)) {
      return;
    }

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

module.exports = { register };
