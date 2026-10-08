/**
 * The cloud save storage (S18c) on Supabase, through the service-role client: reads with
 * explicit columns, writes only through the service-only `commit_save` and `quarantine_save`
 * (supabase/migrations/*_s18c_save_sync.sql). A database error throws (the route answers 503).
 */
import 'server-only'
import { sync } from '@/lib/data/config'
import type { Json } from '@/lib/supabase/database.types'
import type { ServiceClient } from '@/server/supabase/service'
import type { CommitOutcome, PlayerRecord, SaveBackend } from './handleUpload'

interface PostgrestFailure {
  readonly code?: string
  readonly message: string
}

class BackendError extends Error {
  constructor(what: string, error: PostgrestFailure) {
    // The code and message are machine codes and Postgres text: never the save or the user.
    super(`${what} failed: ${error.code ?? 'unknown'} ${error.message}`)
    this.name = 'SaveBackendError'
  }
}

export function supabaseSaveBackend(client: ServiceClient): SaveBackend {
  return {
    async userIdFor(accessToken) {
      const { data, error } = await client.auth.getUser(accessToken)
      if (error !== null || data.user === null) return null
      return data.user.id
    },

    async load(userId) {
      const [profile, save, grants, entitlements] = await Promise.all([
        client.from('profiles').select('attested, created_at').eq('id', userId).maybeSingle(),
        client
          .from('saves')
          .select(
            'revision, save_version, data, accepted_at, last_device_id, burst_credit_minutes, pace_credit_cash, pace_credit_clout',
          )
          .eq('user_id', userId)
          .maybeSingle(),
        client.from('grants').select('idempotency_key').eq('user_id', userId),
        client.from('entitlements').select('item_id').eq('user_id', userId).is('revoked_at', null),
      ])
      for (const [what, result] of [
        ['profile', profile],
        ['save', save],
        ['grants', grants],
        ['entitlements', entitlements],
      ] as const) {
        if (result.error !== null) throw new BackendError(`Reading the ${what}`, result.error)
      }
      if (profile.data === null) return null
      const row = save.data
      const record: PlayerRecord = {
        attested: profile.data.attested,
        createdAt: profile.data.created_at,
        save:
          row === null
            ? null
            : {
                revision: row.revision,
                saveVersion: row.save_version,
                data: row.data,
                acceptedAt: row.accepted_at,
                deviceId: row.last_device_id,
                burstCreditMinutes: row.burst_credit_minutes,
                paceCredit: { cash: row.pace_credit_cash, clout: row.pace_credit_clout },
              },
        grantKeys: (grants.data ?? []).map((grant) => grant.idempotency_key),
        entitledItemIds: (entitlements.data ?? []).map((entitlement) => entitlement.item_id),
      }
      return record
    },

    async saveAt(userId, revision) {
      const { data, error } = await client.rpc('save_at_revision', {
        p_user_id: userId,
        p_revision: revision,
      })
      if (error !== null) throw new BackendError('save_at_revision', error)
      const [row] = data
      return row === undefined
        ? null
        : {
            saveVersion: row.save_version,
            data: row.data,
            acceptedAt: row.accepted_at,
            burstCreditMinutes: row.burst_credit_minutes,
            paceCredit: { cash: row.pace_credit_cash, clout: row.pace_credit_clout },
          }
    },

    async ledgerAt(userId, revision) {
      const { data, error } = await client.rpc('revision_at', {
        p_user_id: userId,
        p_revision: revision,
      })
      if (error !== null) throw new BackendError('revision_at', error)
      const [row] = data
      return row === undefined
        ? null
        : {
            acceptedAt: row.accepted_at,
            burstCreditMinutes: row.burst_credit_minutes,
            paceCredit: { cash: row.pace_credit_cash, clout: row.pace_credit_clout },
            baseline:
              row.base_actions === null ||
              row.base_minute === null ||
              row.base_run === null ||
              row.base_prestige_count === null
                ? null
                : {
                    actions: row.base_actions,
                    minute: row.base_minute,
                    run: row.base_run,
                    prestigeCount: row.base_prestige_count,
                  },
          }
    },

    async consumeOverride(userId) {
      const { error } = await client.rpc('consume_save_override', {
        p_user_id: userId,
        p_max: sync.plausibility.overrideMaxPerHour,
      })
      if (error === null) return 'ok'
      if (error.message === 'rate_limited') return 'rate-limited'
      throw new BackendError('consume_save_override', error)
    },

    async commit(args): Promise<CommitOutcome> {
      const { data, error } = await client.rpc('commit_save', {
        p_user_id: args.userId,
        p_expected_revision: args.expectedRevision,
        p_save_version: args.saveVersion,
        p_data: args.data as unknown as Json,
        p_device_id: args.deviceId,
        // The generated types make every argument required; SQL takes null for these.
        p_client_saved_at: args.clientSavedAt as string,
        p_public_level: args.publicLevel,
        p_career_path: args.careerPath as string,
        p_same_run: args.sameRun,
        p_avatar: args.avatar as unknown as Json,
        p_grants: args.grants as unknown as Json,
        p_burst_credit_minutes: args.burstCreditMinutes,
        p_pace_credit_cash: args.paceCredit.cash,
        p_pace_credit_clout: args.paceCredit.clout,
        p_min_interval_ms: sync.minUploadIntervalMs,
        p_max_per_minute: sync.maxUploadsPerMinute,
        p_history_keep: sync.historyKeep,
        p_ledger_keep: sync.revisionLedgerKeep,
      })
      if (error !== null) {
        if (error.message === 'revision_conflict') return { ok: false, code: 'conflict' }
        if (error.message === 'version_regressed') return { ok: false, code: 'version' }
        if (error.message === 'rate_limited') return { ok: false, code: 'rate-limited' }
        if (error.message === 'attestation_required') {
          return { ok: false, code: 'attestation-required' }
        }
        throw new BackendError('commit_save', error)
      }
      const [saved] = data
      if (saved === undefined) throw new Error('commit_save returned no row')
      return { ok: true, revision: saved.saved_revision, acceptedAt: saved.saved_at }
    },

    async quarantine(args) {
      const { error } = await client.rpc('quarantine_save', {
        p_user_id: args.userId,
        p_base_revision: args.baseRevision,
        p_save_version: args.saveVersion,
        p_data: args.data as Json,
        p_findings: [...args.findings],
        p_device_id: args.deviceId,
        p_max_per_minute: sync.maxUploadsPerMinute,
        p_quarantine_keep: sync.quarantineKeep,
      })
      if (error === null) return 'ok'
      if (error.message === 'rate_limited') return 'rate-limited'
      throw new BackendError('quarantine_save', error)
    },
  }
}
