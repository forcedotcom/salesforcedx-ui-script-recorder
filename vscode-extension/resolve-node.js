const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let cachedNodePath = null;

function resolveNodePath() {
  if (cachedNodePath) return cachedNodePath;

  const isWindows = process.platform === 'win32';

  try {
    if (isWindows) {
      const result = execFileSync('where', ['node'], { encoding: 'utf-8', timeout: 5000 }).trim();
      cachedNodePath = result.split('\r\n')[0];
    } else {
      const result = execFileSync('/bin/sh', ['-c', 'command -v node'], {
        encoding: 'utf-8',
        timeout: 5000,
        env: { ...process.env, PATH: getExtendedPath() },
      }).trim();
      cachedNodePath = result.split('\n')[0];
    }
  } catch {
    cachedNodePath = process.execPath;
  }

  return cachedNodePath;
}

function getExtendedPath() {
  const currentPath = process.env.PATH || '';
  if (process.platform === 'win32') return currentPath;
  const home = process.env.HOME || '';
  const extras = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  const nvmDir = path.join(home, '.nvm', 'versions', 'node');
  try {
    const versions = fs.readdirSync(nvmDir);
    versions.forEach((v) => extras.push(path.join(nvmDir, v, 'bin')));
  } catch {}
  const fnmDir = path.join(home, '.fnm', 'aliases', 'default', 'bin');
  if (fs.existsSync(fnmDir)) extras.push(fnmDir);
  const voltaDir = path.join(home, '.volta', 'bin');
  if (fs.existsSync(voltaDir)) extras.push(voltaDir);
  return [...extras, currentPath].join(':');
}

module.exports = { resolveNodePath };
