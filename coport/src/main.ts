import { Command } from 'commander'
import {
    createRenderer,
    log,
    title,
    dim,
    accent,
    fmtBytes,
    fmtRate,
    fmtPercent,
    type Renderer,
    type TaskHandle,
} from '@cofoundry/ui'
import pkg from '../package.json' with { type: 'json' }
import { resolveConfig, describeSource } from './config.ts'
import { fetchRegistry } from './registry.ts'
import { resolveVmids, type VmidAssignment } from './vmid.ts'
import { collectGroups, flatten, selectBySpec } from './select.ts'
import {
    readCache,
    writeCache,
    isStale,
    recordFor,
    type Cache,
} from './cache.ts'
import {
    downloadWithRetry,
    verifySha256,
    ensureTempDir,
    tempPath,
    cleanupTempDir,
    cleanupTempDirSync,
    removeTempFile,
    sweepStaleTempDirs,
} from './download.ts'
import { qmrestore } from './install.ts'
import type { Registry, Template } from '../../src/registry/schema.ts'

type Phase = 'download' | 'verify' | 'install'

const PHASE_VERBS: Record<Phase, string> = {
    download: 'downloading',
    verify: 'verifying  ',
    install: 'installing ',
}

const formatPhase = (phase: Phase, vmid: number): string =>
    `${PHASE_VERBS[phase]} ${dim(`→ VMID ${String(vmid).padEnd(4)}`)}`

const QUEUED_DOWNLOAD = `${dim('queued')}     ${dim('→ download')}`
const QUEUED_RESTORE = `${dim('queued')}     ${dim('→ restore ')}`

const BAR_WIDTH = 14

const renderBar = (pct: number): string => {
    const clamped = Math.max(0, Math.min(100, pct))
    const filled = Math.round((clamped / 100) * BAR_WIDTH)
    return `${'█'.repeat(filled)}${dim('░'.repeat(BAR_WIDTH - filled))}`
}

const formatDownload = (
    received: number,
    total: number,
    startedAt: number
): string => {
    const elapsed = Math.max(1, Date.now() - startedAt)
    const pct = total > 0 ? (received / total) * 100 : 0
    const size =
        total > 0
            ? `${fmtBytes(received)}/${fmtBytes(total)}`
            : fmtBytes(received)
    return `${renderBar(pct)} ${fmtPercent(pct)}  ${size.padEnd(22)} ${fmtRate(received, elapsed).padStart(10)}`
}

const formatRestoreProgress = (pct: number): string =>
    `${renderBar(pct)} ${fmtPercent(pct)}`

const PROGRESS_THROTTLE_MS = 120

class Semaphore {
    private readonly waiters: Array<() => void> = []
    constructor(private available: number) {}
    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.available > 0) {
            this.available--
        } else {
            await new Promise<void>(r => this.waiters.push(r))
        }
        try {
            return await fn()
        } finally {
            const next = this.waiters.shift()
            if (next) next()
            else this.available++
        }
    }
}

// One thing to install: a template restored into a VMID on a storage volume.
interface InstallItem {
    template: Template
    vmid: number
    storage: string
    overwrite: boolean
}

const installTemplate = async (
    item: InstallItem,
    verify: boolean,
    task: TaskHandle,
    signal: AbortSignal,
    downloadSem: Semaphore,
    restoreSem: Semaphore
): Promise<void> => {
    const { template, vmid, storage, overwrite } = item
    const dest = tempPath(vmid)

    task.setPhase(QUEUED_DOWNLOAD)
    await downloadSem.run(async () => {
        const downloadStartedAt = Date.now()
        task.setPhase(formatPhase('download', vmid))
        task.setProgress(formatDownload(0, 0, downloadStartedAt))
        let lastUpdate = 0
        await downloadWithRetry(
            template.url,
            dest,
            p => {
                const now = Date.now()
                if (now - lastUpdate < PROGRESS_THROTTLE_MS && p.pct < 100)
                    return
                lastUpdate = now
                task.setProgress(
                    formatDownload(p.received, p.total, downloadStartedAt)
                )
            },
            signal
        )
    })

    task.setPhase(QUEUED_RESTORE)
    await restoreSem.run(async () => {
        if (verify) {
            task.setPhase(formatPhase('verify', vmid))
            task.setProgress(`${renderBar(0)} SHA-256`)
            await verifySha256(dest, template.sha256)
        }

        task.setPhase(formatPhase('install', vmid))
        task.setProgress(formatRestoreProgress(0))
        let lastUpdate = 0
        await qmrestore(
            dest,
            vmid,
            storage,
            overwrite,
            pct => {
                const now = Date.now()
                if (now - lastUpdate < PROGRESS_THROTTLE_MS && pct < 100) return
                lastUpdate = now
                task.setProgress(formatRestoreProgress(pct))
            },
            signal
        )
    })

    await removeTempFile(dest)
    task.succeed(`installed as ${accent(`VMID ${vmid}`)}`)
}

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

