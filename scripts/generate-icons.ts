/**
 * Renders the PWA icon PNGs from public/icons/icon.svg with Playwright's Chromium.
 * Run after changing the SVG: `node scripts/generate-icons.ts`. Output is committed.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const iconsDir = fileURLToPath(new URL('../public/icons/', import.meta.url))

// The SVG is full-bleed with its artwork inside the central 80% circle, so the same source is
// a valid maskable icon (https://web.dev/articles/maskable-icon).
const OUTPUTS = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'icon-maskable-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180 },
] as const

const svg = await readFile(`${iconsDir}icon.svg`, 'utf8')
const browser = await chromium.launch()
try {
  for (const { file, size } of OUTPUTS) {
    const page = await browser.newPage({ viewport: { width: size, height: size } })
    await page.setContent(
      `<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
    )
    await page.screenshot({ path: `${iconsDir}${file}`, omitBackground: false })
    await page.close()
  }
} finally {
  await browser.close()
}
