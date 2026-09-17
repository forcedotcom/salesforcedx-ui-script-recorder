/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * Pre-bundles the recorder CLI and MCP server into single dependency-free
 * files under recorder-cli/dist/. Run before packaging the VS Code extension
 * so the VSIX ships these two bundles instead of node_modules + recorder-cli/src
 * — the unbundled node_modules tree (many small files from packages we only
 * use a slice of, e.g. the MCP SDK's unused HTTP/SSE transport deps) was
 * large enough that `ovsx`/`vsce publish` uploads were timing out against
 * the registries.
 *
 * Built as ESM (.mjs), not CJS: recorder-cli/src/index.js and build.js use
 * `import.meta.url` (via createRequire and fileURLToPath) to locate the
 * installed `playwright` package and the pre-built injected-script bundle
 * relative to their own file location — esbuild leaves `import.meta.url`
 * empty in CJS output, but resolves it correctly per-bundle in ESM output.
 * That's also why playwright/@playwright/test/playwright-core stay external:
 * they locate their own driver/browser binaries via paths relative to their
 * installed package directory, which breaks if inlined into a bundle.
 *
 * Usage:
 *   node scripts/build-packaged-bundles.js
 */
import esbuild from 'esbuild'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const outDir = path.join(projectRoot, 'recorder-cli', 'dist')

const builds = [
  {
    name: 'cli',
    entryPoint: path.join(projectRoot, 'recorder-cli', 'bin', 'cli.js'),
    outFile: path.join(outDir, 'cli.mjs'),
    external: ['playwright', 'playwright-core', '@playwright/test', 'esbuild'],
  },
  {
    name: 'mcp-server',
    entryPoint: path.join(projectRoot, 'mcp-server', 'index.js'),
    outFile: path.join(outDir, 'mcp-server.mjs'),
    external: [],
  },
]

async function build({ name, entryPoint, outFile, external }) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    external,
    minify: false, // Keep readable for debugging
    // Bundled CJS deps (e.g. commander) call require() on node builtins at
    // their own top level; esbuild can't statically hoist those into ESM
    // imports since they're inside a wrapped CJS closure, and its own
    // fallback shim just throws in ESM output. A real `require`, shimmed via
    // createRequire, makes those calls work at runtime instead.
    banner: {
      js: "import { createRequire as __createRequire } from 'module';\nconst require = __createRequire(import.meta.url);",
    },
  })

  let output = result.outputFiles[0].text
  if (!output.startsWith('#!')) {
    output = `#!/usr/bin/env node\n${output}`
  }
  fs.writeFileSync(outFile, output, { mode: 0o755 })
  console.log(`  ✓ ${name} bundle written to: ${outFile}`)
}

async function main() {
  for (const b of builds) {
    await build(b)
  }
}

main().catch((err) => {
  console.error('Build failed:', err)
  process.exit(1)
})
