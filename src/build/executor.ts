import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { shellQuote } from '@/util.ts'
import {
    captureRemote,
    registerCleanup,
    remoteStreaming,
    remoteStreamingScript,
} from '@/build/remote.ts'
import {
    assertPackerTmpDirSocketSafe,
    buildPackerVars,
    buildRemoteEnv,
    PACKER_TMP_ROOT,
    packerTmpDir,
    streamViaConsoleLog,
} from '@/build/packer.ts'
import {
    buildRemoteOutDir,
    buildRemoteTmpDir,
    buildRemoteWorkDir,
} from '@/build/paths.ts'
import { cloudbaseInitMsiCachePath } from '@/build/prefetch.ts'
import { allocateBuildSlot, type BuildSlot } from '@/build/netslot.ts'
import { buildVmWatchdog } from '@/build/watchdog.ts'
import { bridgeForRecipe, inspectRecipeLayout } from '@/build/recipe.ts'
import { buildAttemptCount, runWithRetries } from '@/build/retry.ts'
import { buildSlotVmid, destroyVmCommand } from '@/build/vm.ts'
import {
    buildDiagnosticsRecorder,
    collectDiagnostics,
    diagnosticsRemoteDir,
    guestLogSpecs,
    recorderLifetimeSec,
    sweepStaleDiagnosticsCommand,
} from '@/build/diagnostics.ts'
import { log } from '@/log.ts'
import {
    acquireRunLease,
    killLeasedRunProcessesCommand,
} from '@/build/lease.ts'

export type BuildPhaseOptions = {
    keepVm?: boolean
    skipUpload?: boolean
    ciMode?: boolean
    /** Immutable repository snapshot selected by this pipeline invocation. */
    snapshotDir?: string
}

export type BuildPhaseResult = {
    /** Remote epoch (seconds) captured before packer ran. Used by syncPhase
     *  to filter out stale artifacts left by prior runs. */
    startedAt: number
}

export const buildWritableRepoCommand = (
    snapshotWorkDir: string,
    buildWorkDir: string,
    cloudbaseCache?: string
): string => {
    const commands = [
        `cp -aL ${shellQuote(snapshotWorkDir)} ${shellQuote(buildWorkDir)}`,
        `chmod -R u+w ${shellQuote(buildWorkDir)}`,
    ]
    if (cloudbaseCache) {
        commands.push(
            `install -m 0644 ${shellQuote(cloudbaseCache)} ${shellQuote(`${buildWorkDir}/recipes/_shared/CloudbaseInitSetup_x64.msi`)}`
        )
    }
    return commands.join(' && ')
}

/** How long an aborted build may take to settle before cleanup proceeds
 *  anyway — generous enough for a killed SSH child to exit, bounded so a
 *  wedged connection cannot hang the process forever. */
export const ABORT_SETTLE_MS = 60_000

/** Resolve `true` once `work` settles, `false` if `ms` elapses first. */
const settledWithin = async (
    work: Promise<unknown>,
    ms: number
): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            work.then(
                () => true,
                () => true
            ),
            // No unref(): Bun does not reliably fire unref'd timers, and the
            // finally below always clears it once the work settles.
            new Promise<boolean>(resolve => {
                timer = setTimeout(() => resolve(false), ms)
            }),
        ])
    } finally {
        if (timer !== undefined) clearTimeout(timer)
    }
}

export type LeasedWork = {
    /** The leased work. Its `cancelSignal` aborts — with the explanatory
     *  lease-lost error as the reason — the moment the lease is lost. */
    run: (cancelSignal: AbortSignal) => Promise<void>
    /** Rejects once the run lease is confirmed reaped (see `RunLease.lost`). */
    lost: Promise<never>
    /** Explicitly terminate the run's remote processes. Killing the local ssh
     *  client is not enough — no PTY is allocated, so the remote packer would
     *  otherwise keep running until its own communicator timeout. Must never
     *  reject. */
    terminateRemote: () => Promise<void>
    /** Overrides ABORT_SETTLE_MS (tests). */
    settleMs?: number
    /** Called when aborted work fails to settle within the window. */
    onStalled?: () => void
}

/**
 * Race leased work against the lease's `lost` promise, cancelling the work
 * for real when the lease goes: fire the abort signal (which the SSH layer
 * turns into a killed child), terminate the remote processes the same way the
 * stale-lease sweep would, and only return — letting the caller's cleanup
 * `finally` run — once the work has settled or a bounded settle window
 * elapsed. Without a lost lease the work's outcome passes through untouched.
 */
