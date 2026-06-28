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
import { qmrestore } from './install.ts'
import { writeCache, recordFor, type Cache } from './cache.ts'
import { Semaphore } from './semaphore.ts'
import {
    Phase,
    formatPhase,
    formatDownload,
    formatRestoreProgress,
    renderBar,
    QUEUED_DOWNLOAD,
    QUEUED_RESTORE,
    PROGRESS_THROTTLE_MS,
} from './progress.ts'
import type { InstallItem } from './types.ts'

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
        task.setPhase(formatPhase(Phase.Download, vmid))
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
            task.setPhase(formatPhase(Phase.Verify, vmid))
            task.setProgress(`${renderBar(0)} SHA-256`)
            await verifySha256(dest, template.sha256)
        }

        task.setPhase(formatPhase(Phase.Install, vmid))
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

export interface RunOpts {
    noVerify?: boolean
    verbose?: boolean
    downloadConcurrency: string
    restoreConcurrency: string
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
                // Record success so `--upgrade`/`--list` know what's installed and where.
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
