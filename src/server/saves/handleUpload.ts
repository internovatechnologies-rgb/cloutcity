/**
 * POST /api/save (S18c): checks a device's save against the last one the server accepted and
 * stores it, or keeps it aside.
 *
 * 1. The caller is the Supabase user whose access token is the Bearer token (401 otherwise).
 * 2. The body fits `UploadBodySchema` (400) and the save fits `sync.maxSaveBytes` (413).
 * 3. The account has attested (403) and the save format is this server's (409 `version`).
 * 4. The upload is based on the cloud's current revision (409 `conflict`, with the head's
 *    metadata only: the device reads the save itself with its own session).
 * 5. "Keep this device" (`overrideFromRevision`, H2; rate limited per hour, 429): the upload is
 *    checked against the save both devices last shared (`save_at_revision`, from the history,
 *    with its stored credits) rather than the other device's, as a branch (grants the other
 *    branch claimed too are not a replay). If the history no longer keeps it, the upload is
 *    checked from that revision's baselines (taps and clock), against the real time since it was
 *    accepted and its credits (the untrimmed revision ledger) while the kept game is in that
 *    revision's run and prestige; otherwise, or for a revision the ledger does not know, as a
 *    whole run since the account was created with the current credits; and against the current
 *    save's prestige and run. First-upload rules apply only to an account with no save. A kept game from before the account's last prestige is refused with
 *    409 `branch-behind` (its badges would be lost; the device offers the account's game). It is
 *    stored on top of the current head, which stays in the history.
 * 6. Save plausibility (src/engine/plausibility.ts `checkUpload`): a rejected save goes to
 *    `quarantine_save` (422); otherwise `commit_save` stores it with its repairs, the new grant
 *    rows and the public projection (INT-10), under a compare-and-swap on the revision and the
 *    upload rate limit (409, 429).
 *
 * The storage side is a `SaveBackend`, so the rules are tested without a database
 * (handleUpload.test.ts) and against the real one (tests/integration/save-sync.test.ts).
 * Nothing logged here holds the save, the user id or the token.
 */
import 'server-only'
import { z } from 'zod'
import { engineConfig } from '@/engine/config'
import { toServerGrantRow, type ServerGrantRow } from '@/engine/grants'
import { checkUpload, type CashClout, type PlausibilityCeilings } from '@/engine/plausibility'
import { SAVE_VERSION, loadSave, migrateSave, type SaveState } from '@/engine/save'
import { sync } from '@/lib/data/config'
import type { Logger } from '@/lib/log'
import type { CloudCopy, CloudHead, UploadReply } from '@/lib/sync/protocol'

/** Room for the envelope around the save in a request body. */
const ENVELOPE_BYTES = 4096

/** The latest time a JavaScript date holds (ms since the epoch). */
const MAX_DATE_MS = 8.64e15

export const UploadBodySchema = z.strictObject({
  saveVersion: z.int().positive(),
  baseRevision: z.int().nonnegative(),
  deviceId: z.uuid(),
  clientSavedAt: z.int().nonnegative().max(MAX_DATE_MS).nullable(),
  // Required: an envelope without a save is a broken request, not a save to keep aside.
  save: z.unknown().refine((save) => save !== undefined),
  overrideFromRevision: z.int().nonnegative().nullable().optional(),
})

/** The largest request body the route reads (the save plus its envelope). */
export const MAX_BODY_BYTES = sync.maxSaveBytes + ENVELOPE_BYTES

/** The account's save row as the server reads it. */
export interface StoredSave extends CloudCopy {
  readonly burstCreditMinutes: number
  readonly paceCredit: CashClout
}

/** A save the history keeps (`save_at_revision`), with the credits it was stored with. */
export interface HistorySave {
  readonly saveVersion: number
  readonly data: unknown
  readonly acceptedAt: string
  readonly burstCreditMinutes: number
  readonly paceCredit: CashClout
}

/** What the server holds for a player. */
export interface PlayerRecord {
  readonly attested: boolean
  /** When the account was created (ISO). */
  readonly createdAt: string
  readonly save: StoredSave | null
  /** Grant keys the server holds (`goal:<id>:r<run>`). */
  readonly grantKeys: readonly string[]
  /** Premium items with a live entitlement. */
  readonly entitledItemIds: readonly string[]
}

