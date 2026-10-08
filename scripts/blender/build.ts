/**
 * `npm run blender:build`: builds our own models (DEC-25 landmarks, DEC-28 gap fillers) with a
 * pinned Blender, headless, from committed Python scripts, and commits the GLBs under
 * scripts/blender/out/ so the asset build (and CI) never needs Blender.
 *
 *   npm run blender:build              run Blender for every model in the lock, rewrite its hashes
 *   npm run blender:build -- --check   no Blender: fail if a script, the runner or an output no
 *                                      longer matches scripts/blender/lock.json
 *   --lock <path>                      another lock (tests use scripts/blender/fixtures/lock.json)
 *
 * Blender runs as `--background --factory-startup --python-exit-code 1` with PYTHONHASHSEED=0,
 * so user preferences and add-ons never leak in and a failing script fails the build. The
 * executable is the lock's (override with BLENDER_BIN); its `--version` must match the pin.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const run = promisify(execFile)

const ROOT = resolve(import.meta.dirname, '../..')
export const BLENDER_LOCK_PATH = join(ROOT, 'scripts/blender/lock.json')
export const RUNNER = 'scripts/blender/run.py'

const repoPath = z
  .string()
  .regex(/^scripts\/blender\/[\w./-]+$/)
  .refine((path) => !path.split('/').includes('..'), { error: 'must not contain ..' })
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const BlenderLockSchema = z.strictObject({
  version: z.literal(1),
  blender: z.strictObject({
    /** Exact `Blender --version` release, e.g. "5.2.2". */
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    executable: z.string().min(1),
  }),
  /** Folder the GLBs are written to (repository-relative). */
  outDir: repoPath,
  models: z.array(
    z.strictObject({
      id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      /** The model's build(bpy) script. */
      script: repoPath.refine((path) => path.endsWith('.py'), { error: 'must be a .py script' }),
      /** sha256 of every input (the runner and the script), as last built; absent until built. */
      inputs: z.record(repoPath, sha256).optional(),
      sha256: sha256.optional(),
      bytes: z.int().positive().optional(),
    }),
  ),
})
export type BlenderLock = z.infer<typeof BlenderLockSchema>

const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const write = (line: string) => process.stdout.write(`${line}\n`)

export async function readBlenderLock(path = BLENDER_LOCK_PATH): Promise<BlenderLock> {
  const result = BlenderLockSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!result.success) throw new Error(`Invalid ${path}:\n${z.prettifyError(result.error)}`)
  return result.data
}

export const outputPath = (lock: BlenderLock, id: string) => `${lock.outDir}/${id}.glb`

async function readOrUndefined(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Problems between the committed scripts, runner, outputs and the lock (no Blender needed). */
export async function checkBlenderOutputs(lock: BlenderLock, root = ROOT): Promise<string[]> {
  const problems: string[] = []
  for (const model of lock.models) {
    if (model.inputs === undefined || model.sha256 === undefined || model.bytes === undefined) {
      problems.push(`${model.id}: not built yet; run npm run blender:build`)
      continue
    }
    const expectedInputs = [RUNNER, model.script].sort()
    if (JSON.stringify(Object.keys(model.inputs).sort()) !== JSON.stringify(expectedInputs)) {
      problems.push(`${model.id}: inputs must be exactly ${expectedInputs.join(', ')}`)
    }
    for (const [path, pinned] of Object.entries(model.inputs)) {
      const bytes = await readOrUndefined(join(root, path))
      if (bytes === undefined) problems.push(`${model.id}: input ${path} is missing`)
      else if (hashOf(bytes) !== pinned) {
        problems.push(
          `${model.id}: ${path} changed since the last Blender build; run npm run blender:build`,
        )
      }
    }
    const out = outputPath(lock, model.id)
    const bytes = await readOrUndefined(join(root, out))
    if (bytes === undefined) problems.push(`${model.id}: ${out} is missing`)
    else if (hashOf(bytes) !== model.sha256 || bytes.byteLength !== model.bytes) {
      problems.push(`${model.id}: ${out} does not match its lock sha256`)
    }
  }
  return problems
}

async function checkVersion(executable: string, version: string): Promise<void> {
  const { stdout } = await run(executable, ['--version'], { env: { ...process.env } })
  const first = stdout.split('\n')[0] ?? ''
  if (!new RegExp(`^Blender ${version.replaceAll('.', '\\.')}(?:\\s|$)`).test(first)) {
    throw new Error(`Blender ${version} is pinned, but ${executable} is "${first.trim()}"`)
  }
}

/** Runs one model script headless and returns the exported GLB. */
export async function runBlender(
  executable: string,
  script: string,
  root = ROOT,
): Promise<Uint8Array> {
  const work = await mkdtemp(join(tmpdir(), 'cc-blender-'))
  try {
    const out = join(work, 'model.glb')
    await run(
      executable,
      [
        '--background',
        '--factory-startup',
        '--python-exit-code',
        '1',
        '--python',
        join(root, RUNNER),
        '--',
        '--script',
        join(root, script),
        '--out',
        out,
      ],
      { env: { ...process.env, PYTHONHASHSEED: '0' }, maxBuffer: 16 * 1024 * 1024 },
    )
    return new Uint8Array(await readFile(out))
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function build(lockPath: string): Promise<void> {
  const lock = await readBlenderLock(lockPath)
  const executable = process.env.BLENDER_BIN ?? lock.blender.executable
  await checkVersion(executable, lock.blender.version)
  const models: BlenderLock['models'] = []
  for (const model of lock.models) {
    const bytes = await runBlender(executable, model.script)
    await writeFile(join(ROOT, outputPath(lock, model.id)), bytes)
    const inputs: Record<string, string> = {}
    for (const path of [RUNNER, model.script].sort()) {
      inputs[path] = hashOf(new Uint8Array(await readFile(join(ROOT, path))))
    }
    models.push({ ...model, inputs, sha256: hashOf(bytes), bytes: bytes.byteLength })
    write(`built ${model.id}: ${outputPath(lock, model.id)} ${bytes.byteLength} B`)
  }
  await writeFile(lockPath, `${JSON.stringify({ ...lock, models }, null, 2)}\n`)
  write(`wrote ${lockPath}`)
}

function parseArgs(argv: readonly string[]): { check: boolean; lockPath: string } {
  let check = false
  let lockPath = BLENDER_LOCK_PATH
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') check = true
    else if (arg === '--lock' && argv[i + 1] !== undefined)
      lockPath = resolve(ROOT, argv[++i] ?? '')
    else throw new Error(`Unknown option ${arg}`)
  }
  return { check, lockPath }
}

async function main(): Promise<void> {
  const { check, lockPath } = parseArgs(process.argv.slice(2))
  if (check) {
    const problems = await checkBlenderOutputs(await readBlenderLock(lockPath))
    for (const problem of problems) write(`FAIL ${problem}`)
    if (problems.length > 0) {
      process.exitCode = 1
      return
    }
    write('PASS Blender outputs match their scripts and the lock')
    return
  }
  await build(lockPath)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `blender:build: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exitCode = 1
  })
}
