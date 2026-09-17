/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

const fs = require('fs');
const path = require('path');

/**
 * The packaged VSIX ships pre-bundled dist/cli.mjs and dist/mcp-server.mjs
 * (built by scripts/build-packaged-bundles.js) instead of recorder-cli/src
 * and mcp-server/index.js + node_modules — the unbundled node_modules tree
 * was large enough in file count that registry publish uploads timed out.
 * A dev checkout has no dist/ build, so these fall back to the raw source.
 */
function resolveCliPath(root) {
  const bundled = path.join(root, 'recorder-cli', 'dist', 'cli.mjs');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(root, 'recorder-cli', 'bin', 'cli.js');
}

function resolveMcpServerPath(root) {
  const bundled = path.join(root, 'recorder-cli', 'dist', 'mcp-server.mjs');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(root, 'mcp-server', 'index.js');
}

module.exports = { resolveCliPath, resolveMcpServerPath };
