import { stripVerificationSteps } from '../../src/converter/stripVerificationSteps.js'

describe('stripVerificationSteps', () => {
  it('returns the data unchanged when there are no steps', () => {
    const data = { title: 'Flow' }
    expect(stripVerificationSteps(data)).toBe(data)
  })

  it('returns the data unchanged when steps is an empty array', () => {
    const data = { title: 'Flow', steps: [] }
    expect(stripVerificationSteps(data)).toBe(data)
  })

  it('passes through steps untouched when none trigger verification', () => {
    const data = {
      title: 'Flow',
      steps: [{ type: 'click', assertedEvents: [{ type: 'navigation', url: 'https://x.com/home' }] }, { type: 'change' }]
    }

    const result = stripVerificationSteps(data)

    expect(result).not.toBe(data)
    expect(result.title).toBe('Flow')
    expect(result.steps).toEqual(data.steps)
  })

  it('ignores non-navigation events when checking for a verification trigger', () => {
    const data = {
      steps: [
        {
          type: 'click',
          assertedEvents: [{ type: 'click' }, { type: 'navigation', url: 'https://x.com/home' }]
        }
      ]
    }

    expect(stripVerificationSteps(data).steps).toEqual(data.steps)
  })

  it('detects a verification trigger by title when the url does not match', () => {
    const data = {
      steps: [
        { type: 'click', assertedEvents: [{ type: 'navigation', title: 'Verify Your Identity' }] },
        { type: 'click', assertedEvents: [{ type: 'navigation', url: 'https://x.com/lightning/home' }] }
      ]
    }

    const result = stripVerificationSteps(data)

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].assertedEvents).toEqual([{ type: 'navigation', url: 'https://x.com/lightning/home' }])
  })

  it('strips the verification section and rewires the trigger to the post-verification navigation', () => {
    const exitEvent = { type: 'navigation', url: 'https://x.com/lightning/page' }
    const data = {
      title: 'Login flow',
      steps: [
        { type: 'navigate', url: 'https://x.com/login' },
        {
          type: 'click',
          selectors: [['#login-btn']],
          assertedEvents: [{ type: 'navigation', url: 'https://x.com/_ui/identity/verification' }]
        },
        { type: 'click', assertedEvents: [exitEvent] },
        { type: 'assert' }
      ]
    }

    const result = stripVerificationSteps(data)

    expect(result.steps).toHaveLength(3)
    expect(result.steps[0]).toEqual(data.steps[0])
    expect(result.steps[1]).toEqual({
      type: 'click',
      selectors: [['#login-btn']],
      assertedEvents: [exitEvent]
    })
    expect(result.steps[2]).toEqual(data.steps[3])
  })

  it('skips over intermediate verification steps (undefined, empty, and still-verifying events) before finding the exit', () => {
    const exitEvent = { type: 'navigation', url: 'https://x.com/lightning/page' }
    const data = {
      steps: [
        {
          type: 'click',
          assertedEvents: [{ type: 'navigation', url: 'https://x.com/identity/verification' }]
        },
        { type: 'assert' },
        { type: 'assert', assertedEvents: [] },
        {
          type: 'click',
          assertedEvents: [{ type: 'windowOrTabClose' }, { type: 'navigation', url: 'https://x.com/IdentityVerification/step2' }]
        },
        { type: 'click', assertedEvents: [{ type: 'windowOrTabClose' }, exitEvent] },
        { type: 'assert' }
      ]
    }

    const result = stripVerificationSteps(data)

    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].assertedEvents).toEqual([exitEvent])
    expect(result.steps[1]).toEqual(data.steps[5])
  })

  it('treats a navigation event with no url as a valid exit, since it cannot match a verification pattern', () => {
    const exitEvent = { type: 'navigation' }
    const data = {
      steps: [
        {
          type: 'click',
          assertedEvents: [{ type: 'navigation', url: 'https://x.com/_ui/identity/verification' }]
        },
        { type: 'click', assertedEvents: [exitEvent] }
      ]
    }

    const result = stripVerificationSteps(data)

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].assertedEvents).toEqual([exitEvent])
  })

  it('drops the assertedEvents entirely when no exit navigation is ever found', () => {
    const data = {
      steps: [
        {
          type: 'click',
          assertedEvents: [{ type: 'navigation', url: 'https://x.com/_ui/identity/verification' }]
        },
        { type: 'assert', assertedEvents: [{ type: 'navigation', url: 'https://x.com/identity/verification' }] }
      ]
    }

    const result = stripVerificationSteps(data)

    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]).not.toHaveProperty('assertedEvents')
    expect(result.steps[0].type).toBe('click')
  })
})
