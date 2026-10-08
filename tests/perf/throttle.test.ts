import { describe, expect, it } from 'vitest'
import perfJson from '@data/config/perf.json'
import { kbpsToBytesPerSecond, networkRule } from './throttle'

describe('throttle', () => {
  it('converts kilobits per second to CDP bytes per second', () => {
    expect(kbpsToBytesPerSecond(4000)).toBe(500_000)
    expect(kbpsToBytesPerSecond(1000)).toBe(125_000)
  })

  it('throttles every request to the cc-mid-4g profile', () => {
    expect(networkRule(perfJson.throttleProfiles['cc-mid-4g'])).toEqual({
      matchedNetworkConditions: [
        {
          urlPattern: '',
          latency: 150,
          downloadThroughput: 500_000,
          uploadThroughput: 125_000,
          connectionType: 'cellular4g',
        },
      ],
    })
  })
})
