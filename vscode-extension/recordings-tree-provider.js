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

class RecordingsTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getParent(element) {
    return element._parent || null;
  }

  findResultElement(resultFolderName) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return null;

    const resultsDir = path.join(workspaceFolder.uri.fsPath, 'playback-results');
    if (!fs.existsSync(resultsDir)) return null;

    // Handle sub-paths like "specName---ts---BULK/session-1"
    const segments = resultFolderName.split('/');
    const topFolder = segments[0];
    const subFolder = segments.length > 1 ? segments.slice(1).join('/') : null;

    const specName = topFolder.split('---')[0];
    const topFolderPath = path.join(resultsDir, topFolder);
    if (!fs.existsSync(topFolderPath)) return null;

    // Build the chain: recording -> resultsGroup -> resultFolder [-> subFolder]
    const recording = new vscode.TreeItem(specName, vscode.TreeItemCollapsibleState.Collapsed);
    recording._type = 'recording';
    recording.baseName = specName;

    const group = new vscode.TreeItem('Playback Results', vscode.TreeItemCollapsibleState.Collapsed);
    group._type = 'resultsGroup';
    group._baseName = specName;
    group._parent = recording;

    const isBulk = topFolder.endsWith('---BULK');
    const parts = topFolder.split('---');
    const timestamp = parts[1] || topFolder;
    const label = isBulk ? `${timestamp} (Bulk)` : timestamp;

    const resultItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    resultItem._type = 'resultFolder';
    resultItem._folderPath = topFolderPath;
    resultItem._parent = group;

    if (!subFolder) return resultItem;

    // Build the sub-folder element (e.g. session-1)
    const subFolderPath = path.join(topFolderPath, subFolder);
    if (!fs.existsSync(subFolderPath)) return resultItem;

    const subItem = new vscode.TreeItem(subFolder, vscode.TreeItemCollapsibleState.Collapsed);
    subItem._type = 'resultFolder';
    subItem._folderPath = subFolderPath;
    subItem._parent = resultItem;

    return subItem;
  }

  getChildren(element) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) return [];

    const recordingsDir = path.join(workspaceFolder.uri.fsPath, 'test-plans', 'playwright');
    const resultsDir = path.join(workspaceFolder.uri.fsPath, 'playback-results');

    if (!fs.existsSync(recordingsDir)) return [];

    // Level 3: files inside a playback result folder
    if (element && element._type === 'resultFolder') {
      return listResultFolderContents(element._folderPath);
    }

    // Level 2: children of a recording (files + playback results group)
    if (element && element._type === 'recording') {
      return getRecordingChildren(recordingsDir, resultsDir, element.baseName);
    }

    // Level 2: children of the "Playback Results" group node
    if (element && element._type === 'resultsGroup') {
      return getResultFolders(resultsDir, element._baseName);
    }

    // Level 1: top-level recordings
    return getTopLevelRecordings(recordingsDir, resultsDir);
  }
}

function getTopLevelRecordings(recordingsDir, resultsDir) {
  const entries = fs.readdirSync(recordingsDir);
  const jsonFiles = entries.filter((f) => f.endsWith('.json'));
  const hasResultsFor = buildResultsSet(resultsDir);
  const recordings = [];

  for (const jsonFile of jsonFiles) {
    const baseName = jsonFile.replace(/\.json$/, '');
    const specFile = baseName + '.spec.js';
    const hasSpec = entries.includes(specFile);

    const item = new vscode.TreeItem(
      baseName,
      hasSpec ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    item._type = 'recording';
    item.baseName = baseName;
    item.iconPath = new vscode.ThemeIcon('root-folder');
    item.tooltip = baseName;
    item.contextValue = hasResultsFor.has(baseName) ? 'recordingWithResults' : 'recording';

    const specPath = path.join(recordingsDir, specFile);
    const jsonPath = path.join(recordingsDir, jsonFile);
    const openPath = hasSpec ? specPath : jsonPath;
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(openPath)] };

    recordings.push(item);
  }

  recordings.sort((a, b) => b.baseName.localeCompare(a.baseName));
  return recordings;
}

