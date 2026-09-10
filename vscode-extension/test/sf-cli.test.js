jest.mock('child_process', () => ({ execFile: jest.fn() }))
jest.mock('../resolve-node', () => ({ getExtendedPath: jest.fn(() => '/mock/extended/path') }))

const { execFile } = require('child_process')
const { listSalesforceCliOrgs, loginToNewOrgViaCli } = require('../sf-cli')

function mockExecFile(err, stdout, stderr) {
  execFile.mockImplementation((cmd, args, opts, cb) => cb(err, stdout, stderr))
}

describe('listSalesforceCliOrgs', () => {
  afterEach(() => jest.clearAllMocks())

  it('rejects with a helpful message when sf is not installed', async () => {
    mockExecFile({ code: 'ENOENT' }, '', '')

    await expect(listSalesforceCliOrgs()).rejects.toThrow(/Salesforce CLI \("sf"\) not found/)
  })

  it('rejects using the error message when output cannot be parsed and an error is present', async () => {
    mockExecFile(new Error('spawn failed'), 'not json', '')

    await expect(listSalesforceCliOrgs()).rejects.toThrow('spawn failed')
  })

  it('rejects using stderr when parsing fails and there is no error object', async () => {
    mockExecFile(null, 'not json', 'some stderr output')

    await expect(listSalesforceCliOrgs()).rejects.toThrow('some stderr output')
  })

  it('rejects with a generic message when parsing fails with no error and no stderr', async () => {
    mockExecFile(null, '', '')

    await expect(listSalesforceCliOrgs()).rejects.toThrow('no JSON found')
  })

  it('rejects when the output has an opening brace but no closing brace', async () => {
    mockExecFile(null, '{ unterminated', '')

    await expect(listSalesforceCliOrgs()).rejects.toThrow('no JSON found')
  })

  it('rejects when the braces are present but reversed', async () => {
    mockExecFile(null, '} {', '')

    await expect(listSalesforceCliOrgs()).rejects.toThrow('no JSON found')
  })

  it('rejects when the sliced text between the braces is not valid JSON', async () => {
    mockExecFile(null, '{not valid json}', '')

    await expect(listSalesforceCliOrgs()).rejects.toThrow('no JSON found')
  })

  it('rejects using parsed.message when the CLI reports a non-zero status', async () => {
    mockExecFile(null, JSON.stringify({ status: 1, message: 'auth expired' }), '')

    await expect(listSalesforceCliOrgs()).rejects.toThrow('auth expired')
  })

  it('rejects with a fallback message when a non-zero status has no message', async () => {
    mockExecFile(null, JSON.stringify({ status: 2 }), '')

    await expect(listSalesforceCliOrgs()).rejects.toThrow('sf org list failed (status 2)')
  })

  it('resolves to an empty array when result is missing entirely', async () => {
    mockExecFile(null, JSON.stringify({ status: 0 }), '')

    await expect(listSalesforceCliOrgs()).resolves.toEqual([])
  })

  it('dedupes orgs across buckets, drops disconnected orgs, and normalizes fields', async () => {
    const shared = {
      username: 'dup@example.com',
      alias: 'dup',
      instanceUrl: 'https://dup.my.salesforce.com',
      connectedStatus: 'Connected',
      isScratch: true
    }
    mockExecFile(null, JSON.stringify({
      status: 0,
      result: {
        nonScratchOrgs: [shared],
        scratchOrgs: [shared],
        sandboxes: [{
          username: 'sandbox@example.com',
          connectedStatus: 'Connected',
          instanceUrl: 'https://sandbox.my.salesforce.com',
          isSandbox: true
        }],
        other: [{
          username: 'disconnected@example.com',
          connectedStatus: 'Disconnected',
          instanceUrl: 'https://x.my.salesforce.com'
        }]
      }
    }), '')

    const orgs = await listSalesforceCliOrgs()

    expect(orgs).toEqual([
      { username: 'dup@example.com', alias: 'dup', instanceUrl: 'https://dup.my.salesforce.com', isScratch: true, isSandbox: false },
      { username: 'sandbox@example.com', alias: null, instanceUrl: 'https://sandbox.my.salesforce.com', isScratch: false, isSandbox: true }
    ])
  })

  it('passes an extended PATH env to execFile', async () => {
    mockExecFile(null, JSON.stringify({ status: 0, result: {} }), '')

    await listSalesforceCliOrgs()

    expect(execFile).toHaveBeenCalledWith(
      'sf',
      ['org', 'list', '--json'],
      expect.objectContaining({ env: expect.objectContaining({ PATH: '/mock/extended/path' }) }),
      expect.any(Function)
    )
  })
})

