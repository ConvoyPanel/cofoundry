import { describe, expect, test } from 'bun:test'
import { affectedRecipes } from '@/affected.ts'

const recipes = [
    'debian-13',
    'rocky-linux-9',
    'ubuntu-24.04',
    'windows-server-2019',
    'windows-server-2025',
]

describe('affectedRecipes', () => {
    test("a recipe's own files rebuild that recipe only", () => {
        expect(
            affectedRecipes(
                [
                    'recipes/debian-13.pkr.hcl',
                    'recipes/rocky-linux-9/http/ks.cfg',
                ],
                recipes
            )
        ).toEqual(['debian-13', 'rocky-linux-9'])
    })

    test('the shared Linux finalize step rebuilds every Linux recipe', () => {
        expect(
            affectedRecipes(['recipes/_shared/linux/finalize.sh'], recipes)
        ).toEqual(['debian-13', 'rocky-linux-9', 'ubuntu-24.04'])
    })

    test('the shared Windows scripts rebuild every Windows recipe', () => {
        expect(
            affectedRecipes(['recipes/_shared/windows/Finalize.ps1'], recipes)
        ).toEqual(['windows-server-2019', 'windows-server-2025'])
    })

    test('the export post-processor and placeholder injection rebuild everything', () => {
        expect(
            affectedRecipes(['recipes/_shared/post/export-disks.sh'], recipes)
        ).toEqual([...recipes].sort())
        expect(
            affectedRecipes(['scripts/inject-placeholders.sh'], recipes)
        ).toEqual([...recipes].sort())
    })

    test('tooling, docs and a retired recipe rebuild nothing', () => {
        expect(
            affectedRecipes(
                [
                    'src/build/prefetch.ts',
                    'docs/recipes.md',
                    'recipes/ubuntu-25.10.pkr.hcl',
                    'recipes/ubuntu-25.10/http/user-data',
                ],
                recipes
            )
        ).toEqual([])
    })
})
