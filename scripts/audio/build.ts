/**
 * `npm run audio:build`: turns the pinned CC0 originals (scripts/audio/sources.json) into the
 * files the game serves from public/audio and writes data/audio/manifest.json.
 *
 *   npm run audio:build               use the cache (.cache/audio), download what is missing
 *   npm run audio:build -- --offline  never touch the network
 *   npm run audio:build -- --check    offline, no ffmpeg: fail if the committed outputs, the
 *                                     manifest, sources.json and data/audio/SOURCES.md disagree
 *
 * Every download must match its pinned sha256, so a changed upstream file fails the build.
 * Pipeline per asset (ffmpeg): excerpt, two-pass EBU R128 loudness normalisation (music −16
 * LUFS, ambience −26, sfx −18; −1 dBTP), a crossfade baked into the loop seam for looping
 * channels, 48 kHz, then Opus in WebM and AAC-LC in .m4a. Outputs are bit-exact flagged and
 * carry no metadata.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { unzipSync } from 'fflate'
import { format, resolveConfig } from 'prettier'
import { z } from 'zod'
import { AUDIO_CHANNELS, SFX_IDS } from '../../src/lib/audio/channels.ts'

const run = promisify(execFile)

const ROOT = resolve(import.meta.dirname, '../..')
export const SOURCES_PATH = join(ROOT, 'scripts/audio/sources.json')
export const MANIFEST_PATH = join(ROOT, 'data/audio/manifest.json')
export const SOURCES_MD_PATH = join(ROOT, 'data/audio/SOURCES.md')
const PUBLIC = join(ROOT, 'public')
const CACHE_DIR = join(ROOT, '.cache/audio')

const httpsUrl = z.url({ protocol: /^https$/ })
const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)

export const SourcesSchema = z.strictObject({
  version: z.literal(1),
  downloads: z.array(
    z.strictObject({
      id,
      url: httpsUrl,
      file: z.string().regex(/^[a-z0-9-]+\.(?:ogg|mp3|wav|zip)$/),
      sha256,
      bytes: z.int().positive(),
      retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
  ),
  assets: z.array(
    z.strictObject({
      id,
      channel: z.enum(AUDIO_CHANNELS),
      titleKey: z.string().optional(),
      title: z.string().min(1),
      author: z.string().min(1),
      /** The page that states the licence (checked by hand when pinned). */
      sourceUrl: httpsUrl,
      download: id,
      /** Path inside a zip download. */
      entry: z.string().optional(),
      excerpt: z
        .strictObject({ startS: z.number().nonnegative(), durationS: z.number().positive() })
        .optional(),
      /** Seconds of the loop's tail crossfaded into its head, so the seam is inaudible. */
      loopCrossfadeS: z.number().positive().optional(),
      channels: z.union([z.literal(1), z.literal(2)]),
    }),
  ),
  playlists: z.strictObject({ music: z.array(id).min(1), ambience: z.array(id).min(1) }),
  sfx: z.strictObject(
    Object.fromEntries(SFX_IDS.map((sfxId) => [sfxId, id])) as Record<
      (typeof SFX_IDS)[number],
      typeof id
    >,
  ),
})
export type Sources = z.infer<typeof SourcesSchema>
type Asset = Sources['assets'][number]

/** Loudness targets (integrated LUFS) and encodings per channel kind. */
const LOUDNESS: Readonly<Record<string, number>> = {
  music: -16,
  ambience: -26,
  sfx: -18,
  voice: -18,
}
const TRUE_PEAK_DBTP = -1
const SAMPLE_RATE = 48_000
const OPUS_KBPS: Readonly<Record<string, number>> = { music: 64, ambience: 40, sfx: 48, voice: 48 }
// AAC-LC for Safari. Every output is mono, where 64 kbps is plenty for lofi.
const AAC_KBPS: Readonly<Record<string, number>> = { music: 64, ambience: 48, sfx: 64, voice: 64 }
/** EBU R128 integrated loudness needs at least 3 s; short sounds are padded with silence. */
const MIN_MEASURE_S = 3

export const ENCODINGS = [
  { ext: 'webm', type: 'audio/webm; codecs=opus' },
  { ext: 'm4a', type: 'audio/mp4; codecs=mp4a.40.2' },
] as const

/** Only what --check and the manifest need; data.test.ts validates the whole manifest. */
const ManifestSchema = z.looseObject({
  tracks: z.array(
    z.looseObject({
      id: z.string(),
      sources: z.array(z.looseObject({ file: z.string(), bytes: z.int(), sha256: z.string() })),
      sourceUrl: z.string(),
      author: z.string(),
      titleKey: z.string().optional(),
    }),
  ),
})

const write = (line: string) => process.stdout.write(`${line}\n`)
const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

export async function readSources(path = SOURCES_PATH): Promise<Sources> {
  const result = SourcesSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
  if (!result.success) throw new Error(`Invalid ${path}:\n${z.prettifyError(result.error)}`)
  return result.data
}

