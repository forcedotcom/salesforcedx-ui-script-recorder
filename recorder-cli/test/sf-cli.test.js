jest.mock('child_process', () => ({ execFile: jest.fn() }))

import { execFile } from 'child_process'
import { listOrgs, getFrontdoorUrl, sanitizeFrontdoor } from '../src/sf-cli.js'

function respondWith(stdout, { err = null, stderr = '' } = {}) {
  execFile.mockImplementation((cmd, args, opts, cb) => {
    cb(err, stdout, stderr)
  })
}

describe('sf-cli', () => {
  afterEach(() => {
    execFile.mockReset()
  })

  describe('listOrgs', () => {
    it('flattens org buckets, dedupes by username, and skips disconnected orgs', async () => {
      respondWith(
        JSON.stringify({
          status: 0,
          result: {
            nonScratchOrgs: [
              { username: 'a@x.com', alias: 'A', instanceUrl: 'https://a', connectedStatus: 'Connected', isScratch: false, isSandbox: false }
            ],
            scratchOrgs: [
              { username: 'a@x.com', alias: 'A-dup', instanceUrl: 'https://a', connectedStatus: 'Connected' },
              { username: 'b@x.com', instanceUrl: 'https://b', connectedStatus: 'Connected', isScratch: true }
            ],
            other: [{ username: 'c@x.com', instanceUrl: 'https://c', connectedStatus: 'Disconnected' }]
          }
        })
      )

      const orgs = await listOrgs()

      expect(orgs).toEqual([
        { username: 'a@x.com', alias: 'A', instanceUrl: 'https://a', isScratch: false, isSandbox: false },
        { username: 'b@x.com', alias: null, instanceUrl: 'https://b', isScratch: true, isSandbox: false }
      ])
    })

    it('tolerates missing bucket keys and skips over text preceding the JSON payload', async () => {
      respondWith('Warning: an update is available\n' + JSON.stringify({ status: 0, result: {} }))

      expect(await listOrgs()).toEqual([])
    })

    it('rejects when the sf CLI is not installed', async () => {
      respondWith('', { err: Object.assign(new Error('not found'), { code: 'ENOENT' }) })

      await expect(listOrgs()).rejects.toThrow(/Salesforce CLI \("sf"\) not found on PATH/)
    })

    it('rejects with the CLI-provided message when the JSON payload reports a failure status', async () => {
      respondWith(JSON.stringify({ status: 1, message: 'org list failed' }))

      await expect(listOrgs()).rejects.toThrow('org list failed')
    })

    it('rejects with a generic message when a failure status has no message', async () => {
      respondWith(JSON.stringify({ status: 1 }))

      await expect(listOrgs()).rejects.toThrow(/failed \(status 1\)/)
    })

    it('rejects using the underlying error message when no JSON can be parsed', async () => {
      respondWith('totally not json', { err: new Error('boom') })

      await expect(listOrgs()).rejects.toThrow(/Failed to parse output.*boom/)
    })

    it('rejects using stderr when there is no error object but stdout has no JSON', async () => {
      respondWith('nothing here', { stderr: 'some stderr output' })

      await expect(listOrgs()).rejects.toThrow(/Failed to parse output.*some stderr output/)
    })

    it('rejects with "no JSON found" when there is no error, no stderr, and no parseable JSON', async () => {
      respondWith('')

      await expect(listOrgs()).rejects.toThrow(/no JSON found/)
    })

    it('rejects when the JSON braces are present but the content between them is invalid', async () => {
      respondWith('{not: valid, json}')

      await expect(listOrgs()).rejects.toThrow(/no JSON found/)
    })
  })

  describe('getFrontdoorUrl', () => {
    it('requires an org username or alias', async () => {
      await expect(getFrontdoorUrl()).rejects.toThrow('getFrontdoorUrl() requires an org username or alias')
      expect(execFile).not.toHaveBeenCalled()
    })

    it('requests a url-only frontdoor link for the given org', async () => {
      respondWith(JSON.stringify({ status: 0, result: { url: 'https://org.my.salesforce.com/secur/frontdoor.jsp?sid=TOKEN' } }))

      const url = await getFrontdoorUrl('myOrgAlias')

      expect(url).toBe('https://org.my.salesforce.com/secur/frontdoor.jsp?sid=TOKEN')
      const [, args] = execFile.mock.calls[0]
      expect(args).toEqual(['org', 'open', '-o', 'myOrgAlias', '--url-only', '--json'])
    })

    it('includes a --path argument when a landing path is requested', async () => {
      respondWith(JSON.stringify({ status: 0, result: { url: 'https://org.my.salesforce.com/frontdoor?sid=TOKEN' } }))

      await getFrontdoorUrl('myOrgAlias', { path: '/lightning/page' })

      const [, args] = execFile.mock.calls[0]
      expect(args).toEqual(['org', 'open', '-o', 'myOrgAlias', '--url-only', '--path', '/lightning/page', '--json'])
    })

    it('throws when the CLI succeeds but returns no url', async () => {
      respondWith(JSON.stringify({ status: 0, result: {} }))

      await expect(getFrontdoorUrl('myOrgAlias')).rejects.toThrow(/did not return a URL/)
    })
  })

  describe('sanitizeFrontdoor', () => {
    it('strips the session token, keeping only the retURL destination', () => {
      const frontdoor = 'https://org.my.salesforce.com/secur/frontdoor.jsp?sid=SECRET_TOKEN&retURL=%2Flightning%2Fpage'
      expect(sanitizeFrontdoor(frontdoor)).toBe('https://org.my.salesforce.com/lightning/page')
    })

    it('falls back to the origin when there is no retURL', () => {
      const frontdoor = 'https://org.my.salesforce.com/secur/frontdoor.jsp?sid=SECRET_TOKEN'
      expect(sanitizeFrontdoor(frontdoor)).toBe('https://org.my.salesforce.com/')
    })

    it('returns the original string unchanged when it is not a valid URL', () => {
      expect(sanitizeFrontdoor('not-a-url')).toBe('not-a-url')
    })
  })
})
