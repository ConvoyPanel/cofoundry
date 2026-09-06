import {
    createRenderer,
    log,
    title,
    dim,
    accent,
    type Renderer,
    type TaskHandle,
} from '@cofoundry/ui'
import {
    downloadWithRetry,
    verifySha256,
    ensureTempDir,
    tempPath,
    cleanupTempDir,
    removeTempFile,
    sweepStaleTempDirs,
} from './download.ts'
import { installTemplate } from './install.ts'
import { writeCache, recordFor, type Cache } from './cache.ts'
import { Semaphore } from './semaphore.ts'
import {
    Phase,
    formatPhase,
    formatDownload,
    formatInstallProgress,
    renderBar,
    QUEUED_DOWNLOAD,
    QUEUED_INSTALL,
    PROGRESS_THROTTLE_MS,
} from './progress.ts'
import { templateSize } from '@/registry/schema.ts'
import { DEFAULT_BRIDGE } from '@/registry/create.ts'
import type { InstallItem } from './types.ts'

const install = async (
    item: InstallItem,
    verify: boolean,
    bridge: string,
    task: TaskHandle,
    signal: AbortSignal,
    downloadSem: Semaphore,
    installSem: Semaphore
): Promise<void> => {
    const { template, vmid, storage, overwrite } = item
    // A template is several images now (a system disk and, on OVMF recipes, an
    // EFI varstore), all of which must land before the VM can be created.
    const artifacts = template.disks.map(disk => ({
        disk,
        dest: tempPath(disk.file),
    }))
    const files = new Map(artifacts.map(({ disk, dest }) => [disk.slot, dest]))

    try {
        task.setPhase(QUEUED_DOWNLOAD)
        await downloadSem.run(async () => {
            const startedAt = Date.now()
            task.setPhase(formatPhase(Phase.Download, vmid))
            task.setProgress(formatDownload(0, 0, startedAt))
            const total = templateSize(template)
            let done = 0
            let lastUpdate = 0
            // Sequential, so the progress row reflects one transfer at a time
            // while still reporting against the template's total size.
            for (const { dest, disk } of artifacts) {
                await downloadWithRetry(
                    disk.url,
                    dest,
                    p => {
                        const now = Date.now()
                        if (
                            now - lastUpdate < PROGRESS_THROTTLE_MS &&
                            p.pct < 100
                        )
                            return
                        lastUpdate = now
                        task.setProgress(
                            formatDownload(done + p.received, total, startedAt)
                        )
                    },
                    signal
                )
                done += disk.size
            }
        })

        task.setPhase(QUEUED_INSTALL)
        await installSem.run(async () => {
            if (verify) {
                task.setPhase(formatPhase(Phase.Verify, vmid))
                task.setProgress(`${renderBar(0)} SHA-256`)
                for (const { dest, disk } of artifacts)
                    await verifySha256(dest, disk.sha256)
            }

            task.setPhase(formatPhase(Phase.Install, vmid))
            task.setProgress(formatInstallProgress(0))
            let lastUpdate = 0
            await installTemplate(
                template,
                {
                    vmid,
                    storage,
                    bridge,
                    files,
                    overwrite,
                    // Visible rather than silent: on a node older than the
                    // builder the VM comes up without these, and that is worth
                    // knowing when its behaviour differs from the published one.
                    onUnsupported: line => task.log(line),
                },
                pct => {
                    const now = Date.now()
                    if (now - lastUpdate < PROGRESS_THROTTLE_MS && pct < 100)
                        return
                    lastUpdate = now
                    task.setProgress(formatInstallProgress(pct))
                },
                signal
            )
        })
    } finally {
        // Reclaim space even when a download or import fails partway: these are
        // multi-gigabyte files and the run may still have templates to go.
        for (const { dest } of artifacts) await removeTempFile(dest)
    }

    task.succeed(`installed as ${accent(`VMID ${vmid}`)}`)
}

export interface RunOpts {
    noVerify?: boolean
    verbose?: boolean
    downloadConcurrency: string
    restoreConcurrency: string
    /** Bridge for the template's NIC; the profile records only the model. */
    bridge?: string
}

export const runInstalls = async (
    items: InstallItem[],
    opts: RunOpts,
    cache: Cache,
    abort: AbortController,
    onRenderer: (r: Renderer) => void
): Promise<void> => {
    await sweepStaleTempDirs()
    await ensureTempDir()

    const downloadLimit = Math.max(1, Number(opts.downloadConcurrency))
    const installLimit = Math.max(1, Number(opts.restoreConcurrency))
    if (!Number.isFinite(downloadLimit) || !Number.isFinite(installLimit)) {
        throw new Error(
            'Invalid concurrency values; must be positive integers.'
        )
    }
    const downloadSem = new Semaphore(downloadLimit)
    const installSem = new Semaphore(installLimit)
    const bridge = opts.bridge ?? DEFAULT_BRIDGE

    const nameWidth = Math.max(...items.map(i => i.template.name.length))
    const storages = [...new Set(items.map(i => i.storage))]
    const storageLabel =
        storages.length === 1
            ? accent(storages[0]!)
            : `${storages.length} volumes`
    const renderer = createRenderer({
        title: title(
            `Installing ${items.length} template${items.length === 1 ? '' : 's'} → ${storageLabel} ${dim(`(downloads × ${downloadLimit}, imports × ${installLimit})`)}`
        ),
        verbose: opts.verbose,
        outputLines: 1,
        queuedPattern: /\bqueued\b/,
    })
    onRenderer(renderer)

    // Installs finish in parallel but the cache file is one document: chain the
    // writes so a later flush can't interleave with an earlier one.
    let flushing: Promise<void> = Promise.resolve()
    const flushCache = (): Promise<void> => {
        flushing = flushing.then(() => writeCache(cache)).catch(() => {})
        return flushing
    }

    const results = await Promise.allSettled(
        items.map(async item => {
            const task = renderer.task(item.template.name.padEnd(nameWidth))
            try {
                await install(
                    item,
                    !opts.noVerify,
                    bridge,
                    task,
                    abort.signal,
                    downloadSem,
                    installSem
                )
                // Record success so `--upgrade`/`--list` know what's installed
                // and where. Flushed per install, not once at the end: a run
                // that installs 16 templates takes long enough to be
                // interrupted, and the templates it already created are real
                // whether or not the rest finish.
                cache.set(
                    item.template.name,
                    recordFor(item.template, item.vmid, item.storage)
                )
                await flushCache()
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                task.fail(msg)
                throw err
            }
        })
    )

    renderer.finish()
    await cleanupTempDir()
    await flushCache()

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
