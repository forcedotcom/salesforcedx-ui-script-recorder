const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class FileListTreeProvider {
  constructor(subdir) {
    this._subdir = subdir;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getParent() {
    return null;
  }

  getFirstChild() {
    const children = this.getChildren();
    return children.length > 0 ? children[0] : null;
  }

  getChildren() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return [];

    const dir = path.join(workspaceFolder.uri.fsPath, this._subdir);
    if (!fs.existsSync(dir)) return [];

    let entries;
    try {
      entries = fs.readdirSync(dir).filter((f) => {
        const full = path.join(dir, f);
        return fs.statSync(full).isFile();
      });
    } catch {
      return [];
    }

    entries.sort();

    return entries.map((file) => {
      const filePath = path.join(dir, file);
      const label = this._subdir === 'auth-states' ? formatAuthStateLabel(file) : file;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.resourceUri = vscode.Uri.file(filePath);
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(filePath)] };
      item.iconPath = new vscode.ThemeIcon(this._subdir === 'auth-states' ? 'lock' : 'file');
      item.tooltip = file;
      return item;
    });
  }
}

function formatAuthStateLabel(filename) {
  const base = filename.replace(/\.json$/, '');
  const parts = base.split('---');
  if (parts.length >= 2) {
    return `${parts[1]} @ ${parts[0]}`;
  }
  return base;
}

module.exports = { FileListTreeProvider };
