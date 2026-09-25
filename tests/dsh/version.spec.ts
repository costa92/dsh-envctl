import { describe, expect, it } from 'vitest'
import { knownDshFamily, parseDshVersion } from '../../src/dsh/index.js'

describe('knownDshFamily', () => {
  it.each(['0.1.7', '0.1.7-rc.2'])('接受已知族 %s', value => {
    expect(knownDshFamily(value)).toBe('0.1.7')
  })
  it.each(['0.1.70', '0.1.8', '0.0.1', '', 'v0.1.7', '0.1'])(
    '拒绝未验证版本 %s',
    value => expect(knownDshFamily(value)).toBeNull(),
  )
  it('保留 prerelease', () => {
    expect(parseDshVersion('0.1.7-rc.2')).toEqual({
      raw: '0.1.7-rc.2', major: 0, minor: 1, patch: 7, prerelease: 'rc.2',
    })
  })
})