describe('loginToNewOrgViaCli', () => {
  afterEach(() => jest.clearAllMocks())

  it('rejects with a helpful message when sf is not installed', async () => {
    mockExecFile({ code: 'ENOENT' }, '', '')

    await expect(loginToNewOrgViaCli()).rejects.toThrow(/Salesforce CLI \("sf"\) not found/)
  })

  it('rejects using the error message when output cannot be parsed and an error is present', async () => {
    mockExecFile(new Error('spawn failed'), 'not json', '')

    await expect(loginToNewOrgViaCli()).rejects.toThrow('spawn failed')
  })

  it('rejects using stderr when parsing fails and there is no error object', async () => {
    mockExecFile(null, 'not json', 'some stderr output')

    await expect(loginToNewOrgViaCli()).rejects.toThrow('some stderr output')
  })

  it('rejects with a generic message when parsing fails with no error and no stderr', async () => {
    mockExecFile(null, '', '')

    await expect(loginToNewOrgViaCli()).rejects.toThrow('no JSON found')
  })

  it('rejects using parsed.message when the CLI reports a non-zero status', async () => {
    mockExecFile(null, JSON.stringify({ status: 1, message: 'login failed' }), '')

    await expect(loginToNewOrgViaCli()).rejects.toThrow('login failed')
  })

  it('rejects with a fallback message when a non-zero status has no message', async () => {
    mockExecFile(null, JSON.stringify({ status: 2 }), '')

    await expect(loginToNewOrgViaCli()).rejects.toThrow('sf org login web failed (status 2)')
  })

  it('resolves with all-undefined fields when result is missing entirely', async () => {
    mockExecFile(null, JSON.stringify({ status: 0 }), '')

    await expect(loginToNewOrgViaCli()).resolves.toEqual({ username: undefined, alias: null, instanceUrl: undefined })
  })

  it('resolves with the newly authenticated org', async () => {
    mockExecFile(null, JSON.stringify({
      status: 0,
      result: { username: 'new@example.com', alias: 'newOrg', instanceUrl: 'https://new.my.salesforce.com' }
    }), '')

    await expect(loginToNewOrgViaCli()).resolves.toEqual({
      username: 'new@example.com',
      alias: 'newOrg',
      instanceUrl: 'https://new.my.salesforce.com'
    })
  })

  it('passes an extended PATH env to execFile', async () => {
    mockExecFile(null, JSON.stringify({ status: 0, result: {} }), '')

    await loginToNewOrgViaCli()

    expect(execFile).toHaveBeenCalledWith(
      'sf',
      ['org', 'login', 'web', '--json'],
      expect.objectContaining({ env: expect.objectContaining({ PATH: '/mock/extended/path' }) }),
      expect.any(Function)
    )
  })

  it('kills the login process when cancelled, but only rejects once the process has actually exited', async () => {
    // Regression test: rejecting as soon as kill() is *called* (rather than
    // once the process has actually died) let an immediate retry race the
    // still-shutting-down process for the fixed OAuth redirect port,
    // surfacing "Cannot start the OAuth redirect server on port 1717".
    let execCb
    const child = { kill: jest.fn() }
    execFile.mockImplementation((cmd, args, opts, cb) => {
      execCb = cb // never invoked yet — simulates an in-flight browser login
      return child
    })
    let onCancel
    const token = { onCancellationRequested: (fn) => { onCancel = fn } }

    const promise = loginToNewOrgViaCli(token)
    onCancel()

    expect(child.kill).toHaveBeenCalled()

    let settled = false
    promise.then(() => { settled = true }, () => { settled = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false) // process hasn't exited yet — must not settle

    execCb(new Error('Killed'), '', '') // process finally exits after the signal

    await expect(promise).rejects.toThrow('Login cancelled.')
  })
})
