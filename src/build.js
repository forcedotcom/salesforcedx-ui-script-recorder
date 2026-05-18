import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Builds the injected script that will run inside the browser page.
 * This bundles the recorder, overlay, selector, and finder into a single
 * self-executing script that communicates back via WebSocket.
 *
 * In production (packaged extension), uses a pre-built bundle from dist/
 * to avoid requiring esbuild's platform-specific native binary at runtime.
 * Falls back to live esbuild compilation for development.
 */
export async function buildInjectedScript() {
  // Prefer the pre-built bundle (created by: npm run build:injected)
  const prebuiltPath = path.join(__dirname, '..', 'dist', 'injected-bundle.js')
  if (fs.existsSync(prebuiltPath)) {
    return fs.readFileSync(prebuiltPath, 'utf-8')
  }

  // Fallback: build on-the-fly with esbuild (development only)
  let esbuild
  try {
    esbuild = (await import('esbuild')).default
  } catch (err) {
    throw new Error(
      'Pre-built injected script not found and esbuild is not available.\n' +
      'Run "npm run build:injected" first, or install esbuild for your platform.\n' +
      `  Looked for bundle at: ${prebuiltPath}`
    )
  }

  const entryPoint = path.join(__dirname, 'injected', 'entry.js')

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

  return result.outputFiles[0].text
}
