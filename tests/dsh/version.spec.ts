import { describe, expect, it } from 'vitest'
import { knownDshFamily, parseDshVersion } from '../../src/dsh/index.js'

describe('knownDshFamily', () => {
  it.each([
    '00.01.007', '00.1.7', '0.01.7', '0.1.07', '0.1.7-01', '0.1.7-rc.01',
    'v0.1.7', '0.1.7garbage', '0.1.7-', '0.1.7.0', '0.1.7\n',
    '0.1.7-Authorization_Bearer_doctor-secret',
  ])('rejects malformed whole version %j', value => {
    expect(parseDshVersion(value)).toBeNull()
    expect(knownDshFamily(value)).toBeNull()
  })
  it.each(['0.1.7-0', '0.1.7-rc.0', '0.1.7-01alpha'])('accepts legal prerelease %s', value => {
    expect(knownDshFamily(value)).toBe('0.1.7')
  })
  it.each(['0.1.7', '0.1.7-rc.2'])('接受已知族 %s', value => {
    expect(knownDshFamily(value)).toBe('0.1.7')
  })
  it.each([
    '0.1.70',
    '0.1.8',
    '0.0.1',
    '',
    'v0.1.7',
    '0.1',
    '0.1.7- ',
    '0.1.7-rc..2',
  ])(
    '拒绝未验证版本 %s',
    value => expect(knownDshFamily(value)).toBeNull(),
  )
  it('保留 prerelease', () => {
    expect(parseDshVersion('0.1.7-rc.2')).toEqual({
      raw: '0.1.7-rc.2', major: 0, minor: 1, patch: 7, prerelease: 'rc.2',
    })
  })

  it.each([
    '9007199254740992.1.7',
    '0.9007199254740992.7',
    '0.1.9007199254740992',
    `${'9'.repeat(309)}.1.7`,
  ])('拒绝超出安全整数范围的版本 %s', value => {
    expect(parseDshVersion(value)).toBeNull()
  })
})
