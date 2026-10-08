import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { copy } from '@/lib/copy'
import { themeColorHex, uiStyle } from '@/lib/theme'
import './globals.css'

const APP_NAME = copy('app.name')
const TITLE = `${APP_NAME} | ${copy('app.tagline')}`
const DESCRIPTION = copy('app.description')

// The tagline lives in the title and the share metadata (S05): the page heading is for screen
// readers only, so the HUD keeps its room for play.
export const metadata: Metadata = {
  title: { default: TITLE, template: `%s | ${APP_NAME}` },
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: APP_NAME,
    type: 'website',
    locale: 'en_US',
  },
  twitter: { card: 'summary', title: TITLE, description: DESCRIPTION },
  applicationName: APP_NAME,
  appleWebApp: { capable: true, title: copy('app.shortName'), statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
  icons: { apple: '/icons/apple-touch-icon.png' },
}

// Locked to the device width with content drawn under the notch (safe areas are handled by the
// overlay layout). Pinch zoom is deliberately left enabled: disabling it fails WCAG 1.4.4, and the
// shell blocks scroll, bounce and double-tap zoom in CSS instead.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  // Day until the game clock is known (S04g): the HUD island switches the root's data-theme and
  // this meta tag with the clock.
  themeColor: themeColorHex('day'),
  colorScheme: 'light',
}

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // data-theme: the interface palette (S04g), day until the HUD island knows the game clock.
    // data-glass: frosted glass, switched on by that island where the device can afford it.
    <html lang="en" data-theme="day" data-glass="solid" style={uiStyle()}>
      <body className="antialiased">{children}</body>
    </html>
  )
}
