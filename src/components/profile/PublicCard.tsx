'use client'

import { copy, type CopyKey } from '@/lib/copy'
import type { MyProfile } from '@/lib/forms/handle'
import { HELD_HANDLE_PLACEHOLDER } from '@/lib/safety/reports'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/clout'
import '@/lib/copy/ns/profile'

/** Server-accepted levels (profiles_public_level_known) and their names. */
const LEVEL_NAME: Readonly<Record<string, CopyKey>> = {
  nobody: 'clout.levels.nobody.name',
  local: 'clout.levels.local.name',
  'scene-regular': 'clout.levels.sceneRegular.name',
  known: 'clout.levels.known.name',
  famous: 'clout.levels.famous.name',
  icon: 'clout.levels.icon.name',
}

/** Career paths (DEC-20 ids) as the Dream other players see. */
const DREAM_NAME: Readonly<Record<string, CopyKey>> = {
  influencer: 'profile.dream.influencer',
  streamer: 'profile.dream.streamer',
  'artist-dj': 'profile.dream.artistDj',
  'founder-hustler': 'profile.dream.founderHustler',
}

const levelName = (level: string) =>
  copy(LEVEL_NAME[level] ?? LEVEL_NAME.nobody ?? 'clout.levels.nobody.name')

/**
 * "How other players see you" (S18a, DEC-18): exactly the public profile, the handle, a 2D chip
 * of the look, the server-accepted level and the Dream, and nothing else (GR-7). The chip is
 * decorative: the handle next to it names the player.
 */
export function PublicCard({ profile }: { readonly profile: MyProfile }) {
  const handle = profile.handle ?? HELD_HANDLE_PLACEHOLDER
  const dreamKey = profile.career_path === null ? undefined : DREAM_NAME[profile.career_path]
  return (
    <section
      data-me-card=""
      aria-labelledby="me-card-title"
      className="flex flex-col gap-2 rounded-xl bg-raised p-3"
    >
      <h3 id="me-card-title" className="text-sm font-bold text-muted">
        {copy('profile.card.title')}
      </h3>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 border-taxi bg-canvas text-lg font-extrabold text-taxi-ink"
        >
          {handle.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0">
          <p data-me-handle="" className="truncate text-lg font-extrabold text-fg">
            {copy('profile.card.handle', { handle })}
          </p>
          <p className="text-sm text-muted">
            {copy('profile.card.level', { level: levelName(profile.public_level) })}
          </p>
          <p className="text-sm text-muted">
            {dreamKey === undefined
              ? copy('profile.card.noDream')
              : copy('profile.card.dream', { dream: copy(dreamKey) })}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted">{copy('profile.card.privacy')}</p>
    </section>
  )
}