function getRecordingChildren(recordingsDir, resultsDir, baseName) {
  const children = [];
  const jsonPath = path.join(recordingsDir, baseName + '.json');
  const specPath = path.join(recordingsDir, baseName + '.spec.js');

  if (fs.existsSync(jsonPath)) {
    const item = new vscode.TreeItem(baseName + '.json', vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(jsonPath);
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(jsonPath)] };
    item.iconPath = new vscode.ThemeIcon('json');
    item.contextValue = 'recordingFile';
    children.push(item);
  }

  if (fs.existsSync(specPath)) {
    const item = new vscode.TreeItem(baseName + '.spec.js', vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(specPath);
    item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(specPath)] };
    item.iconPath = new vscode.ThemeIcon('file-code');
    item.contextValue = 'recordingFile';
    children.push(item);
  }

  // Add "Playback Results" group if results exist for this recording
  const resultFolders = getResultFoldersForSpec(resultsDir, baseName);
  if (resultFolders.length > 0) {
    const group = new vscode.TreeItem('Playback Results', vscode.TreeItemCollapsibleState.Collapsed);
    group._type = 'resultsGroup';
    group._baseName = baseName;
    group.iconPath = new vscode.ThemeIcon('testing-run-icon');
    group.contextValue = 'resultsGroup';
    children.push(group);
  }

  return children;
}

function getResultFoldersForSpec(resultsDir, baseName) {
  if (!fs.existsSync(resultsDir)) return [];
  try {
    return fs.readdirSync(resultsDir).filter((entry) => {
      if (entry.split('---')[0] !== baseName) return false;
      const full = path.join(resultsDir, entry);
      return fs.statSync(full).isDirectory();
    }).sort().reverse();
  } catch {
    return [];
  }
}

function getResultFolders(resultsDir, baseName) {
  const folders = getResultFoldersForSpec(resultsDir, baseName);
  return folders.map((folder) => {
    const folderPath = path.join(resultsDir, folder);
    const isBulk = folder.endsWith('---BULK');
    const parts = folder.split('---');
    const timestamp = parts[1] || folder;
    const label = isBulk ? `${timestamp} (Bulk)` : timestamp;

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item._type = 'resultFolder';
    item._folderPath = folderPath;
    item.iconPath = new vscode.ThemeIcon(isBulk ? 'folder-library' : 'folder');
    item.tooltip = folder;
    item.contextValue = 'resultFolder';
    return item;
  });
}

function listResultFolderContents(folderPath) {
  if (!fs.existsSync(folderPath)) return [];
  try {
    const entries = fs.readdirSync(folderPath).sort();
    return entries.map((entry) => {
      const full = path.join(folderPath, entry);
      const stat = fs.statSync(full);

      if (stat.isDirectory()) {
        const item = new vscode.TreeItem(entry, vscode.TreeItemCollapsibleState.Collapsed);
        item._type = 'resultFolder';
        item._folderPath = full;
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = 'resultFolder';
        return item;
      }

      const item = new vscode.TreeItem(entry, vscode.TreeItemCollapsibleState.None);
      item.resourceUri = vscode.Uri.file(full);
      item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(full)] };
      item.iconPath = new vscode.ThemeIcon('file');
      item.contextValue = 'resultFile';
      return item;
    });
  } catch {
    return [];
  }
}

function buildResultsSet(resultsDir) {
  const names = new Set();
  if (!fs.existsSync(resultsDir)) return names;
  try {
    for (const entry of fs.readdirSync(resultsDir)) {
      const specName = entry.split('---')[0];
      if (specName) names.add(specName);
    }
  } catch {}
  return names;
}

module.exports = { RecordingsTreeProvider };
