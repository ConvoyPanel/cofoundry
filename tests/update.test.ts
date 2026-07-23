import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecipeInfo } from '@/config.ts'
import { applyIsoUpdate } from '@/update.ts'

const NEW_SHA =
    'c3514bf0056180d09376462a7a1b4f213c1d6e8ea67fae5c25099c6fd3d8274b'

const recipeHcl = (pin: string): string =>
    `# display: Test
# iso_url: https://example.com/foo-1.0-amd64.iso
# iso_target_path: \${var.iso_cache_dir}/packer-foo-1.0-amd64.iso

source "proxmox-iso" "t" {
  boot_iso {
    iso_checksum = "sha256:${pin}"
  }
}
`

const writeRecipe = async (pin: string): Promise<RecipeInfo> => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-update-'))
    const path = join(dir, 'test.pkr.hcl')
    await writeFile(path, recipeHcl(pin))
    return {
        name: 'test',
        path,
        display: 'Test',
        arch: 'amd64',
        isoTargetPath: '/var/lib/vz/template/iso/packer-foo-1.0-amd64.iso',
    }
}

describe('applyIsoUpdate', () => {
    test('rewrites an UPPERCASE pin — a vendor-pasted hash must not survive an update', async () => {
        // A case-sensitive pin regex would advance iso_url but silently keep
        // the old pin, leaving the recipe permanently failing verification.
        const recipe = await writeRecipe(
            'E907D92EEEC9DF64163A7E454CBC8D7755E8DDC7ED42F99DBC80C40F1A138433'
        )
        const changed = await applyIsoUpdate(recipe, {
            filename: 'foo-1.1-amd64.iso',
            sha256: NEW_SHA,
            isoUrl: 'https://example.com/foo-1.1-amd64.iso',
        })
        expect(changed).toBe(true)
        const out = await readFile(recipe.path, 'utf8')
        expect(out).toContain(`iso_checksum = "sha256:${NEW_SHA}"`)
        expect(out).not.toContain('E907D92E')
        expect(out).toContain(
            '# iso_url: https://example.com/foo-1.1-amd64.iso'
        )
    })

    test('rewrites a lowercase pin the same way', async () => {
        const recipe = await writeRecipe(
            'e907d92eeec9df64163a7e454cbc8d7755e8ddc7ed42f99dbc80c40f1a138433'
        )
        const changed = await applyIsoUpdate(recipe, {
            filename: 'foo-1.1-amd64.iso',
            sha256: NEW_SHA,
            isoUrl: 'https://example.com/foo-1.1-amd64.iso',
        })
        expect(changed).toBe(true)
        const out = await readFile(recipe.path, 'utf8')
        expect(out).toContain(`iso_checksum = "sha256:${NEW_SHA}"`)
    })
})
