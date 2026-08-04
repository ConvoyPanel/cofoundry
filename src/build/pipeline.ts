import PQueue from 'p-queue'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import {
    syncRepoToRemote,
    prefetchPhase,
    buildPhase,
    syncPhase,
} from '@/build.ts'
import { redactSensitive } from '@/util.ts'
import { BuildScheduler, type BuildResources } from '@/build/scheduler.ts'
import {
    formatTransferStatus,
    parseWgetLine,
    formatWgetStatus,
    createRenderer,
    type Renderer,
    type TaskHandle,
} from '@cofoundry/ui'
import { acquireRemoteMaintenanceLock } from '@/build/maintenance.ts'
import { assertShrinkStorageSupported } from '@/build/storage.ts'

export type PipelineOptions = {
    syncBack: boolean
    skipUpload?: boolean
    skipRepoSync?: boolean
    keepVm?: boolean
    downloadConcurrency?: number
    prefetchConcurrency?: number
    buildConcurrency?: number
    buildMemoryBudgetMb?: number
    buildCpuBudget?: number
    ci?: boolean
    verbose?: boolean
    outputLines?: number
}

export type PipelineResult = {
    passed: string[]
    failed: { name: string; error: string }[]
}

// Packer prefixes every streamed line with `<builder>.<source>: ` (e.g.
// `==> proxmox-iso.windows-server-2019: …`). Our stream renderer already tags
// each line with `[<recipe>]`, so that builder prefix just repeats the recipe
// name on every line. Strip it — keeping any leading `==> ` step marker — so a
// line reads `[windows-server-2019] ==> downloading …` instead of doubling the
// name. Only strips when the source segment matches this recipe, leaving any
// other `word.word:`-shaped text in genuine build output untouched.
//
// This affects the rendered stream only. Packer's unmodified output — builder
// prefix and all — is what lands in the node-side console log and the
// diagnostics bundle, so reading a log directly still shows the original lines.
//
// Packer colors its output even when writing to a file, so the prefix does not
// start the line — a real one is `\x1b[1;32m==> proxmox-iso.rocky-linux-10: …`
// with the SGR escape ahead of the step marker. Everything below therefore
// matches (and re-emits) leading escapes rather than anchoring on `==>`.
const SGR = String.raw`(?:\u001b\[[0-9;]*m)*`

export const stripPackerBuildPrefix = (
    line: string,
    recipeName: string
): string => {
    const escaped = recipeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return (
        line
            .replace(
                new RegExp(
                    `^(${SGR})\\s*(==> )?\\s*(${SGR})\\s*[a-z0-9-]+\\.${escaped}:\\s*`
                ),
                (
                    _all,
                    lead: string,
                    arrow: string | undefined,
                    inner: string
                ) => `${lead}${inner}${arrow ?? ''}`
            )
            // Our provisioner scripts echo their own `==> ` step marker, which
            // sits directly behind Packer's once the builder prefix between them
            // is gone (`==> ==> Updating packages`). Collapse the run to one.
            .replace(new RegExp(`^(${SGR})(?:==> ){2,}`), '$1==> ')
    )
}

export type PipelineDependencies = {
    syncRepo: typeof syncRepoToRemote
    prefetch: typeof prefetchPhase
    build: typeof buildPhase
    sync: typeof syncPhase
    acquireMaintenance: typeof acquireRemoteMaintenanceLock
    shrinkPreflight: typeof assertShrinkStorageSupported
}

const DEFAULT_DEPENDENCIES: PipelineDependencies = {
    syncRepo: syncRepoToRemote,
    prefetch: prefetchPhase,
    build: buildPhase,
    sync: syncPhase,
    acquireMaintenance: acquireRemoteMaintenanceLock,
    shrinkPreflight: assertShrinkStorageSupported,
}

// Submit work to a p-queue and keep `handle`'s phase label accurate while it
// waits. `phase` is the active label (e.g. "build"); while queued, we render
// "phase · queued (N ahead)" and re-render on each queue advance so the count
// ticks down. The inner task body sets the plain phase label when it actually
// starts running.
const runQueued = async <T>(
    q: PQueue,
    phase: string,
    handle: TaskHandle,
    work: () => Promise<T>
): Promise<T> => {
    let started = false
    // Snapshot position at enqueue: jobs currently running + already queued
    // ahead of us. Decrement on each 'next' (one job ahead just finished).
    let ahead = q.pending + q.size
    const render = (): void => {
        if (started) return
        handle.setPhase(
            ahead > 0 ? `${phase} · queued (${ahead} ahead)` : phase
        )
    }
    const onNext = (): void => {
        if (started) return
        ahead = Math.max(0, ahead - 1)
        render()
    }
    q.on('next', onNext)
    const promise = q.add(async () => {
        started = true
        handle.setPhase(phase)
        return await work()
    })
    render()
    try {
        // p-queue's add returns T | void to accommodate timeouts; we don't
        // configure any, so the value is always T.
        return (await promise) as T
    } finally {
        q.off('next', onNext)
    }
}