export const outputPath = (asset: Pick<Asset, 'id' | 'channel'>, ext: string) =>
  `/audio/${asset.channel}/${asset.id}.${ext}`

async function ensureDownload(download: Sources['downloads'][number], offline: boolean) {
  const path = join(CACHE_DIR, download.file)
  let bytes: Uint8Array | undefined
  try {
    bytes = new Uint8Array(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (bytes === undefined) {
    if (offline) throw new Error(`${download.id}: not in ${CACHE_DIR} and --offline is set`)
    write(`download ${download.url}`)
    const response = await fetch(download.url)
    if (!response.ok) throw new Error(`${download.id}: HTTP ${response.status}`)
    bytes = new Uint8Array(await response.arrayBuffer())
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(path, bytes)
  }
  const actual = hashOf(bytes)
  if (actual !== download.sha256 || bytes.byteLength !== download.bytes) {
    throw new Error(
      `${download.id}: sha256 ${actual} (${bytes.byteLength} B) does not match the pin`,
    )
  }
  return bytes
}

async function ffmpeg(args: readonly string[]): Promise<string> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostdin', ...args], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return stderr
}

/** The audio filter before normalisation: the excerpt (with the crossfade tail) or padding. */
function preFilter(asset: Asset): string {
  const parts: string[] = []
  if (asset.excerpt !== undefined) {
    const length = asset.excerpt.durationS + (asset.loopCrossfadeS ?? 0)
    parts.push(`atrim=start=${asset.excerpt.startS}:duration=${length}`, 'asetpts=PTS-STARTPTS')
  }
  parts.push(`aformat=channel_layouts=${asset.channels === 1 ? 'mono' : 'stereo'}`)
  return parts.join(',')
}

const LoudnormSchema = z.object({
  input_i: z.string(),
  input_tp: z.string(),
  input_lra: z.string(),
  input_thresh: z.string(),
  target_offset: z.string(),
})

async function measure(input: string, asset: Asset, target: number) {
  const pad = asset.excerpt === undefined ? `,apad=whole_dur=${MIN_MEASURE_S}` : ''
  const stderr = await ffmpeg([
    '-i',
    input,
    '-af',
    `${preFilter(asset)}${pad},loudnorm=I=${target}:TP=${TRUE_PEAK_DBTP}:LRA=11:print_format=json`,
    '-f',
    'null',
    '-',
  ])
  const json = stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1)
  return LoudnormSchema.parse(JSON.parse(json))
}

