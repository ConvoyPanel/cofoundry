import { writeFile } from 'node:fs/promises'
import type { Command } from 'commander'
import PQueue from 'p-queue'
import pc from 'picocolors'
import { listRecipes, loadRecipe } from '@/config.ts'
import { resolveIsoUpdate, applyIsoUpdate } from '@/update.ts'
import {
    checkRecipes,
    classifyCheckResults,
    SYNTHETIC_RECIPES,
    saveChecksums,
} from '@/upstream.ts'
import { log } from '@/log.ts'

const listCommand = async (): Promise<void> => {
    const recipes = await listRecipes()
    if (recipes.length === 0) {
        log.warn('No recipes found in recipes/')
        return
    }
    log.section(`Recipes ${pc.dim(`(${recipes.length})`)}`)
    const width = Math.max(...recipes.map(recipe => recipe.name.length))
    for (const recipe of recipes) {
        log.raw(
            `  ${pc.cyan(recipe.name.padEnd(width))}  ${pc.dim('·')}  ${recipe.display}`
        )
    }
    log.blank()
}

const updateCommand = async (names: string[]): Promise<void> => {
    const recipes =
        names.length > 0
            ? await Promise.all(names.map(name => loadRecipe(name)))
            : await listRecipes()
    const updatable = recipes.filter(
        recipe => recipe.isoChecksumUrl && recipe.isoFilenameRe
    )
    if (updatable.length === 0) {
        log.warn('No recipes with iso_checksum_url found')
        return
    }

    log.section(
        `Update ISOs ${pc.dim(`(${updatable.length} recipe${updatable.length === 1 ? '' : 's'})`)}`
    )
    const updated: string[] = []
    const failed: string[] = []
    const width = Math.max(...updatable.map(recipe => recipe.name.length))

    // Recipes are independent network fetches, so run several at once. Each
    // recipe already has a per-fetch timeout, so a slow mirror no longer holds
    // up the rest — total time is bounded by the slowest recipe, not their sum.
    const queue = new PQueue({ concurrency: 4 })
    await queue.addAll(
        updatable.map(recipe => async () => {
            const label = pc.cyan(recipe.name.padEnd(width))
            try {
                const iso = await resolveIsoUpdate(recipe)
                if (!iso) return
                if (await applyIsoUpdate(recipe, iso)) {
                    log.ok(`${label} ${pc.dim('→')} ${iso.filename}`)
                    updated.push(recipe.name)
                } else {
                    log.info(`${label} ${pc.dim('·')} already up to date`)
                }
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error)
                log.err(`${label} ${pc.dim('·')} ${message}`)
                failed.push(recipe.name)
            }
        })
    )

    log.blank()
    if (updated.length > 0)
        log.ok(`Updated ${updated.length}/${updatable.length}.`)
    else log.info('No changes.')
    if (failed.length > 0) {
        log.err(`${failed.length} failed: ${failed.join(', ')}`)
        process.exitCode = 1
    }
}

const checkCommand = async (
    name: string | undefined,
    opts: { json?: boolean; report?: string }
): Promise<void> => {
    const recipes = name ? [await loadRecipe(name)] : await listRecipes()
    const synthetic = SYNTHETIC_RECIPES.map(recipe => ({
        name: recipe.name,
        path: '<synthetic>',
        display: recipe.name,
        isoUrl: recipe.isoUrl,
        arch: 'amd64',
    }))
    const candidates = [...recipes, ...(name ? [] : synthetic)].filter(
        recipe => recipe.isoUrl
    )
    if (candidates.length === 0) {
        log.warn('No recipes with an iso_url found in boot_iso block')
        if (opts.json) console.log('[]')
        return
    }

    const { results, store } = await checkRecipes(candidates)
    if (!opts.json) {
        log.section(
            `Upstream check ${pc.dim(`(${results.length} recipe${results.length === 1 ? '' : 's'})`)}`
        )
        const width = Math.max(...results.map(result => result.name.length))
        for (const result of results) {
            const label = pc.cyan(result.name.padEnd(width))
            if (result.error)
                log.warn(`${label} ${pc.dim('·')} ${result.error}`)
            else if (result.changed)
                log.ok(`${label} ${pc.dim('·')} upstream changed`)
            else log.info(`${label} ${pc.dim('·')} up to date`)
        }
    }

    await saveChecksums(store)

    // Classified in one place so the three outcomes cannot be collapsed again;
    // see classifyCheckResults for what each means and why it matters.
    const { buildable, pinned, errors } = classifyCheckResults(results)

    for (const name of pinned) {
        log.warn(
            `Pinned download changed upstream: ${name}. ` +
                'Bump the pin in the recipes that consume it; there is nothing to build.'
        )
    }

    for (const failure of errors) {
        log.warn(`${failure.name} could not be checked: ${failure.error}`)
    }

    if (opts.report) {
        await writeFile(
            opts.report,
            JSON.stringify({ buildable, pinned, errors }, null, 2) + '\n'
        )
    }

    if (opts.json) console.log(JSON.stringify(buildable))
    else {
        log.blank()
        if (buildable.length > 0)
            log.ok(
                `${buildable.length} recipe(s) have a new upstream ISO: ${buildable.join(', ')}`
            )
        // Only when nothing drifted AND everything could actually be checked.
        // Saying "up to date" over a recipe whose URL 404'd is the claim this
        // whole path exists to stop making.
        else if (pinned.length === 0 && errors.length === 0)
            log.ok('All recipes are up to date.')
        else if (errors.length > 0)
            log.warn(
                `${errors.length} recipe(s) could not be checked: ${errors.map(e => e.name).join(', ')}`
            )
    }
}

export const registerRecipeCommands = (program: Command): void => {
    program
        .command('list')
        .description('List available build recipes')
        .action(listCommand)

    program
        .command('update [names...]')
        .description(
            'Fetch upstream checksum files and update ISO metadata in HCL recipes'
        )
        .action(updateCommand)

    program
        .command('check [name]')
        .description('Check upstream ISO URLs for changes')
        .option('--json', 'Output changed recipe names as a JSON array')
        .option(
            '--report <path>',
            'Write {buildable, pinned, errors} as JSON, for CI to act on'
        )
        .action(checkCommand)
}