export const runPipeline = async (
    env: Env,
    recipes: RecipeInfo[],
    opts: PipelineOptions,
    dependencies: PipelineDependencies = DEFAULT_DEPENDENCIES
): Promise<PipelineResult> => {
    validateBuildOptions(recipes, opts)
    const maintenance = await dependencies.acquireMaintenance(
        env.SSH_TARGET,
        'shared'
    )
    try {
        return await Promise.race([
            runPipelineLocked(env, recipes, opts, dependencies),
            maintenance.lost,
        ])
    } finally {
        await maintenance.release()
    }
}

const runPipelineLocked = async (
    env: Env,
    recipes: RecipeInfo[],
    opts: PipelineOptions,
    dependencies: PipelineDependencies
): Promise<PipelineResult> => {
    const buildOptions = validateBuildOptions(recipes, opts)
    // Fail before any phase starts: a final_disk_size shrink on non-file
    // storage would otherwise only surface in the vzdump post-processor,
    // hours into the build.
    await dependencies.shrinkPreflight(env, recipes)
    const prefetchQ = new PQueue({ concurrency: opts.prefetchConcurrency ?? 3 })
    const buildQ = new BuildScheduler(buildOptions)
    const syncQ = new PQueue({ concurrency: 1 })

    const passed: string[] = []
    const failed: { name: string; error: string }[] = []

    const renderer = createRenderer({
        ci: opts.ci,
        verbose: opts.verbose,
        outputLines: opts.outputLines,
    })

    try {
        const snapshotDir = opts.skipRepoSync
            ? undefined
            : await runRepoSync(env, opts, renderer, dependencies)

        await Promise.allSettled(
            recipes.map(recipe =>
                runRecipe(
                    env,
                    recipe,
                    opts,
                    snapshotDir,
                    renderer,
                    {
                        prefetchQ,
                        buildQ,
                        syncQ,
                        passed,
                        failed,
                    },
                    dependencies
                )
            )
        )
    } finally {
        renderer.finish()
    }

    return { passed, failed }
}

const validateBuildOptions = (
    recipes: RecipeInfo[],
    opts: PipelineOptions
): {
    concurrency: number
    memoryBudgetMb?: number
    cpuBudget?: number
} => {
    const concurrency = opts.buildConcurrency ?? 1
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error('build concurrency must be a positive integer')
    }
    for (const [label, value] of [
        ['build memory budget', opts.buildMemoryBudgetMb],
        ['build CPU budget', opts.buildCpuBudget],
    ] as const) {
        if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
            throw new Error(`${label} must be a positive integer`)
        }
    }
    if (
        concurrency > 1 &&
        (opts.buildMemoryBudgetMb === undefined ||
            opts.buildCpuBudget === undefined)
    ) {
        throw new Error(
            'parallel builds require both a memory budget and a CPU budget'
        )
    }
    if (concurrency > 1) {
        const seen = new Set<string>()
        for (const recipe of recipes) {
            if (seen.has(recipe.name)) {
                throw new Error(
                    `parallel builds cannot include ${recipe.name} more than once`
                )
            }
            seen.add(recipe.name)
        }
    }

    const resourcesRequired =
        concurrency > 1 ||
        opts.buildMemoryBudgetMb !== undefined ||
        opts.buildCpuBudget !== undefined
    if (resourcesRequired) {
        for (const recipe of recipes) {
            if (
                recipe.buildMemoryMb === undefined ||
                recipe.buildCores === undefined
            ) {
                throw new Error(
                    `${recipe.name} must declare static memory and cores in its Packer source`
                )
            }
            if (
                opts.buildMemoryBudgetMb !== undefined &&
                recipe.buildMemoryMb > opts.buildMemoryBudgetMb
            ) {
                throw new Error(
                    `${recipe.name} requires ${recipe.buildMemoryMb} MiB, exceeding the ${opts.buildMemoryBudgetMb} MiB build memory budget`
                )
            }
            if (
                opts.buildCpuBudget !== undefined &&
                recipe.buildCores > opts.buildCpuBudget
            ) {
                throw new Error(
                    `${recipe.name} requires ${recipe.buildCores} cores, exceeding the ${opts.buildCpuBudget}-core build CPU budget`
                )
            }
        }
    }

    return {
        concurrency,
        memoryBudgetMb: opts.buildMemoryBudgetMb,
        cpuBudget: opts.buildCpuBudget,
    }
}

