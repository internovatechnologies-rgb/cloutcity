import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { supabaseEnv } from './env'

describe('supabaseEnv (S05)', () => {
  it('returns the URL and anon key when both are set', () => {
    expect(supabaseEnv({ url: 'http://127.0.0.1:54321', anonKey: 'key' })).toEqual({
      url: 'http://127.0.0.1:54321',
      anonKey: 'key',
    })
    expect(supabaseEnv({ url: ' https://abc.supabase.co ', anonKey: ' key ' })).toEqual({
      url: 'https://abc.supabase.co',
      anonKey: 'key',
    })
  })

  it('is null when either is missing or blank (the e2e build blanks both)', () => {
    expect(supabaseEnv({ url: undefined, anonKey: undefined })).toBeNull()
    expect(supabaseEnv({ url: '', anonKey: '' })).toBeNull()
    expect(supabaseEnv({ url: 'https://abc.supabase.co', anonKey: '   ' })).toBeNull()
    expect(supabaseEnv({ url: undefined, anonKey: 'key' })).toBeNull()
  })

  it('is null for a URL that does not parse or is not http(s)', () => {
    expect(supabaseEnv({ url: 'abc.supabase.co', anonKey: 'key' })).toBeNull()
    expect(supabaseEnv({ url: 'javascript:alert(1)', anonKey: 'key' })).toBeNull()
    expect(supabaseEnv({ url: 'ftp://abc.supabase.co', anonKey: 'key' })).toBeNull()
  })

  it('reads the build variables by their full names, so Next.js inlines them', () => {
    const source = readFileSync(join(import.meta.dirname, 'env.ts'), 'utf8')
    expect(source).toContain('process.env.NEXT_PUBLIC_SUPABASE_URL')
    expect(source).toContain('process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY')
  })
})
