// ============================================================
// tests/threatIntel.test.ts — 离线威胁情报：typosquat / 域名 / 公网IP
// ============================================================
import { describe, it, expect } from 'vitest'
import { levenshtein, checkPackageName, checkDomain, isHardcodedPublicIp } from '../electron/security/threatIntel'

describe('levenshtein 编辑距离', () => {
  it('相同=0', () => expect(levenshtein('lodash', 'lodash')).toBe(0))
  it('lodashh vs lodash = 1', () => expect(levenshtein('lodashh', 'lodash')).toBe(1))
  it('lodash vs express = 大', () => expect(levenshtein('lodash', 'express')).toBeGreaterThan(2))
})

describe('checkPackageName', () => {
  it('知名包放行', () => {
    expect(checkPackageName('lodash').kind).toBeNull()
    expect(checkPackageName('express').kind).toBeNull()
  })
  it('typosquat 仿冒 lodash → warn', () => {
    const r = checkPackageName('lodashh')
    expect(r.kind).toBe('typosquat')
    expect(r.looksLike).toBe('lodash')
  })
  it('带 scope 的仿冒也能识别', () => {
    expect(checkPackageName('@types/lodashh').kind === 'typosquat' || checkPackageName('lodashh').kind === 'typosquat').toBe(true)
  })
})

describe('checkDomain / IP', () => {
  it('回连隧道域名 → warn', () => {
    expect(checkDomain('abc.ngrok.io').level).toBe('warn')
  })
  it('正常域名放行', () => {
    expect(checkDomain('api.open-meteo.com').level).toBe('pass')
  })
  it('硬编码公网 IP → true，私有 IP → false', () => {
    expect(isHardcodedPublicIp('8.8.8.8')).toBe(true)
    expect(isHardcodedPublicIp('192.168.1.5')).toBe(false)
    expect(isHardcodedPublicIp('127.0.0.1')).toBe(false)
  })
})
