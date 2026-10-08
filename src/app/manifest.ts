import type { MetadataRoute } from 'next'
import { copy } from '@/lib/copy'
import { themeColorHex } from '@/lib/theme'

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: copy('app.name'),
    short_name: copy('app.shortName'),
    description: copy('app.description'),
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: themeColorHex(),
    theme_color: themeColorHex(),
    categories: ['games'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icons/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