// A piped registry occupies stdin, leaving no keyboard for the interactive menu.
// Rather than hang, point the user at the two no-file modes that do work.
const PIPED_INTERACTIVE_HELP =
    'Reading the registry from stdin leaves no terminal for the interactive menu.\n' +
    '  • Keep it interactive — pass the registry as an argument:\n' +
    '        coport "$(curl -s https://…/registry.json)"\n' +
    '  • Or stay piped and skip the menu with --all or --select:\n' +
    '        curl -s https://…/registry.json | coport --all --storage <name>'

const program = new Command()

program
    .name('coport')
    .description('Install Cofoundry VM templates into Proxmox')
    .version(pkg.version)
    .argument(
        '[registry]',
        'Registry URL, file path, inline JSON, "-" for stdin, or omit for default/config'
    )
    .option('-s, --storage <name>', 'Proxmox storage volume (skips prompt)')
    .option('-g, --group <id>', 'Only show/install templates from this group')
    .option('-f, --filter <tag>', 'Only show/install templates with this tag')
    .option(
        '-a, --all',
        'Install every template with suggested/cached VMIDs (no prompts)'
    )
    .option(
        '--select <spec>',
        'Non-interactive selection: "all", index ranges (1,3-5), or template names'
    )
    .option(
        '--refresh',
        'Re-pull installed templates whose registry version changed (reuses their VMIDs)'
    )
    .option(
        '-l, --list',
        'List installed templates (name, VMID, storage, version) and exit'
    )
    .option('--vmid-start <n>', 'Auto-VMID range start for conflicts', '9000')
    .option('--dry-run', 'Show what would be installed; skip downloads')
    .option(
        '--overwrite',
        'Overwrite existing VMs when a suggested VMID is already taken'
    )
    .option('--no-verify', 'Skip SHA-256 verification after download')
    .option(
        '--download-concurrency <n>',
        'Parallel downloads (env: COPORT_DOWNLOAD_CONCURRENCY)',
        process.env.COPORT_DOWNLOAD_CONCURRENCY ?? '4'
    )
    .option(
        '--restore-concurrency <n>',
        'Parallel verifies + qmrestores (env: COPORT_RESTORE_CONCURRENCY)',
        process.env.COPORT_RESTORE_CONCURRENCY ?? '2'
    )
    .option('--verbose', 'Stream per-event logs instead of in-place TUI')
    .action(async (registryArg: string | undefined, opts) => {
        const abort = new AbortController()
        let interrupted = false
        let activeRenderer: Renderer | undefined
        process.once('SIGINT', () => {
            interrupted = true
            abort.abort()
            activeRenderer?.finish()
            log.warn('Interrupted; stopping active downloads/restores...')
            cleanupTempDirSync()
            process.exit(130)
        })

        // `-l/--list`: print installed templates and exit; no registry needed.
        if (opts.list) {
            printInstalled(await readCache())
            return
        }

        const { source, defaultStorage } = await resolveConfig(registryArg)
        const nonInteractive = Boolean(
            opts.all || opts.refresh || opts.select != null
        )

        // A piped registry can't coexist with the interactive menu (both want
        // stdin). Fail fast with guidance instead of hanging on a dead keyboard.
        if (source.kind === 'stdin' && !nonInteractive) {
            log.err(PIPED_INTERACTIVE_HELP)
            process.exit(2)
        }

        log.info(`Registry: ${dim(describeSource(source))}`)
        const registry = await fetchRegistry(source)
        const count = registry.groups.reduce(
            (n, g) => n + g.templates.length,
            0
        )
        log.ok(
            `Loaded ${accent(`"${registry.name}"`)} ${dim(`(${count} templates)`)}`
        )

        const cache = await readCache()

        // Build the list of things to install for whichever mode we're in.
        let items: InstallItem[]
        if (opts.refresh) {
            items = staleItems(registry, cache, opts.group, opts.filter)
            if (items.length === 0) {
                log.ok('Everything up to date — nothing to refresh.')
                return
            }
        } else {
            items = await planInstall(
                registry,
                cache,
                opts,
                defaultStorage,
                nonInteractive
            )
            if (items.length === 0) {
                log.warn('No templates selected.')
                process.exit(0)
            }
        }

        if (opts.dryRun) {
            log.section('Dry run — would install')
            for (const item of items) {
                log.raw(
                    `  ${item.template.display.padEnd(28)} ${dim('→')} VMID ${accent(String(item.vmid))} ${dim(`(${item.storage})`)}`
                )
            }
            log.blank()
            process.exit(0)
        }

        await runInstalls(items, opts, cache, abort, r => {
            activeRenderer = r
        })

        if (interrupted) {
            log.warn(
                'Interrupted. Temporary archives were removed; inspect Proxmox for any partial restores before retrying.'
            )
            process.exit(130)
        }
    })

