/**
 * The Blender runner (S04h, DEC-25): committed outputs are pinned to the runner, the model script
 * and the GLB, so a changed script or a hand-edited GLB fails `--check` without Blender. The smoke
 * fixture (a crate) was built by Blender 5.2.2 headless and is byte-stable across runs.
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BlenderLockSchema, checkBlenderOutputs, readBlenderLock } from './build.ts'

const ROOT = join(import.meta.dirname, '../..')
const FIXTURE_LOCK = join(ROOT, 'scripts/blender/fixtures/lock.json')

/** A scratch copy of scripts/blender to tamper with. */
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cc-blender-'))
  await cp(join(ROOT, 'scripts/blender'), join(root, 'scripts/blender'), { recursive: true })
  return root
}

describe('blender:build', () => {
  it('pins Blender 5.2.2 and starts with no shipped models (S07c and DEC-28 add them)', async () => {
    const lock = await readBlenderLock()
    expect(lock.blender.version).toBe('5.2.2')
    expect(lock.outDir).toBe('scripts/blender/out')
    expect(lock.models).toEqual([])
  })

  it('accepts the smoke fixture as built', async () => {
    const lock = await readBlenderLock(FIXTURE_LOCK)
    expect(lock.models.map((model) => model.id)).toEqual(['smoke-crate'])
    expect(await checkBlenderOutputs(lock)).toEqual([])
  })

  it('fails when the script, the runner or the GLB changed since the last build', async () => {
    const lock = await readBlenderLock(FIXTURE_LOCK)
    for (const [file, message] of [
      ['fixtures/smoke-crate.py', /smoke-crate\.py changed since the last Blender build/],
      ['run.py', /run\.py changed since the last Blender build/],
      ['fixtures/smoke-crate.glb', /does not match its lock sha256/],
    ] as const) {
      const root = await scratch()
      try {
        await writeFile(join(root, 'scripts/blender', file), 'tampered')
        expect((await checkBlenderOutputs(lock, root)).join('\n')).toMatch(message)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('reports a model that was never built and rejects paths outside scripts/blender', () => {
    const unbuilt = BlenderLockSchema.parse({
      version: 1,
      blender: { version: '5.2.2', executable: 'blender' },
      outDir: 'scripts/blender/out',
      models: [{ id: 'bridge', script: 'scripts/blender/models/bridge.py' }],
    })
    return checkBlenderOutputs(unbuilt).then((problems) => {
      expect(problems).toEqual(['bridge: not built yet; run npm run blender:build'])
      expect(
        BlenderLockSchema.safeParse({
          ...unbuilt,
          models: [{ id: 'x', script: 'scripts/blender/../../etc/x.py' }],
        }).success,
      ).toBe(false)
    })
  })

  it('--check runs without Blender; bad flags exit 1', () => {
    const check = spawnSync(process.execPath, ['scripts/blender/build.ts', '--check'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(check.status).toBe(0)
    expect(check.stdout).toContain('PASS')
    const bad = spawnSync(process.execPath, ['scripts/blender/build.ts', '--bogus'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(bad.status).toBe(1)
    expect(bad.stderr).toMatch(/Unknown option --bogus/)
  })
})
