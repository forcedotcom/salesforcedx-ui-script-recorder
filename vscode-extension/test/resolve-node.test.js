jest.mock('fs')
jest.mock('child_process', () => ({ execFileSync: jest.fn() }))

const path = require('path')

function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    fn()
  } finally {
    Object.defineProperty(process, 'platform', original)
  }
}

describe('resolveNodePath', () => {
  let execFileSync
  let resolveNodePath

  beforeEach(() => {
    jest.resetModules()
    execFileSync = require('child_process').execFileSync
    resolveNodePath = require('../resolve-node').resolveNodePath
  })

  it('caches the resolved path across calls, only invoking the shell once', () => {
    withPlatform('darwin', () => {
      execFileSync.mockReturnValue('/usr/local/bin/node\n')

      const first = resolveNodePath()
      execFileSync.mockReturnValue('/should-not-be-used\n')
      const second = resolveNodePath()

      expect(first).toBe('/usr/local/bin/node')
      expect(second).toBe('/usr/local/bin/node')
      expect(execFileSync).toHaveBeenCalledTimes(1)
    })
  })

  it('resolves via "where" and takes the first line on Windows', () => {
    withPlatform('win32', () => {
      execFileSync.mockReturnValue('C:\\nvm\\node.exe\r\nC:\\other\\node.exe')

      expect(resolveNodePath()).toBe('C:\\nvm\\node.exe')
      expect(execFileSync).toHaveBeenCalledWith('where', ['node'], expect.objectContaining({ encoding: 'utf-8' }))
    })
  })

  it('falls back to process.execPath when "where" fails on Windows', () => {
    withPlatform('win32', () => {
      execFileSync.mockImplementation(() => { throw new Error('not found') })

      expect(resolveNodePath()).toBe(process.execPath)
    })
  })

  it('resolves via "command -v node" and takes the first line on non-Windows', () => {
    withPlatform('linux', () => {
      execFileSync.mockReturnValue('/usr/bin/node\nextra-line')

      expect(resolveNodePath()).toBe('/usr/bin/node')
      expect(execFileSync).toHaveBeenCalledWith('/bin/sh', ['-c', 'command -v node'], expect.objectContaining({ encoding: 'utf-8' }))
    })
  })

  it('falls back to process.execPath when "command -v node" fails on non-Windows', () => {
    withPlatform('linux', () => {
      execFileSync.mockImplementation(() => { throw new Error('not found') })

      expect(resolveNodePath()).toBe(process.execPath)
    })
  })
})

describe('getExtendedPath', () => {
  const originalEnv = process.env
  let fs
  let getExtendedPath

  beforeEach(() => {
    jest.resetModules()
    fs = require('fs')
    getExtendedPath = require('../resolve-node').getExtendedPath
    process.env = { ...originalEnv, PATH: '/usr/bin', HOME: '/home/tester' }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns the current PATH unchanged on Windows', () => {
    withPlatform('win32', () => {
      expect(getExtendedPath()).toBe('/usr/bin')
    })
  })

  it('appends nvm versions, fnm, and volta bin dirs when all are present', () => {
    withPlatform('darwin', () => {
      fs.readdirSync.mockReturnValue(['v18.0.0', 'v20.0.0'])
      fs.existsSync.mockReturnValue(true)

      const result = getExtendedPath()

      expect(result).toContain('/usr/local/bin')
      expect(result).toContain('/opt/homebrew/bin')
      expect(result).toContain(path.join('/home/tester', '.nvm', 'versions', 'node', 'v18.0.0', 'bin'))
      expect(result).toContain(path.join('/home/tester', '.nvm', 'versions', 'node', 'v20.0.0', 'bin'))
      expect(result).toContain(path.join('/home/tester', '.fnm', 'aliases', 'default', 'bin'))
      expect(result).toContain(path.join('/home/tester', '.volta', 'bin'))
      expect(result.endsWith(':/usr/bin')).toBe(true)
    })
  })

  it('skips nvm/fnm/volta entries when none are present', () => {
    withPlatform('darwin', () => {
      fs.readdirSync.mockImplementation(() => { throw new Error('ENOENT') })
      fs.existsSync.mockReturnValue(false)

      const result = getExtendedPath()

      expect(result).toBe(['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'].join(':'))
    })
  })

  it('defaults HOME to an empty string when unset', () => {
    withPlatform('darwin', () => {
      delete process.env.HOME
      fs.readdirSync.mockImplementation(() => { throw new Error('ENOENT') })
      fs.existsSync.mockReturnValue(false)

      expect(() => getExtendedPath()).not.toThrow()
    })
  })

  it('defaults the current PATH to an empty string when unset', () => {
    withPlatform('darwin', () => {
      delete process.env.PATH
      fs.readdirSync.mockImplementation(() => { throw new Error('ENOENT') })
      fs.existsSync.mockReturnValue(false)

      expect(getExtendedPath()).toBe(['/usr/local/bin', '/opt/homebrew/bin', ''].join(':'))
    })
  })
})