const runRepoSync = async (
    env: Env,
    opts: PipelineOptions,
    renderer: Renderer,
    dependencies: PipelineDependencies
): Promise<string> => {
    const handle = renderer.task('sync repo to remote')
    try {
        const snapshotDir = await dependencies.syncRepo(env, {
            onPhase: phase => handle.setPhase(phase),
            onProgress: ev => {
                handle.setProgress(
                    formatTransferStatus(
                        ev.direction,
                        ev.doneBytes,
                        ev.totalBytes,
                        ev.doneFiles,
                        ev.totalFiles,
                        ev.currentFile,
                        ev.startMs
                    )
                )
            },
        })
        handle.succeed()
        return snapshotDir
    } catch (err) {
        const msg = redactSensitive(
            err instanceof Error ? err.message : String(err)
        )
        handle.fail(msg)
        throw err
    }
}

type RecipeContext = {
    prefetchQ: PQueue
    buildQ: BuildScheduler
    syncQ: PQueue
    passed: string[]
    failed: { name: string; error: string }[]
}

const runBuildQueued = async <T>(
    queue: BuildScheduler,
    resources: BuildResources,
    handle: TaskHandle,
    work: () => Promise<T>
): Promise<T> => {
    handle.setPhase('build · queued')
    return await queue.add(resources, work, () => handle.setPhase('build'))
}

const recordFailure = (
    ctx: RecipeContext,
    recipe: RecipeInfo,
    err: unknown,
    handle: TaskHandle
): Error => {
    const msg = redactSensitive(
        err instanceof Error ? err.message : String(err)
    )
    if (!ctx.failed.some(f => f.name === recipe.name)) {
        ctx.failed.push({ name: recipe.name, error: msg })
    }
    handle.fail(msg)
    return err instanceof Error ? err : new Error(msg)
}

const runRecipe = async (
    env: Env,
    recipe: RecipeInfo,
    opts: PipelineOptions,
    snapshotDir: string | undefined,
    renderer: Renderer,
    ctx: RecipeContext,
    dependencies: PipelineDependencies
): Promise<void> => {
    const handle = renderer.task(recipe.name)

    // ── prefetch ──
    try {
        await runQueued(ctx.prefetchQ, 'prefetch', handle, async () => {
            await dependencies.prefetch(env, recipe, (slot, line) => {
                const p = parseWgetLine(line)
                if (p) handle.setProgress(formatWgetStatus(slot, p))
            })
        })
    } catch (err) {
        throw recordFailure(ctx, recipe, err, handle)
    }

    // ── build ──
    let buildStartedAt: number | undefined
    // Packer's `A template was created: <id>` banner is the meaningful result
    // line, but later benign teardown chatter (e.g. a `-force` cleanup printing
    // "Configuration file '…/<vmid>.conf' does not exist") can be the actual
    // last stream line and evict the banner from the renderer's 1-slot log ring.
    // Stash the banner and re-log it after a successful build so the summary
    // row always shows the created template rather than trailing noise.
    let templateSummary: string | undefined
    try {
        await runBuildQueued(
            ctx.buildQ,
            {
                memoryMb: recipe.buildMemoryMb ?? 0,
                cores: recipe.buildCores ?? 0,
            },
            handle,
            async () => {
                const result = await dependencies.build(
                    env,
                    recipe,
                    {
                        keepVm: opts.keepVm,
                        skipUpload: opts.skipUpload,
                        ciMode: opts.ci,
                        snapshotDir,
                    },
                    line => {
                        const trimmed = stripPackerBuildPrefix(
                            line.trim(),
                            recipe.name
                        )
                        if (!trimmed) return
                        if (trimmed.includes('A template was created:')) {
                            templateSummary = trimmed
                        }
                        handle.log(
                            opts.verbose ? trimmed : trimmed.slice(0, 200)
                        )
                    }
                )
                buildStartedAt = result.startedAt
            }
        )
    } catch (err) {
        throw recordFailure(ctx, recipe, err, handle)
    }

    if (templateSummary) {
        handle.log(
            opts.verbose ? templateSummary : templateSummary.slice(0, 200)
        )
    }

    if (!opts.syncBack) {
        ctx.passed.push(recipe.name)
        handle.succeed()
        return
    }

    // ── sync ──
    try {
        await runQueued(ctx.syncQ, 'sync', handle, async () => {
            await dependencies.sync(env, recipe, {
                concurrency: opts.downloadConcurrency,
                since: buildStartedAt,
                onProgress: ev => {
                    handle.setProgress(
                        formatTransferStatus(
                            ev.direction,
                            ev.doneBytes,
                            ev.totalBytes,
                            ev.doneFiles,
                            ev.totalFiles,
                            ev.currentFile,
                            ev.startMs
                        )
                    )
                },
            })
        })
        ctx.passed.push(recipe.name)
        handle.succeed()
    } catch (err) {
        throw recordFailure(ctx, recipe, err, handle)
    }
}
