import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { SITE_ORIGIN, SITE_NAME, isNoindexPath } from '@/lib/seo/site'

/**
 * The web app manifest.
 *
 * WHAT WAS WRONG. app/layout.tsx advertised /manifest.json in two places — `metadata.manifest` and
 * a hand-written <link rel="manifest"> — while nothing served that path. There is no app/manifest.ts
 * and there was no public/manifest.json, so https://www.andrel.app/manifest.json returned 404 on
 * every page load, for every visitor, and every install prompt.
 *
 * WHY A STATIC FILE RATHER THAN app/manifest.ts. The App Router's manifest convention emits
 * /manifest.webmanifest — a DIFFERENT URL. Adopting it would have left the already-published
 * /manifest.json still 404ing unless the advertised URL changed too. A static file in public/ serves
 * the exact path the HTML has been pointing at all along.
 */

const MANIFEST_PATH = 'public/manifest.json'
const LAYOUT = readFileSync('app/layout.tsx', 'utf8')
const RAW = readFileSync(MANIFEST_PATH, 'utf8')

describe('the advertised manifest URL exists and is valid', () => {
  it('the file backing /manifest.json is present', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true)
  })

  it('is valid JSON', () => {
    expect(() => JSON.parse(RAW)).not.toThrow()
  })

  it('is served at exactly the path the layout advertises', () => {
    // public/manifest.json -> /manifest.json. If the advertised path ever changes, this fails.
    expect(LAYOUT).toMatch(/manifest: '\/manifest\.json'/)
    expect(MANIFEST_PATH).toBe('public/manifest.json')
  })

  it('is declared ONCE — Next emits the <link> from metadata.manifest', () => {
    const head = LAYOUT.slice(LAYOUT.indexOf('<head>'), LAYOUT.indexOf('</head>'))
    expect(head).not.toMatch(/<link\s+rel="manifest"/)
    expect((LAYOUT.match(/manifest: '\/manifest\.json'/g) ?? [])).toHaveLength(1)
  })
})

describe('required fields are present and accurate', () => {
  const m = JSON.parse(RAW)

  it('carries name and short_name matching the site identity', () => {
    expect(m.name).toBe(SITE_NAME)
    expect(m.short_name).toBe(SITE_NAME)
  })

  it('carries the same description as the site metadata — not a new product claim', () => {
    expect(typeof m.description).toBe('string')
    expect(m.description.length).toBeGreaterThan(20)
    // byte-identical to the description already approved in app/layout.tsx and the JSON-LD graph
    expect(LAYOUT).toContain(m.description)
    expect(readFileSync('lib/seo/site.ts', 'utf8')).toContain(m.description)
  })

  it('declares start_url, scope, display', () => {
    expect(m.start_url).toBe('/')
    expect(m.scope).toBe('/')
    expect(['standalone', 'fullscreen', 'minimal-ui', 'browser']).toContain(m.display)
  })

  it('uses the existing brand colours', () => {
    expect(m.theme_color).toBe('#1B2850')      // brand.navy
    expect(m.background_color).toBe('#F5F6FB') // brand.cream
    const tw = readFileSync('tailwind.config.ts', 'utf8')
    expect(tw).toContain(m.theme_color)
    expect(tw).toContain(m.background_color)
    // and the theme_color agrees with what the HTML already says
    expect(LAYOUT).toContain(`content="${m.theme_color}"`)
  })

  it('has every field a browser needs to offer installation', () => {
    for (const k of ['name', 'short_name', 'description', 'start_url', 'display',
                     'background_color', 'theme_color', 'icons']) {
      expect(m).toHaveProperty(k)
    }
  })
})

describe('icons resolve to real assets', () => {
  const m = JSON.parse(RAW)

  it('declares at least the 192 and 512 marks', () => {
    expect(Array.isArray(m.icons)).toBe(true)
    const sizes = m.icons.map((i: any) => i.sizes)
    expect(sizes).toContain('192x192')
    expect(sizes).toContain('512x512')
  })

  it('EVERY referenced local icon exists on disk', () => {
    for (const icon of m.icons) {
      expect(icon.src.startsWith('/')).toBe(true)      // root-relative, no external host
      expect(existsSync(`public${icon.src}`)).toBe(true)
    }
  })

  it('each declared size matches the asset it points at', () => {
    for (const icon of m.icons) {
      const svg = readFileSync(`public${icon.src}`, 'utf8')
      const [w, h] = icon.sizes.split('x')
      expect(svg).toContain(`width="${w}"`)
      expect(svg).toContain(`height="${h}"`)
      expect(icon.type).toBe('image/svg+xml')
    }
  })

  it('does not claim a purpose the marks were not drawn for', () => {
    // These are a rounded square with a centred letter. Declaring "maskable" would promise a safe
    // zone that was never designed, and Android would crop into the glyph.
    for (const icon of m.icons) expect(icon.purpose ?? 'any').toBe('any')
  })
})

describe('no private surface is exposed through the manifest', () => {
  const m = JSON.parse(RAW)

  it('start_url and scope are public routes', () => {
    expect(isNoindexPath(m.start_url)).toBe(false)
    expect(isNoindexPath(m.scope)).toBe(false)
  })

  it('no value anywhere references an authenticated or private path', () => {
    const flat = JSON.stringify(m)
    for (const p of ['/dashboard', '/onboarding', '/auth', '/login', '/legal/accept',
                     '/manage-information', '/company', '/demo', '/api', '/resume']) {
      expect(flat).not.toContain(p)
    }
  })

  it('references no external origin, and never the apex host', () => {
    const flat = JSON.stringify(m)
    expect(flat).not.toMatch(/https?:\/\//)
    expect(flat).not.toContain('andrel.app')      // relative paths only; canonical stays www
    expect(SITE_ORIGIN).toBe('https://www.andrel.app')
  })
})