interface PlanOpts {
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
const planInstall = async (
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

// `--refresh` flow: reinstall only the cached templates whose registry version
// changed, into their cached VMID/storage, overwriting in place.
const staleItems = (
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

interface RunOpts {
    noVerify?: boolean
    verbose?: boolean
    downloadConcurrency: string
    restoreConcurrency: string
}

const runInstalls = async (
    items: InstallItem[],
    opts: RunOpts,
    cache: Cache,
    abort: AbortController,
    onRenderer: (r: Renderer) => void
): Promise<void> => {
    await sweepStaleTempDirs()
    await ensureTempDir()

    const downloadLimit = Math.max(1, Number(opts.downloadConcurrency))
    const restoreLimit = Math.max(1, Number(opts.restoreConcurrency))
    if (!Number.isFinite(downloadLimit) || !Number.isFinite(restoreLimit)) {
        throw new Error(
            'Invalid concurrency values; must be positive integers.'
        )
    }
    const downloadSem = new Semaphore(downloadLimit)
    const restoreSem = new Semaphore(restoreLimit)

    const nameWidth = Math.max(...items.map(i => i.template.name.length))
    const storages = [...new Set(items.map(i => i.storage))]
    const storageLabel =
        storages.length === 1
            ? accent(storages[0]!)
            : `${storages.length} volumes`
    const renderer = createRenderer({
        title: title(
            `Installing ${items.length} template${items.length === 1 ? '' : 's'} → ${storageLabel} ${dim(`(downloads × ${downloadLimit}, restores × ${restoreLimit})`)}`
        ),
        verbose: opts.verbose,
        outputLines: 1,
        queuedPattern: /\bqueued\b/,
    })
    onRenderer(renderer)

    const results = await Promise.allSettled(
        items.map(async item => {
            const task = renderer.task(item.template.name.padEnd(nameWidth))
            try {
                await installTemplate(
                    item,
                    !opts.noVerify,
                    task,
                    abort.signal,
                    downloadSem,
                    restoreSem
                )
                // Record success so `-u`/`-v` know what's installed and where.
                cache.set(
                    item.template.name,
                    recordFor(item.template, item.vmid, item.storage)
                )
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                task.fail(msg)
                throw err
            }
        })
    )

    renderer.finish()
    await cleanupTempDir()
    await writeCache(cache).catch(() => {})

    const passed = results.filter(r => r.status === 'fulfilled').length
    const failed = results.length - passed
    log.blank()
    if (failed === 0) {
        log.ok(`Installed ${passed}/${results.length} templates.`)
    } else {
        log.err(`${failed} failed, ${passed} succeeded.`)
        process.exit(1)
    }
}

const printInstalled = (cache: Cache): void => {
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

program.parseAsync(process.argv).catch(err => {
    cleanupTempDirSync()
    log.err(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
