/**
 * Simple config provider for generated Playwright scripts.
 * Set credentials via environment variables:
 *   RECORDER_USERNAME, RECORDER_PASSWORD
 * Or override any key via RECORDER_<KEY> (uppercase).
 */
const config = {
  get(key) {
    const envKey = `RECORDER_${key.toUpperCase()}`
    const value = process.env[envKey]
    if (!value) {
      throw new Error(
        `Missing config "${key}". Set environment variable ${envKey} before running the test.`
      )
    }
    return value
  }
}

export default config
