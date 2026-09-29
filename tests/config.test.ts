import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { listRecipes, loadRecipe } from '../src/config.ts'

const FIXTURES = fileURLToPath(new URL('./fixtures/recipes/', import.meta.url))

describe('loadRecipe', () => {
    test('parses display and build_vmid from header comments', async () => {
        const r = await loadRecipe('recipe-minimal', FIXTURES)
        expect(r.name).toBe('recipe-minimal')
        expect(r.display).toBe('Minimal Recipe')
        expect(r.notice).toBeUndefined()
        expect(r.buildVmid).toBe(9999)
        expect(r.buildCores).toBe(2)
        expect(r.buildMemoryMb).toBe(4096)
        expect(r.isoUrl).toBeUndefined()
        expect(r.isoTargetPath).toBeUndefined()
    })

    test('parses iso_url and iso_target_path from recipe metadata', async () => {
        const r = await loadRecipe('recipe-with-iso', FIXTURES)
        expect(r.display).toBe('Recipe With ISO')
        expect(r.notice).toBe('Unsupported; do not use.')
        expect(r.buildVmid).toBe(9101)
        expect(r.isoUrl).toBe('https://example.com/foo-1.2.3-amd64.iso')
        expect(r.isoTargetPath).toBe(
            '/var/lib/cofoundry/iso-cache/foo-1.2.3-amd64.iso'
        )
    })

    test('only captures the first iso_target_path (boot ISO, not additional)', async () => {
        const r = await loadRecipe('recipe-with-iso', FIXTURES)
        expect(r.isoTargetPath).not.toContain('virtio-win')
    })

    test('parses final_disk_size when present, undefined otherwise', async () => {
        const withSize = await loadRecipe('recipe-with-iso', FIXTURES)
        expect(withSize.finalDiskSize).toBe('16G')
        const minimal = await loadRecipe('recipe-minimal', FIXTURES)
        expect(minimal.finalDiskSize).toBeUndefined()
    })

    test('falls back to name when display header is missing', async () => {
        const r = await loadRecipe('recipe-nometa', FIXTURES)
        expect(r.display).toBe('recipe-nometa')
        expect(r.buildVmid).toBeUndefined()
    })
})

describe('listRecipes', () => {
    test('returns all *.pkr.hcl entries sorted by name', async () => {
        const recipes = await listRecipes(FIXTURES)
        const names = recipes.map(r => r.name)
        expect(names).toEqual([
            'recipe-minimal',
            'recipe-nometa',
            'recipe-with-iso',
        ])
    })

    test('skips non-pkr files', async () => {
        const recipes = await listRecipes(FIXTURES)
        for (const r of recipes) {
            expect(r.path.endsWith('.pkr.hcl')).toBe(true)
        }
    })
})