/** A revision the revision ledger keeps (`revision_at`). */
export interface LedgerRevision {
  readonly acceptedAt: string
  readonly burstCreditMinutes: number
  readonly paceCredit: CashClout
  /** That save's tap count, clock minute, run and prestige count, or null when unknown. */
  readonly baseline: {
    readonly actions: number
    readonly minute: number
    readonly run: number
    readonly prestigeCount: number
  } | null
}

export interface CommitArgs {
  readonly userId: string
  readonly expectedRevision: number
  readonly saveVersion: number
  readonly data: SaveState
  readonly deviceId: string
  readonly clientSavedAt: string | null
  readonly publicLevel: string
  readonly careerPath: string | null
  readonly sameRun: boolean
  readonly avatar: { readonly cosmetics: readonly string[] }
  readonly grants: readonly ServerGrantRow[]
  readonly burstCreditMinutes: number
  readonly paceCredit: CashClout
}

export type CommitOutcome =
  | { readonly ok: true; readonly revision: number; readonly acceptedAt: string }
  | {
      readonly ok: false
      readonly code: 'conflict' | 'version' | 'rate-limited' | 'attestation-required'
    }

export interface QuarantineArgs {
  readonly userId: string
  readonly baseRevision: number
  readonly saveVersion: number
  readonly data: unknown
  readonly findings: readonly string[]
  readonly deviceId: string
}

/** Storage for cloud saves (the Supabase one is `supabaseSaveBackend`). Failures throw. */
export interface SaveBackend {
  /** The user an access token belongs to, or null for an invalid or expired token. */
  userIdFor(accessToken: string): Promise<string | null>
  /** The player's record, or null when there is no profile. */
  load(userId: string): Promise<PlayerRecord | null>
  /** The save the history keeps at `revision`, or null once it has been trimmed. */
  saveAt(userId: string, revision: number): Promise<HistorySave | null>
  /** A revision the ledger keeps: when it was accepted and its credits, or null. */
  ledgerAt(userId: string, revision: number): Promise<LedgerRevision | null>
  /** Counts a "keep this device" upload against the player's hourly limit. */
  consumeOverride(userId: string): Promise<'ok' | 'rate-limited'>
  commit(args: CommitArgs): Promise<CommitOutcome>
  quarantine(args: QuarantineArgs): Promise<'ok' | 'rate-limited'>
}

export interface UploadRequest {
  readonly authorization: string | null
  readonly bodyText: string
}

export interface UploadResult {
  readonly status: number
  readonly body: UploadReply
}

const reply = (status: number, body: UploadReply): UploadResult => ({ status, body })

function bearer(authorization: string | null): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
  return match?.[1] ?? null
}

const headOf = (save: StoredSave | null): CloudHead | null =>
  save === null
    ? null
    : {
        revision: save.revision,
        saveVersion: save.saveVersion,
        acceptedAt: save.acceptedAt,
        deviceId: save.deviceId,
      }

/**
 * A stored save in the current format, or null when there is none. A save stored by an older
 * build is upgraded; one from a newer build than this server cannot be checked against.
 */
function previousSave(
  stored: Pick<CloudCopy, 'saveVersion' | 'data'> | null,
): SaveState | null | 'newer' {
  if (stored === null) return null
  if (stored.saveVersion > SAVE_VERSION) return 'newer'
  if (stored.saveVersion < SAVE_VERSION) {
    return migrateSave(stored.data, stored.saveVersion, engineConfig).save
  }
  const loaded = loadSave(stored.data, engineConfig)
  // commit_save stores only saves that passed the checks: an unusable one is a server fault.
  if (!loaded.ok) throw new Error('The stored cloud save does not load')
  return loaded.save
}

/** True when `kept` is from before `current`'s last prestige (or an earlier run). */
function behindInRuns(kept: SaveState, current: SaveState): boolean {
  return (
    kept.prestige.count < current.prestige.count ||
    kept.prestige.history.length < current.prestige.history.length ||
    kept.goals.run < current.goals.run
  )
}

