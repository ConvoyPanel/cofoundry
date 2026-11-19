import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { RecipeInfo } from '@/config.ts'
import { fetchWithRetry } from '@/util.ts'

const CHECKSUMS_FILE = fileURLToPath(
    new URL('../upstream-checksums.json', import.meta.url)
)
const REGISTRY_FILE = fileURLToPath(
    new URL('../registry.json', import.meta.url)
)

/**
 * How old a published template may get before `cf check` asks for a rebuild
 * with nothing changed upstream.
 *
 * An ISO changes a few times a year; the packages on it change every week. A
 * template rebuilt only when its ISO moved shipped months-old packages and
 * left every clone to download them on first boot, while the distros publish
 * fresh cloud images at least monthly. Windows gains the month's cumulative
 * update the same way.
 */
export const MAX_TEMPLATE_AGE_DAYS = 30

interface UpstreamState {
    lastModified?: string
    contentLength?: string
    etag?: string
}

type ChecksumStore = Record<string, UpstreamState>

/**
 * Synthetic "recipes" tracked alongside the .pkr.hcl files: pinned third-party
 * downloads whose drift should trigger a CI signal even though no recipe owns
 * them directly. When the URL's headers change, maintainers should bump the
 * pin in the recipes that consume it.
 */
export const SYNTHETIC_RECIPES: { name: string; isoUrl: string }[] = [
    {
        name: 'virtio-win',
        isoUrl: 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso',
    },
]

export interface CheckResult {
    name: string
    changed: boolean
    error?: string
    /** Why an unchanged ISO still needs a build: the template is too old, or was never published. */
    stale?: string
}

/**
 * Split a check into the three things a caller has to treat differently.
 *
 * Pulled out and tested because collapsing them is what went wrong: the command
 * reported `changed && !error`, so a recipe whose URL had 404'd was neither
 * "changed" nor an error anybody saw. debian-13 sat on a deleted ISO for weeks
 * while the weekly workflow reported success.
 *
 *  - `buildable` is what CI can put in a build matrix: changed, no error, and a
 *    real recipe behind it.
 *  - `pinned` is a synthetic entry that drifted. There is nothing to build; a
 *    maintainer bumps the pin in the recipes that consume it.
 *  - `errors` is "could not tell", which is not the same as "up to date".
 */
export interface CheckReport {
    buildable: string[]
    pinned: string[]
    errors: { name: string; error: string }[]
}

export const classifyCheckResults = (results: CheckResult[]): CheckReport => {
    const synthetic = new Set(SYNTHETIC_RECIPES.map(recipe => recipe.name))

    return {
        buildable: results
            .filter(r => r.changed && !r.error && !synthetic.has(r.name))
            .map(r => r.name),
        pinned: results
            .filter(r => r.changed && !r.error && synthetic.has(r.name))
            .map(r => r.name),
        errors: results
            .filter(r => r.error)
            .map(r => ({ name: r.name, error: r.error! })),
    }
}

export const loadChecksums = async (): Promise<ChecksumStore> => {
    try {
        return JSON.parse(
            await readFile(CHECKSUMS_FILE, 'utf8')
        ) as ChecksumStore
    } catch {
        return {}
    }
}

export const saveChecksums = async (store: ChecksumStore): Promise<void> => {
    await writeFile(CHECKSUMS_FILE, JSON.stringify(store, null, 2) + '\n')
}

const fetchState = async (url: string): Promise<UpstreamState> => {
    const res = await fetchWithRetry(url, { method: 'HEAD' })
    if (!res.ok) throw new Error(`HEAD ${url} → HTTP ${res.status}`)
    return {
        lastModified: res.headers.get('last-modified') ?? undefined,
        contentLength: res.headers.get('content-length') ?? undefined,
        etag: res.headers.get('etag') ?? undefined,
    }
}

/** `built_at` per recipe name from the published registry. */
export const publishedBuildTimes = (registry: unknown): Map<string, Date> => {
    const times = new Map<string, Date>()
    const groups = (registry as { groups?: unknown[] })?.groups ?? []
    for (const group of groups) {
        const templates = (group as { templates?: unknown[] })?.templates ?? []
        for (const t of templates as {
            name?: string
            arch?: string
            built_at?: string
        }[]) {
            if (!t.name || !t.built_at) continue
            const recipe =
                t.arch && t.name.endsWith(`-${t.arch}`)
                    ? t.name.slice(0, -(t.arch.length + 1))
                    : t.name
            const at = new Date(t.built_at)
            if (!Number.isNaN(at.getTime())) times.set(recipe, at)
        }
    }
    return times
}

/**
 * Mark recipes whose ISO did not change but whose published template is older
 * than `maxAgeDays`, or that have never been published, as needing a build.
 * Errors and synthetic entries are left alone.
 */
export const markStale = (
    results: CheckResult[],
    builtAt: Map<string, Date>,
    now: Date,
    maxAgeDays: number = MAX_TEMPLATE_AGE_DAYS
): CheckResult[] => {
    const synthetic = new Set(SYNTHETIC_RECIPES.map(recipe => recipe.name))
    return results.map(r => {
        if (r.changed || r.error || synthetic.has(r.name)) return r
        const at = builtAt.get(r.name)
        if (!at) return { ...r, changed: true, stale: 'never published' }
        const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000)
        return days > maxAgeDays
            ? { ...r, changed: true, stale: `built ${days} days ago` }
            : r
    })
}

/**
 * Build times from the committed registry, or `undefined` when there is no
 * registry to go by. An unreadable or empty registry must not read as "every
 * template is unpublished": that would rebuild all of them, Windows included,
 * on the next scheduled run.
 */
export const loadPublishedBuildTimes = async (): Promise<
    Map<string, Date> | undefined
> => {
    let raw: string
    try {
        raw = await readFile(REGISTRY_FILE, 'utf8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw err
    }
    const times = publishedBuildTimes(JSON.parse(raw))
    return times.size > 0 ? times : undefined
}

export const hasChanged = (
    stored: UpstreamState | undefined,
    current: UpstreamState
): boolean => {
    if (!stored) return true
    if (current.etag && stored.etag) return current.etag !== stored.etag
    return (
        current.lastModified !== stored.lastModified ||
        current.contentLength !== stored.contentLength
    )
}

export const checkRecipes = async (
    recipes: RecipeInfo[]
): Promise<{ results: CheckResult[]; store: ChecksumStore }> => {
    const store = await loadChecksums()
    const results: CheckResult[] = []

    for (const recipe of recipes) {
        if (!recipe.isoUrl) continue
        try {
            const current = await fetchState(recipe.isoUrl)
            results.push({
                name: recipe.name,
                changed: hasChanged(store[recipe.name], current),
            })
            store[recipe.name] = current
        } catch (err) {
            results.push({
                name: recipe.name,
                changed: false,
                error: String(err),
            })
        }
    }

    return { results, store }
}
