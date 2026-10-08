import { SoundSheetMount } from '@/components/audio/SoundSheetMount'
import { EventSheetMount } from '@/components/events/EventSheetMount'
import { IconMomentMount } from '@/components/goals/IconMomentMount'
import { HudFrame } from '@/components/hud/HudFrame'
import { HudPanelMount } from '@/components/hud/HudPanelMount'
import { LevelUpToastMount } from '@/components/hud/LevelUpToastMount'
import { BottomTabs } from '@/components/nav/BottomTabs'
import { OfflineSupportMount } from '@/components/offline/OfflineSupportMount'
import { OverlayLayout } from '@/components/overlay/OverlayLayout'
import { PlaceSheetMount } from '@/components/places/PlaceSheetMount'
import { PlacesButton } from '@/components/places/PlacesButton'
import { PlacesPanelMount } from '@/components/places/PlacesPanelMount'
import { AccountNoticesMount } from '@/components/safety/AccountNoticesMount'
import { SafetyToastMount } from '@/components/safety/SafetyToastMount'
import { TourMount } from '@/components/tour/TourMount'
import { WelcomeMount } from '@/components/welcome/WelcomeMount'
import { copy } from '@/lib/copy'
import { CityScene } from '@/scene/CityScene'

export default function HomePage() {
  return (
    <>
      {/* Without JavaScript the shell stays dimmed behind the 18+ gate's boot hold (UI-12): say
          why instead of showing a loading city forever. Above every overlay layer. */}
      <noscript>
        <p className="fixed inset-x-4 top-[max(1rem,env(safe-area-inset-top))] z-[1000] mx-auto max-w-prose rounded-2xl border border-taxi glass px-4 py-3 text-center text-sm font-semibold text-fg shadow-lg">
          {copy('app.noscript')}
        </p>
      </noscript>
      <OverlayLayout
        modal={
          <>
            <WelcomeMount />
            <IconMomentMount />
            <AccountNoticesMount />
          </>
        }
        slots={{
          banner: (
            <>
              <TourMount />
              <OfflineSupportMount />
            </>
          ),
          hud: <HudFrame places={<PlacesButton />} />,
          toast: (
            <>
              <LevelUpToastMount />
              <SafetyToastMount />
            </>
          ),
          sheet: (
            <>
              <EventSheetMount />
              <PlaceSheetMount />
              <PlacesPanelMount />
              <HudPanelMount />
              <SoundSheetMount />
            </>
          ),
          tabs: <BottomTabs />,
        }}
      >
        <CityScene />
      </OverlayLayout>
    </>
  )
}
