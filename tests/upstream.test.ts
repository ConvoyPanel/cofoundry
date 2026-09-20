import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
    SYNTHETIC_RECIPES,
    checkRecipes,
    classifyCheckResults,
    hasChanged,
} from '../src/upstream.ts'

describe('hasChanged', () => {
    test('returns true when nothing is stored yet', () => {
        expect(hasChanged(undefined, { etag: 'W/"abc"' })).toBe(true)
    })

    test('etag mismatch wins regardless of lastModified/contentLength', () => {
        const stored = {
            etag: 'W/"old"',
            lastModified: 'Sat, 18 May 2026 00:00:00 GMT',
            contentLength: '100',
        }
        const current = {
            etag: 'W/"new"',
            lastModified: 'Sat, 18 May 2026 00:00:00 GMT',
            contentLength: '100',
        }
        expect(hasChanged(stored, current)).toBe(true)
    })

    test('matching etag means unchanged even if other headers drift', () => {
        const stored = {
            etag: 'W/"same"',
            lastModified: 'A',
            contentLength: '1',
        }
        const current = {
            etag: 'W/"same"',
            lastModified: 'B',
            contentLength: '2',
        }
        expect(hasChanged(stored, current)).toBe(false)
    })

    test('without etag, falls back to lastModified + contentLength', () => {
        const stored = {
            lastModified: 'Sat, 18 May 2026 00:00:00 GMT',
            contentLength: '100',
        }
        expect(
            hasChanged(stored, {
                lastModified: 'Sat, 18 May 2026 00:00:00 GMT',
                contentLength: '100',
            })
        ).toBe(false)
        expect(
            hasChanged(stored, {
                lastModified: 'Sat, 18 May 2026 00:00:00 GMT',
                contentLength: '101',
            })
        ).toBe(true)
        expect(
            hasChanged(stored, {
                lastModified: 'Sun, 19 May 2026 00:00:00 GMT',
                contentLength: '100',
            })
        ).toBe(true)
    })

    test('treats partial etag (only one side has it) as needing the fallback compare', () => {
        // current has etag but stored doesn't — falls through to lastModified/contentLength compare
        expect(
            hasChanged(
                { lastModified: 'A', contentLength: '1' },
                { etag: 'W/"x"', lastModified: 'A', contentLength: '1' }
            )
        ).toBe(false)
    })
})

describe('SYNTHETIC_RECIPES', () => {
    test('includes virtio-win with the stable-virtio URL', () => {
        const virtio = SYNTHETIC_RECIPES.find(r => r.name === 'virtio-win')
        expect(virtio).toBeDefined()
        expect(virtio!.isoUrl).toContain('stable-virtio/virtio-win.iso')
    })

    /**
     * `cf check --json` feeds CI's build matrix directly, and a synthetic entry
     * has no `.pkr.hcl` to build. Emitting one failed the weekly run with
     * `ENOENT ... recipes/virtio-win.pkr.hcl` for as long as the pin was stale.
     */
    test('none of them name a real recipe file', () => {
        for (const recipe of SYNTHETIC_RECIPES) {
            expect(existsSync(join('recipes', `${recipe.name}.pkr.hcl`))).toBe(
                false
            )
        }
    })
})

describe('checkRecipes', () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    test('skips recipes without an isoUrl', async () => {
        let calls = 0
        globalThis.fetch = (async () => {
            calls++
            return new Response(null, { headers: {} })
        }) as typeof fetch

        const { results } = await checkRecipes([
            { name: 'no-iso', path: '/x', display: 'no-iso' },
        ])
        expect(results).toEqual([])
        expect(calls).toBe(0)
    })

    test('records error when HEAD request fails', async () => {
        globalThis.fetch = (async () =>
            new Response(null, { status: 500 })) as typeof fetch

        const { results } = await checkRecipes([
            {
                name: 'broken',
                path: '/x',
                display: 'broken',
                isoUrl: 'https://example.com/x.iso',
            },
        ])
        expect(results).toHaveLength(1)
        expect(results[0].name).toBe('broken')
        expect(results[0].changed).toBe(false)
        expect(results[0].error).toContain('HTTP 500')
    })

    test('reports changed=true on first sighting and updates the store', async () => {
        globalThis.fetch = (async () =>
            new Response(null, {
                headers: { 'etag': 'W/"v1"', 'content-length': '42' },
            })) as typeof fetch

        const { results, store } = await checkRecipes([
            {
                name: 'fresh',
                path: '/x',
                display: 'fresh',
                isoUrl: 'https://example.com/fresh.iso',
            },
        ])
        expect(results[0]).toMatchObject({ name: 'fresh', changed: true })
        expect(store.fresh.etag).toBe('W/"v1"')
        expect(store.fresh.contentLength).toBe('42')
    })
})

describe('classifyCheckResults', () => {
    /**
     * The bug this exists to stop repeating: the command reported
     * `changed && !error`, so a recipe whose ISO URL had 404'd was neither
     * changed nor an error anyone saw. debian-13 sat on a deleted URL for weeks
     * while the weekly workflow reported success.
     */
    test('an errored recipe is reported, not silently dropped', () => {
        const report = classifyCheckResults([
            { name: 'debian-13', changed: false, error: 'HTTP 404' },
            { name: 'debian-12', changed: false },
        ])

        expect(report.errors).toEqual([
            { name: 'debian-13', error: 'HTTP 404' },
        ])
        expect(report.buildable).toEqual([])
        expect(report.pinned).toEqual([])
    })

    test('a synthetic entry never reaches the build matrix', () => {
        const report = classifyCheckResults([
            { name: 'virtio-win', changed: true },
            { name: 'debian-12', changed: true },
        ])

        expect(report.buildable).toEqual(['debian-12'])
        expect(report.pinned).toEqual(['virtio-win'])
    })

    /** An error outranks a change: we cannot know what changed. */
    test('a recipe that both changed and errored counts only as an error', () => {
        const report = classifyCheckResults([
            { name: 'ubuntu-24.04', changed: true, error: 'HTTP 500' },
        ])

        expect(report.buildable).toEqual([])
        expect(report.errors).toHaveLength(1)
    })
})
