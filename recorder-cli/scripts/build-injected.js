/*
Copyright (c) 2026, salesforce.com, inc.
All rights reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
For full license text, see LICENSE.txt file in the repo root or http://www.apache.org/licenses/LICENSE-2.0
*/

/**
 * Pre-builds the injected browser script into a static bundle.
 *
 * Run this before packaging the VS Code extension so that esbuild
 * is NOT required at runtime. This eliminates cross-platform issues
 * with esbuild's native binaries when the extension is packaged on
 * one OS and installed on another.
 *
 * Usage:
 *   node scripts/build-injected.js
 */
import esbuild from 'esbuild'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const entryPoint = path.join(projectRoot, 'src', 'injected', 'entry.js')
const outFile = path.join(projectRoot, 'dist', 'injected-bundle.js')

async function build() {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    define: {
      'process.env.NODE_ENV': '"production"'
    },
    minify: false, // Keep readable for debugging
  })

  fs.writeFileSync(outFile, result.outputFiles[0].text)
  console.log(`  ✓ Injected script bundle written to: ${outFile}`)
}

build().catch((err) => {
  console.error('Build failed:', err)
  process.exit(1)
})
