import esbuild from 'esbuild'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/**
 * Builds the injected script that will run inside the browser page.
 * This bundles the recorder, overlay, selector, and finder into a single
 * self-executing script that communicates back via WebSocket.
 */
export async function buildInjectedScript() {
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