/** Normalises, bakes the loop seam and writes a 48 kHz WAV master. Returns its duration (ms). */
async function master(input: string, asset: Asset, wav: string): Promise<number> {
  const target = LOUDNESS[asset.channel] ?? -18
  const m = await measure(input, asset, target)
  const loudnorm =
    `loudnorm=I=${target}:TP=${TRUE_PEAK_DBTP}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
  const short = asset.excerpt === undefined
  let graph = `[0:a]${preFilter(asset)}${short ? `,apad=whole_dur=${MIN_MEASURE_S}` : ''},${loudnorm},aresample=${SAMPLE_RATE}`
  if (short) {
    const { stdout } = await run('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      input,
    ])
    graph += `,atrim=duration=${Number(stdout.trim())}`
  }
  if (asset.excerpt !== undefined && asset.loopCrossfadeS !== undefined) {
    const d = asset.excerpt.durationS
    const x = asset.loopCrossfadeS
    // The head's first x seconds fade in while the x seconds after the loop end fade out over
    // them: the end of the loop flows into its start.
    graph +=
      `,asplit=3[a][b][c];` +
      `[a]atrim=0:${x},asetpts=PTS-STARTPTS,afade=t=in:d=${x}:curve=qsin[head];` +
      `[b]atrim=${d}:${d + x},asetpts=PTS-STARTPTS,afade=t=out:d=${x}:curve=qsin[tail];` +
      `[head][tail]amix=inputs=2:normalize=0[seam];` +
      `[c]atrim=${x}:${d},asetpts=PTS-STARTPTS[rest];` +
      `[seam][rest]concat=n=2:v=0:a=1`
  }
  graph += '[out]'
  await ffmpeg([
    '-y',
    '-i',
    input,
    '-filter_complex',
    graph,
    '-map',
    '[out]',
    '-c:a',
    'pcm_s16le',
    wav,
  ])
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    wav,
  ])
  return Math.round(Number(stdout.trim()) * 1000)
}

async function encode(wav: string, asset: Asset, ext: string, out: string) {
  const common = [
    '-y',
    '-i',
    wav,
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
  ]
  const codec =
    ext === 'webm'
      ? [
          '-c:a',
          'libopus',
          '-b:a',
          `${OPUS_KBPS[asset.channel]}k`,
          '-vbr',
          'on',
          '-application',
          'audio',
        ]
      : [
          '-c:a',
          'aac',
          '-profile:a',
          'aac_low',
          '-b:a',
          `${AAC_KBPS[asset.channel]}k`,
          '-movflags',
          '+faststart',
        ]
  await mkdir(dirname(out), { recursive: true })
  await ffmpeg([...common, ...codec, '-ac', String(asset.channels), out])
}

async function build(offline: boolean) {
  const sources = await readSources()
  const downloads = new Map<string, Uint8Array>()
  for (const download of sources.downloads)
    downloads.set(download.id, await ensureDownload(download, offline))
  const retrieved = new Map(sources.downloads.map((download) => [download.id, download.retrieved]))

  const work = await mkdtemp(join(tmpdir(), 'cc-audio-'))
  try {
    const tracks = []
    for (const asset of sources.assets) {
      const raw = downloads.get(asset.download)
      if (raw === undefined) throw new Error(`${asset.id}: unknown download ${asset.download}`)
      let bytes = raw
      if (asset.entry !== undefined) {
        const entry = unzipSync(raw, { filter: (file) => file.name === asset.entry })[asset.entry]
        if (entry === undefined) throw new Error(`${asset.id}: ${asset.entry} is not in the zip`)
        bytes = entry
      }
      const input = join(work, `${asset.id}.in`)
      await writeFile(input, bytes)
      const wav = join(work, `${asset.id}.wav`)
      const durationMs = await master(input, asset, wav)
      const files = []
      for (const { ext, type } of ENCODINGS) {
        const file = outputPath(asset, ext)
        await encode(wav, asset, ext, join(PUBLIC, file))
        const out = new Uint8Array(await readFile(join(PUBLIC, file)))
        files.push({ file, type, bytes: out.byteLength, sha256: hashOf(out) })
      }
      const looping = asset.channel !== 'sfx'
      tracks.push({
        id: asset.id,
        channel: asset.channel,
        ...(asset.titleKey === undefined ? {} : { titleKey: asset.titleKey }),
        sources: files,
        durationMs,
        loop: looping,
        ...(looping ? { loopStartMs: 0, loopEndMs: durationMs } : {}),
        gainDb: 0,
        license: 'CC0-1.0',
        sourceUrl: asset.sourceUrl,
        author: asset.author,
        retrievedAt: retrieved.get(asset.download),
      })
      write(
        `built ${asset.id} (${durationMs} ms): ${files.map((f) => `${f.file} ${f.bytes} B`).join(', ')}`,
      )
    }
    const manifest = {
      version: 2,
      channels: [...AUDIO_CHANNELS],
      tracks,
      playlists: sources.playlists,
      sfx: sources.sfx,
    }
    // Formatted like every other committed file, so format:check passes after a rebuild.
    const options = await resolveConfig(MANIFEST_PATH)
    await writeFile(
      MANIFEST_PATH,
      await format(JSON.stringify(manifest), { ...options, filepath: MANIFEST_PATH }),
    )
    write(`wrote ${MANIFEST_PATH}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** Problems between the committed outputs, the manifest, sources.json and SOURCES.md. */
export async function checkOutputs(): Promise<string[]> {
  const problems: string[] = []
  const sources = await readSources()
  const manifest = ManifestSchema.parse(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')))
  const sourcesMd = await readFile(SOURCES_MD_PATH, 'utf8')
  const assetIds = sources.assets.map((asset) => asset.id)
  const trackIds = manifest.tracks.map((track) => track.id)
  if (JSON.stringify(assetIds) !== JSON.stringify(trackIds)) {
    problems.push(
      `manifest tracks [${trackIds.join(', ')}] differ from sources.json [${assetIds.join(', ')}]`,
    )
  }
  for (const track of manifest.tracks) {
    const asset = sources.assets.find((entry) => entry.id === track.id)
    if (asset !== undefined) {
      if (
        track.sourceUrl !== asset.sourceUrl ||
        track.author !== asset.author ||
        track.titleKey !== asset.titleKey
      ) {
        problems.push(`${track.id}: provenance differs from sources.json`)
      }
      const download = sources.downloads.find((entry) => entry.id === asset.download)
      if (download !== undefined && !sourcesMd.includes(download.sha256)) {
        problems.push(`SOURCES.md does not record the sha256 of ${download.id}`)
      }
    }
    if (!sourcesMd.includes(`\`${track.id}\``))
      problems.push(`SOURCES.md does not list \`${track.id}\``)
    for (const source of track.sources) {
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await readFile(join(PUBLIC, source.file)))
      } catch {
        problems.push(`${source.file} is missing`)
        continue
      }
      if (bytes.byteLength !== source.bytes || hashOf(bytes) !== source.sha256) {
        problems.push(`${source.file} does not match its manifest bytes/sha256`)
      }
    }
  }
  return problems
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  if (args.has('--check')) {
    const problems = await checkOutputs()
    for (const problem of problems) write(`FAIL ${problem}`)
    if (problems.length > 0) {
      process.exitCode = 1
      return
    }
    write('PASS audio outputs match data/audio/manifest.json, sources.json and SOURCES.md')
    return
  }
  await build(args.has('--offline'))
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`audio:build: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