export async function handleUpload(
  request: UploadRequest,
  backend: SaveBackend,
  ceilings: PlausibilityCeilings,
  nowMs: number,
  logger: Logger,
): Promise<UploadResult> {
  const token = bearer(request.authorization)
  if (token === null) return reply(401, { ok: false, code: 'unauthenticated' })
  if (Buffer.byteLength(request.bodyText, 'utf8') > MAX_BODY_BYTES) {
    return reply(413, { ok: false, code: 'too-large' })
  }

  let json: unknown
  try {
    json = JSON.parse(request.bodyText)
  } catch {
    return reply(400, { ok: false, code: 'invalid' })
  }
  const parsed = UploadBodySchema.safeParse(json)
  if (!parsed.success) return reply(400, { ok: false, code: 'invalid' })
  const body = parsed.data
  const saveBytes = Buffer.byteLength(JSON.stringify(body.save) ?? '', 'utf8')
  if (saveBytes > sync.maxSaveBytes) return reply(413, { ok: false, code: 'too-large' })

  const userId = await backend.userIdFor(token)
  if (userId === null) return reply(401, { ok: false, code: 'unauthenticated' })
  const player = await backend.load(userId)
  if (player === null || !player.attested) {
    return reply(403, { ok: false, code: 'attestation-required' })
  }
  if (body.saveVersion !== SAVE_VERSION) {
    return reply(409, { ok: false, code: 'version', serverVersion: SAVE_VERSION })
  }
  const stored = player.save
  if ((stored?.revision ?? 0) !== body.baseRevision) {
    return reply(409, { ok: false, code: 'conflict', head: headOf(stored) })
  }

  // "Keep this device": the base is the save both devices last shared, with the credits it was
  // stored with. Once the account has a save, first-upload rules never apply: a shared save the
  // history no longer keeps makes the upload a whole run checked against the account's age, the
  // current credits, and the current save's forward-only fields.
  const override = body.overrideFromRevision ?? null
  let base: Pick<CloudCopy, 'saveVersion' | 'data' | 'acceptedAt'> | null = stored
  let burst = stored?.burstCreditMinutes ?? ceilings.burstRealMinutes
  let pace: CashClout | null = stored?.paceCredit ?? null
  let head: SaveState | undefined
  /** Where a branch without its shared save is measured from (epoch ms). */
  let branchFrom: number | null = null
  let baseline: { readonly actions: number; readonly minute: number } | undefined
  if (override !== null) {
    if (stored === null || override >= stored.revision) {
      return reply(400, { ok: false, code: 'invalid' })
    }
    if ((await backend.consumeOverride(userId)) === 'rate-limited') {
      return reply(429, { ok: false, code: 'rate-limited', retryAfterMs: 3_600_000 })
    }
    // A kept game from before the account's last prestige cannot replace it: its badges would be
    // lost, and the run's rewards, already given, could never be claimed on it again (N2).
    const current = previousSave(stored)
    const kept = loadSave(body.save, engineConfig)
    if (current !== null && current !== 'newer' && kept.ok && behindInRuns(kept.save, current)) {
      return reply(409, { ok: false, code: 'branch-behind' })
    }
    const ancestor = await backend.saveAt(userId, override)
    if (ancestor !== null) {
      base = ancestor
      burst = ancestor.burstCreditMinutes
      pace = ancestor.paceCredit
    } else {
      base = null
      if (current === 'newer') {
        return reply(409, { ok: false, code: 'version', serverVersion: SAVE_VERSION })
      }
      head = current ?? undefined
      // The full save is trimmed, but the revision ledger knows when it was accepted and its
      // credits: the branch is measured from there, exactly. A revision the ledger does not know
      // (0: never synced) is measured from the account's creation with the current credits,
      // lenient by design (overrides are rate limited, earnings capped by the credit).
      // Measured from the revision only while the kept game is still in that revision's run
      // and prestige (its baselines say where the window starts); otherwise, or without
      // baselines, the whole run is measured from the account's creation.
      const revision = override === 0 ? null : await backend.ledgerAt(userId, override)
      const from = revision?.baseline ?? null
      if (
        revision !== null &&
        from !== null &&
        kept.ok &&
        kept.save.goals.run === from.run &&
        kept.save.prestige.count === from.prestigeCount
      ) {
        branchFrom = Date.parse(revision.acceptedAt)
        burst = revision.burstCreditMinutes
        pace = revision.paceCredit
        baseline = { actions: from.actions, minute: from.minute }
      } else {
        branchFrom = Date.parse(player.createdAt)
      }
    }
  }
  const prev = previousSave(base)
  if (prev === 'newer') {
    return reply(409, { ok: false, code: 'version', serverVersion: SAVE_VERSION })
  }

  const accountAgeMinutes = Math.max(0, nowMs - Date.parse(player.createdAt)) / 60_000
  const acceptedAtMs = base?.acceptedAt == null ? nowMs : Date.parse(base.acceptedAt)
  const verdict = checkUpload(
    prev,
    body.save,
    {
      // A branch without its shared save: from its revision (ledger) or the account's creation.
      realMinutesSinceAccept: Math.max(0, nowMs - (branchFrom ?? acceptedAtMs)) / 60_000,
      burstCreditMinutes: burst,
      paceCredit: pace,
      accountAgeMinutes,
      serverGrantKeys: player.grantKeys,
      entitledItemIds: player.entitledItemIds,
      // Only an account with no save at all uploads under first-upload rules.
      firstUpload: stored === null,
      branch: override !== null,
      ...(head === undefined ? {} : { head }),
      ...(baseline === undefined ? {} : { baseline }),
    },
    ceilings,
    engineConfig,
  )

  if (verdict.save === null || verdict.publicView === null) {
    logger.info('A cloud save failed plausibility and was kept aside', {
      findings: verdict.findings,
    })
    const kept = await backend.quarantine({
      userId,
      baseRevision: body.baseRevision,
      saveVersion: body.saveVersion,
      // The quarantine keeps objects; anything else is wrapped so it is kept as sent.
      data:
        typeof body.save === 'object' && body.save !== null && !Array.isArray(body.save)
          ? body.save
          : { upload: body.save ?? null },
      findings: verdict.findings,
      deviceId: body.deviceId,
    })
    if (kept === 'rate-limited') {
      return reply(429, { ok: false, code: 'rate-limited', retryAfterMs: 60_000 })
    }
    return reply(422, { ok: false, code: 'rejected' })
  }

  const committed = await backend.commit({
    userId,
    expectedRevision: body.baseRevision,
    saveVersion: body.saveVersion,
    data: verdict.save,
    deviceId: body.deviceId,
    clientSavedAt: body.clientSavedAt === null ? null : new Date(body.clientSavedAt).toISOString(),
    publicLevel: verdict.publicView.level_id,
    careerPath: verdict.publicView.career_path,
    sameRun: verdict.sameRun,
    avatar: { cosmetics: verdict.publicView.cosmetics },
    grants: verdict.grantsToInsert.map((record) => toServerGrantRow(record, userId)),
    burstCreditMinutes: verdict.burstCreditMinutes ?? 0,
    paceCredit: verdict.paceCredit ?? { cash: 0, clout: 0 },
  })
  if (!committed.ok) {
    switch (committed.code) {
      case 'conflict': {
        const latest = await backend.load(userId)
        return reply(409, { ok: false, code: 'conflict', head: headOf(latest?.save ?? null) })
      }
      case 'version':
        return reply(409, { ok: false, code: 'version', serverVersion: SAVE_VERSION })
      case 'rate-limited':
        return reply(429, {
          ok: false,
          code: 'rate-limited',
          retryAfterMs: sync.minUploadIntervalMs,
        })
      case 'attestation-required':
        return reply(403, { ok: false, code: 'attestation-required' })
    }
  }

  if (verdict.findings.length > 0) {
    logger.info('A cloud save was stored with repairs or a capped public level', {
      findings: verdict.findings,
    })
  }
  const held = new Set([...player.grantKeys, ...verdict.grantsToInsert.map((r) => r.key)])
  return reply(200, {
    ok: true,
    revision: committed.revision,
    acceptedAt: committed.acceptedAt,
    repairs: verdict.repairs,
    syncedGrantKeys: verdict.save.grants.log
      .map((record) => record.key)
      .filter((key) => held.has(key)),
  })
}