export const raceLeasedWork = async (leased: LeasedWork): Promise<void> => {
    const abort = new AbortController()
    // The signal's reason is the explanatory lease-lost error, so aborted
    // layers (runWithRetries) rethrow it rather than a generic cancellation.
    void leased.lost.catch((err: Error) => abort.abort(err))
    const work = leased.run(abort.signal)
    // The race can abandon `work`; keep a handler attached so its late
    // rejection can never become an unhandled rejection.
    void work.catch(() => undefined)
    try {
        await Promise.race([work, leased.lost])
    } catch (err) {
        if (abort.signal.aborted) {
            // Lease lost: the sweep has already destroyed this run's VM and
            // temp directories. Kill the surviving remote processes exactly
            // like the sweep does, then wait for the work to settle so
            // cleanup never runs underneath a still-live build. Both waits
            // share one bounded window: against an unreachable node the
            // remote kill itself can hang.
            const remoteKill = leased.terminateRemote()
            const settled = await settledWithin(
                Promise.allSettled([work, remoteKill]),
                leased.settleMs ?? ABORT_SETTLE_MS
            )
            if (!settled) leased.onStalled?.()
        }
        throw err
    }
}

export const buildPhase = async (
    env: Env,
    recipe: RecipeInfo,
    options: BuildPhaseOptions = {},
    onLine?: (line: string) => void
): Promise<BuildPhaseResult> => {
    const remoteWorkDir = options.snapshotDir ?? buildRemoteWorkDir(env)
    const remoteOutDir = buildRemoteOutDir(env)
    const remoteTmpDir = buildRemoteTmpDir(env)
    const layout = await inspectRecipeLayout(recipe)
    const buildBridge = bridgeForRecipe(env, recipe, layout)
    const runId = randomUUID()
    const remoteBuildTmpDir = `${remoteTmpDir}/build-${recipe.name}-${runId}`
    // Keep Packer's Linux plugin socket out of the descriptive workspace path:
    // sockaddr_un allows only 107 pathname bytes, including every TMPDIR byte.
    const remotePackerTmpDir = packerTmpDir(runId)
    assertPackerTmpDirSocketSafe(remotePackerTmpDir)
    const remoteBuildWorkDir = `${remoteBuildTmpDir}/repo`
    const lease = await acquireRunLease(
        env,
        'build',
        recipe,
        remoteBuildTmpDir,
        {
            preserveVm: Boolean(options.keepVm),
            packerTmpDir: remotePackerTmpDir,
            onWait: message => onLine?.(`[queue] ${message}`),
        }
    )
    let slot: BuildSlot | null = null
    let unregisterSecretCleanup: (() => void) | undefined
    let secretCleanupCmd = `rm -rf ${shellQuote(remoteBuildTmpDir)} ${shellQuote(remotePackerTmpDir)}`
    let startedAt = 0
    let effectiveBuildVmid: number | undefined

    const runLeased = async (cancelSignal: AbortSignal): Promise<void> => {
        if (layout.needsBuildNetwork) {
            slot = await allocateBuildSlot(env)
            log.info(
                `build network · ${env.CF_BUILD_BRIDGE} · ${slot.ip} via ${slot.gw} · slot ${slot.slotIndex}`
            )
        }
        effectiveBuildVmid = recipe.buildVmid
            ? buildSlotVmid(recipe.buildVmid, slot)
            : undefined
        if (effectiveBuildVmid !== undefined)
            await lease.setVmid(effectiveBuildVmid)

        // The injector keeps answer-file ISOs and ephemeral credentials in the
        // dump-backed workspace; Packer keeps its socket and transient scripts
        // in the separate short directory. Both are private and run-scoped.
        // Diagnostics are keyed by the unique VMID.
        const diagEnabled =
            env.CF_DIAGNOSTICS && effectiveBuildVmid !== undefined
        const diagRemoteDir = diagEnabled
            ? diagnosticsRemoteDir(effectiveBuildVmid as number)
            : undefined
        secretCleanupCmd = `rm -rf ${[
            remoteBuildTmpDir,
            remotePackerTmpDir,
            diagRemoteDir,
        ]
            .filter((p): p is string => p !== undefined)
            .map(shellQuote)
            .join(' ')}`

        // The run lease serializes duplicate recipes, so these stable result
        // names cannot be removed or replaced by another live build.
        const stalePrefix = `${remoteOutDir}/${recipe.name}-${recipe.arch}`
        const startedAtRaw = await captureRemote(
            env.SSH_TARGET,
            `${sweepStaleDiagnosticsCommand()}; ` +
                `rm -f ${['.qcow2', '.efivars.raw', '.json', '.json.tmp']
                    .map(ext => shellQuote(stalePrefix + ext))
                    .join(' ')} && date +%s`
        )
        startedAt = Number.parseInt(startedAtRaw.trim(), 10)
        if (!Number.isFinite(startedAt)) {
            throw new Error(`could not parse remote epoch: ${startedAtRaw}`)
        }

        await captureRemote(
            env.SSH_TARGET,
            `rm -rf ${shellQuote(remoteBuildTmpDir)} ${shellQuote(remotePackerTmpDir)} && ` +
                `install -d -m 700 ${shellQuote(PACKER_TMP_ROOT)} ${shellQuote(remoteBuildTmpDir)} ${shellQuote(remotePackerTmpDir)} && ${buildWritableRepoCommand(
                    remoteWorkDir,
                    remoteBuildWorkDir,
                    layout.isWindows
                        ? cloudbaseInitMsiCachePath(env)
                        : undefined
                )}`
        )
        unregisterSecretCleanup = registerCleanup(() => {
            spawnSync('ssh', [env.SSH_TARGET, secretCleanupCmd], {
                stdio: 'ignore',
            })
        })
        const injectEnv = [
            `RUNNER_TEMP=${shellQuote(remoteBuildTmpDir)}`,
            `CF_BUILD_IP=${shellQuote(slot?.ip ?? '')}`,
            `CF_BUILD_GW=${shellQuote(slot?.gw ?? '')}`,
            `CF_BUILD_DNS=${shellQuote(env.CF_BUILD_DNS)}`,
        ].join(' ')
        const varsFile = (
            await captureRemote(
                env.SSH_TARGET,
                `cd ${remoteBuildWorkDir} && ${injectEnv} bash scripts/inject-placeholders.sh ${recipe.name}`
            )
        ).trim()

        const recipeHcl = `${remoteBuildWorkDir}/recipes/${recipe.name}.pkr.hcl`

        await remoteStreaming(
            env.SSH_TARGET,
            `flock -x /var/lib/cofoundry/packer-init.lock packer init ${shellQuote(recipeHcl)}`,
            onLine,
            cancelSignal
        )

        const packerArgs = [
            'packer',
            'build',
            '-force',
            ...(options.keepVm ? ['-on-error=abort'] : []),
            '-var-file',
            varsFile,
            ...buildPackerVars(
                env,
                recipe,
                buildBridge,
                slot ? { ip: slot.ip, gw: slot.gw, mac: slot.mac } : null,
                effectiveBuildVmid
            ),
            recipeHcl,
        ]
        const remoteEnv = buildRemoteEnv(
            env,
            remoteOutDir,
            remotePackerTmpDir,
            recipe.arch,
            recipe.group ?? '',
            recipe.finalDiskSize,
            recipe.buildVmid,
            options.skipUpload,
            { cores: recipe.minCores, memoryMb: recipe.minMemoryMb }
        )

        const cleanupVmid = effectiveBuildVmid
        const unregisterVmCleanup =
            cleanupVmid && !options.keepVm
                ? registerCleanup(() => {
                      process.stderr.write(
                          `\ncancelled — destroying build VM ${cleanupVmid}\n`
                      )
                      const destroyCmd = destroyVmCommand(
                          cleanupVmid,
                          env.CF_STORAGE
                      )
                      spawnSync('ssh', [env.SSH_TARGET, destroyCmd], {
                          stdio: 'inherit',
                      })
                  })
                : undefined

        // Prepend a watchdog that restarts the VM if it shuts down before the
        // communicator comes up.  Installers (Windows PE and some Linux distros)
        // occasionally issue a hard shutdown instead of a reboot mid-install,
        // leaving Packer hanging on "Waiting for SSH/WinRM to become available".
        // The watchdog exits automatically once the communicator port is
        // reachable, so it never interferes with later intentional shutdowns
        // (e.g. Windows sysprep at the end of Finalize.ps1).
        const communicatorPort = layout.isWindows ? 5985 : 22
        const watchdog =
            effectiveBuildVmid && slot
                ? buildVmWatchdog(
                      effectiveBuildVmid,
                      slot.ip,
                      communicatorPort,
                      layout.isWindows
                  )
                : ''
        // Screenshot/log recorder. Emitted AFTER the watchdog so its EXIT/signal
        // traps supersede the watchdog's — it re-kills $_WDOG_PID too, so both
        // subshells tear down together.
        const recorder = diagEnabled
            ? buildDiagnosticsRecorder(effectiveBuildVmid as number, {
                  maxLifetimeSec: recorderLifetimeSec(layout.isWindows),
                  guestLogs: guestLogSpecs(recipe.group),
              })
            : ''
        // Windows builds intermittently fail mid-install (component-store
        // corruption in the specialize pass) on busy nodes. Retry the whole
        // packer build — `-force` recreates the VM from scratch each attempt,
        // so a retry is a clean install, not a resume. Override with
        // CF_BUILD_ATTEMPTS; keepVm (debug/inspect) disables retries.
        const maxAttempts = buildAttemptCount(
            layout.isWindows,
            Boolean(options.keepVm),
            env.CF_BUILD_ATTEMPTS
        )
        // Stream Packer through a durable node-side console log (see
        // streamViaConsoleLog) rather than piping the live process straight
        // over SSH — a long WinRM wait or a transient pipe stall must not be
        // able to swallow output. The log lives in the run-scoped tmp dir, so
        // the existing rm -rf cleanup removes it with everything else.
        const packerConsoleLog = `${remoteBuildTmpDir}/packer-console.log`
        const packerCommand = streamViaConsoleLog(
            `${remoteEnv} ${packerArgs.join(' ')}`,
            packerConsoleLog
        )
        let lastAttempt = 0
        try {
            await runWithRetries(
                maxAttempts,
                async attempt => {
                    lastAttempt = attempt
                    // A transport death (SSH exit 255) or an external reap kills
                    // the attempt without unwinding its cleanup, leaving the
                    // build VM running and sometimes deleting the run-scoped tmp
                    // dir. Packer's own -force cannot recover either: it refuses
                    // with "found matching VM (ID: N), but it is not a template",
                    // and a missing tmp dir fails the console-log redirect
                    // immediately. Both were observed on 2026-08-01, where each
                    // burned the remaining attempts in seconds after two hours of
                    // correct work. Re-level the ground before every retry.
                    if (attempt > 1) {
                        const vmid = effectiveBuildVmid
                        const dropStaleVm =
                            vmid === undefined
                                ? ''
                                : `if qm config ${vmid} >/dev/null 2>&1 && ! qm config ${vmid} 2>/dev/null | grep -q '^template:'; then ` +
                                  `qm stop ${vmid} --skiplock 1 >/dev/null 2>&1 || true; ` +
                                  `qm unlock ${vmid} >/dev/null 2>&1 || true; ` +
                                  `qm destroy ${vmid} --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true; ` +
                                  `fi; `
                        await captureRemote(
                            env.SSH_TARGET,
                            `${dropStaleVm}mkdir -p ${shellQuote(remoteBuildTmpDir)} && echo ok`
                        ).catch(() => undefined)
                    }
                    await remoteStreamingScript(
                        env.SSH_TARGET,
                        `${watchdog}${recorder}${packerCommand}`,
                        onLine,
                        cancelSignal
                    )
                },
                onLine,
                cancelSignal
            )
        } catch (err) {
            // Collect BEFORE the outer finally wipes the vars file (the source of
            // the ephemeral secret used to scrub logs) and the tmpfs recorder dir.
            // Skip on a lost lease: the sweep already destroyed the recorder
            // directory and VM, and a doomed collection would only eat into
            // the bounded settle window that gates cleanup.
            if (diagEnabled && !cancelSignal.aborted) {
                await collectDiagnostics({
                    env,
                    recipe,
                    vmid: effectiveBuildVmid as number,
                    isWindows: layout.isWindows,
                    varsFile,
                    packerConsoleLog,
                    ciMode: Boolean(options.ciMode),
                    attempt: lastAttempt,
                    error: err,
                })
            }
            throw err
        } finally {
            unregisterVmCleanup?.()
        }
    }

    try {
        // `lease.lost` rejects once the heartbeat confirms the lease was
        // reaped (or the node stayed unreachable past the stale window) — at
        // that point another admission has destroyed this run's VM and temp
        // directories, so the run is cancelled for real instead of waiting
        // out packer's communicator timeout: the abort signal kills the local
        // SSH child, an explicit remote kill (the sweep's own pkill pattern)
        // terminates the remote packer, and the cleanup below only starts
        // once the work has settled or the bounded window elapsed.
        await raceLeasedWork({
            run: runLeased,
            lost: lease.lost,
            terminateRemote: () =>
                captureRemote(
                    env.SSH_TARGET,
                    killLeasedRunProcessesCommand(remoteBuildTmpDir)
                ).then(
                    () => undefined,
                    () => undefined
                ),
            onStalled: () =>
                log.warn(
                    `${recipe.name}: aborted build did not settle within ${ABORT_SETTLE_MS / 1000}s — cleaning up anyway`
                ),
        })
    } finally {
        // The injector modifies only this build's writable snapshot copy. The
        // private temp tree also contains vars files, private keys, and
        // generated answer-file ISOs, so remove the whole tree together.
        unregisterSecretCleanup?.()
        if (effectiveBuildVmid !== undefined && !options.keepVm) {
            await captureRemote(
                env.SSH_TARGET,
                destroyVmCommand(effectiveBuildVmid, env.CF_STORAGE)
            ).catch(() => {})
        }
        await captureRemote(env.SSH_TARGET, secretCleanupCmd).catch(() => {})
        // Widened: assigned inside runLeased, which flow analysis cannot see.
        await (slot as BuildSlot | null)?.release()
        await lease.release()
    }

    return { startedAt }
}
