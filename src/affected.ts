import { execa } from 'execa'

/**
 * Which recipes a set of changed repository paths requires rebuilding.
 *
 * A merged recipe change used to reach the CDN only when the recipe's ISO next
 * moved, or after someone remembered to dispatch a forced rebuild. Until then
 * every new clone kept getting the image the change was written to fix.
 *
 * - `recipes/<name>.pkr.hcl` and anything under `recipes/<name>/` rebuild that
 *   recipe.
 * - `recipes/_shared/linux/` rebuilds every Linux recipe; `_shared/windows/`
 *   every Windows one.
 * - `recipes/_shared/post/` (the export post-processor) and
 *   `scripts/inject-placeholders.sh` run in every build, so they rebuild all.
 *
 * Tooling under `src/` does not by itself change what an image contains, so it
 * rebuilds nothing here. Paths that name a recipe that no longer exists are
 * ignored. The result is sorted.
 */
export const affectedRecipes = (
    paths: string[],
    recipes: string[]
): string[] => {
    const known = new Set(recipes)
    const windows = recipes.filter(r => r.startsWith('windows-'))
    const linux = recipes.filter(r => !r.startsWith('windows-'))
    const out = new Set<string>()
    const add = (names: string[]) => names.forEach(n => out.add(n))

    for (const path of paths) {
        if (path === 'scripts/inject-placeholders.sh') add(recipes)
        else if (path.startsWith('recipes/_shared/linux/')) add(linux)
        else if (path.startsWith('recipes/_shared/windows/')) add(windows)
        else if (path.startsWith('recipes/_shared/')) add(recipes)
        else {
            const m = path.match(/^recipes\/([^/]+?)(?:\.pkr\.hcl|\/.*)$/)
            if (m && known.has(m[1]!)) out.add(m[1]!)
        }
    }
    return [...out].sort()
}

/** Paths that differ between two commits, as git names them. */
export const changedPaths = async (
    base: string,
    head: string
): Promise<string[]> => {
    const { stdout } = await execa('git', [
        'diff',
        '--name-only',
        '--no-renames',
        base,
        head,
    ])
    return stdout.split('\n').filter(Boolean)
}
