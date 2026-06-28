import { log, dim, accent } from '@cofoundry/ui'
import type { Registry, Template } from '@/registry/schema.ts'
import { resolveVmids } from './vmid.ts'
import { collectGroups, flatten, selectBySpec } from './select.ts'
import { isStale, type Cache } from './cache.ts'
import type { InstallItem } from './types.ts'

// Lazily load the clack-based prompt module (skips loading clack for fully
// non-interactive runs). By this point stdin is the session terminal.
type Prompts = typeof import('./prompt.ts')
let promptsModule: Prompts | undefined
const loadPrompts = async (): Promise<Prompts> => {
    if (promptsModule) return promptsModule
    if (!process.stdin.isTTY) {
        throw new Error(
            'No terminal available for interactive prompts. ' +
                'Re-run with --all or --select <names> plus --storage <name>.'
        )
    }
    promptsModule = await import('./prompt.ts')
    return promptsModule
}

export interface PlanOpts {
    all?: boolean
    select?: string
    group?: string
    filter?: string
    storage?: string
    vmidStart: string
    overwrite?: boolean
}

// Default flow: pick templates (interactive or via -a/--select), resolve + review
// VMIDs, and resolve the storage volume.
export const planInstall = async (
    registry: Registry,
    cache: Cache,
    opts: PlanOpts,
    defaultStorage: string | undefined,
    nonInteractive: boolean
): Promise<InstallItem[]> => {
    const selected: Template[] = opts.all
        ? flatten(collectGroups(registry, opts.group, opts.filter))
        : opts.select != null
          ? selectBySpec(opts.select, registry, opts.group, opts.filter)
          : await (
                await loadPrompts()
            ).promptTemplateSelection(registry, opts.group, opts.filter)

    if (selected.length === 0) return []

    const vmidStart = Number(opts.vmidStart)
    const preferred = new Map(
        [...cache.values()].map(r => [r.name, r.vmid] as const)
    )
    let assignments = await resolveVmids(
        selected,
        vmidStart,
        opts.overwrite,
        preferred
    )

    if (nonInteractive) {
        for (const a of assignments.filter(a => a.conflict)) {
            log.warn(
                `${a.template.display}: suggested VMID taken; using ${a.vmid}.`
            )
        }
    } else {
        const reviewed = await (
            await loadPrompts()
        ).reviewAssignments(assignments)
        if (reviewed === null) {
            log.warn('Aborted.')
            process.exit(0)
        }
        assignments = reviewed
    }
    if (assignments.length === 0) return []

    const storage = await resolveStorage(opts, defaultStorage, nonInteractive)
    return assignments.map(a => ({
        template: a.template,
        vmid: a.vmid,
        storage,
        overwrite: a.overwrite,
    }))
}

const resolveStorage = async (
    opts: { storage?: string },
    defaultStorage: string | undefined,
    nonInteractive: boolean
): Promise<string> => {
    const storage = opts.storage ?? defaultStorage
    if (storage) return storage
    if (nonInteractive) {
        throw new Error(
            'Storage is required in non-interactive mode. Pass --storage <name>.'
        )
    }
    return (await loadPrompts()).promptStorage()
}

// `--upgrade` flow: reinstall only the cached templates whose registry version
// changed, into their cached VMID/storage, overwriting in place.
export const staleItems = (
    registry: Registry,
    cache: Cache,
    groupFilter?: string,
    tagFilter?: string
): InstallItem[] => {
    const available = new Map(
        flatten(collectGroups(registry, groupFilter, tagFilter)).map(t => [
            t.name,
            t,
        ])
    )
    const items: InstallItem[] = []
    for (const record of cache.values()) {
        const template = available.get(record.name)
        if (!template || !isStale(record, template)) continue
        items.push({
            template,
            vmid: record.vmid,
            storage: record.storage,
            overwrite: true,
        })
    }
    return items
}

// `--list`: print the install cache (name, VMID, storage, install date).
export const printInstalled = (cache: Cache): void => {
    const records = [...cache.values()].sort((a, b) =>
        a.name.localeCompare(b.name)
    )
    if (records.length === 0) {
        log.warn('No templates installed yet (cache is empty).')
        return
    }
    log.section('Installed templates')
    const nameWidth = Math.max(...records.map(r => r.display.length))
    for (const r of records) {
        const when = r.installed_at.slice(0, 10)
        log.raw(
            `  ${r.display.padEnd(nameWidth)} ${dim('→')} VMID ${accent(String(r.vmid))} ${dim(`(${r.storage}, ${when})`)}`
        )
    }
    log.blank()
}
