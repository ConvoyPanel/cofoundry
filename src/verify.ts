import { execa } from 'execa'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { createRenderer, title, accent, dim } from '@cofoundry/ui'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { shellQuote } from '@/util.ts'
import { buildRemoteOutDir } from '@/build/paths.ts'
import { createArgs, DEFAULT_BRIDGE } from '@/registry/create.ts'
import type { DiskImage, Template } from '@/registry/schema.ts'
import { acquireRunLease } from '@/build/lease.ts'
import { captureRemote, registerCleanup } from '@/build/remote.ts'
import { destroyVmCommand } from '@/build/vm.ts'
import { acquireRemoteMaintenanceLock } from '@/build/maintenance.ts'
import { diagnosticsRunDirName } from '@/build/diagnostics/paths.ts'
import { log } from '@/log.ts'
import { isWindowsRecipe, suiteFor } from '@/verify/checks/index.ts'
import type { CheckResult } from '@/verify/guest.ts'
import {
    guestExec,
    rebootGuest,
    runPhase,
    waitForWindowsInit,
} from '@/verify/guest.ts'
import { autologonScript, prepareCloudInit } from '@/verify/clone.ts'
import { captureFrame, saveFrame } from '@/verify/screenshot.ts'
import {
    formatFailures,
    formatWarnings,
    frameResult,
    summarize,
} from '@/verify/report.ts'

const SCRATCH_VMID_BASE = 9500
const SCRATCH_VMID_COUNT = 500
const VERIFY_STATE_DIR = '/var/lib/cofoundry/verify-reservations'
const VERIFY_LOCK = '/var/lib/cofoundry/verify.lock'
const VERIFY_RESERVATION_STALE_SECS = 60 * 60
const GUEST_PING_TIMEOUT_S = 180
const GUEST_PING_INTERVAL_S = 5
const REBOOT_TIMEOUT_S = 300
// The shell starts asynchronously after autologon; ShellHost's fault loop in the
// gray-desktop failure fired roughly every 30s, so sample well past one cycle.
const SHELL_SETTLE_S = 90
// Cloudbase-Init runs its plugins and reboots once for the hostname, so this
// covers two boots plus plugin time.
const WINDOWS_INIT_TIMEOUT_S = 900

export interface VerifyOptions {
    /**
     * `quick` keeps the original behaviour — restore, boot, ping the agent — for
     * fast local loops. `full` runs the check battery and is the CI default.
     */
    level?: 'quick' | 'full'
    /** In CI the repo is public, so framebuffer captures are never written out. */
    ciMode?: boolean
}

const ssh = async (target: string, cmd: string): Promise<string> => {
    const { stdout } = await execa('ssh', [target, cmd], {
        stdin: 'inherit',
        stderr: 'inherit',
    })
    return stdout
}

const sshOk = async (target: string, cmd: string): Promise<boolean> => {
    const res = await execa('ssh', [target, cmd], {
        reject: false,
        stdin: 'inherit',
        stderr: 'inherit',
    })
    return res.exitCode === 0
}

export const reserveScratchVmidScript = (
    owner: string
): string => `set -euo pipefail
mkdir -p ${shellQuote(VERIFY_STATE_DIR)}
exec 9>${shellQuote(VERIFY_LOCK)}
flock -x 9
now=$(date +%s)
for reservation in ${shellQuote(VERIFY_STATE_DIR)}/*; do
    [ -f "$reservation" ] || continue
    modified=$(stat -c %Y "$reservation" 2>/dev/null || echo "$now")
    [ "$((now - modified))" -gt ${VERIFY_RESERVATION_STALE_SECS} ] || continue
    stale_vmid=$(cat "$reservation" 2>/dev/null || true)
    case "$stale_vmid" in
        ''|*[!0-9]*) ;;
        *)
            qm stop "$stale_vmid" --skiplock 1 >/dev/null 2>&1 || true
            qm unlock "$stale_vmid" >/dev/null 2>&1 || true
            qm destroy "$stale_vmid" --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true
            ;;
    esac
    rm -f "$reservation"
done
used=" $(qm list 2>/dev/null | awk 'NR>1 {printf "%s ", $1}')"
for reservation in ${shellQuote(VERIFY_STATE_DIR)}/*; do
    [ -f "$reservation" ] || continue
    used="$used$(cat "$reservation" 2>/dev/null) "
done
pick=""
for id in $(seq ${SCRATCH_VMID_BASE} ${SCRATCH_VMID_BASE + SCRATCH_VMID_COUNT - 1}); do
    case "$used" in *" $id "*) ;; *) pick=$id; break ;; esac
done
[ -n "$pick" ] || { echo 'no free scratch VMID found in 9500-9999' >&2; exit 1; }
printf '%s\n' "$pick" > ${shellQuote(`${VERIFY_STATE_DIR}/${owner}`)}
echo "$pick"
`

const reserveScratchVmid = async (
    target: string,
    owner: string
): Promise<number> => {
    const raw = await ssh(
        target,
        `bash -s <<'__CF_VERIFY_VMID__'\n${reserveScratchVmidScript(owner)}\n__CF_VERIFY_VMID__`
    )
    const vmid = Number.parseInt(raw.trim(), 10)
    if (!Number.isInteger(vmid))
        throw new Error(`invalid scratch VMID reservation: ${raw}`)
    return vmid
}

const destroyVm = async (
    target: string,
    vmid: number,
    storage: string
): Promise<void> => {
    await sshOk(target, destroyVmCommand(vmid, storage))
}

const pingGuest = async (
    target: string,
    vmid: number,
    timeoutS: number,
    intervalS: number
): Promise<boolean> => {
    const deadline = Date.now() + timeoutS * 1000
    while (Date.now() < deadline) {
        const ok = await sshOk(
            target,
            `qm guest cmd ${vmid} ping >/dev/null 2>&1`
        )
        if (ok) return true
        await new Promise(r => setTimeout(r, intervalS * 1000))
    }
    return false
}

/**
 * Smoke-test the locally-built artifact by rebuilding a VM from it on the PVE
 * node — the same `qm create --import-from` path `coport` installs through —
 * and exercising it the way a user's clone is exercised: cloud-init parameters
 * injected and asserted, a battery of in-guest checks over `qm guest exec`, a
 * reboot round-trip, and a look at the actual console framebuffer.
 *
 * Going through the published sidecar rather than the build VM is deliberate:
 * it puts the hardware profile itself under test on every run, so a profile
 * that no longer describes what its images need fails here instead of in a
 * consumer's install.
 *
 * The guest agent answering is the weakest signal in the stack — it starts early
 * and is independent of nearly everything a template promises — so it is the
 * entry condition for the real checks rather than the result.
 */
export const runVerify = async (
    env: Env,
    recipe: RecipeInfo,
    options: VerifyOptions = {}
): Promise<void> => {
    const maintenance = await acquireRemoteMaintenanceLock(
        env.SSH_TARGET,
        'shared'
    )
    try {
        await Promise.race([
            runVerifyLocked(env, recipe, options),
            maintenance.lost,
        ])
    } finally {
        await maintenance.release()
    }
}

const runVerifyLocked = async (
    env: Env,
    recipe: RecipeInfo,
    options: VerifyOptions
): Promise<void> => {
    const sidecarName = `${recipe.name}-${recipe.arch}.json`
    const localSidecar = join(env.CF_OUT_DIR, sidecarName)
    const remoteOutDir = buildRemoteOutDir(env)
    const owner = randomUUID()
    const remoteTmp = `${env.PVE_DUMP_DIR}/cofoundry-verify-${owner}`
    const reservation = `${VERIFY_STATE_DIR}/${owner}`

    // Prefer the artifacts already on the PVE node from the build step
    // (CI sets CF_SKIP_ARTIFACT_SYNC=1, so they never land locally). Fall back
    // to uploading the local files when running outside CI.
    const remoteHasBuildArtifact = await sshOk(
        env.SSH_TARGET,
        `test -f ${shellQuote(`${remoteOutDir}/${sidecarName}`)}`
    )
    const localExists = await Bun.file(localSidecar).exists()
    if (!remoteHasBuildArtifact && !localExists) {
        throw new Error(
            `sidecar not found locally (${localSidecar}) or on ${env.SSH_TARGET} (${remoteOutDir}/${sidecarName})`
        )
    }

    // The sidecar names the images and carries the hardware profile the VM is
    // rebuilt from — verify reads the published artifact rather than the build
    // VM, so the profile itself is under test.
    const template: Template = JSON.parse(
        remoteHasBuildArtifact
            ? await captureRemote(
                  env.SSH_TARGET,
                  `cat ${shellQuote(`${remoteOutDir}/${sidecarName}`)}`
              )
            : await Bun.file(localSidecar).text()
    )

    // Local files are `<name><ext>`; published ones carry the hash. See
    // localArtifactName in src/upload/template.ts.
    const localImage = (disk: DiskImage): string =>
        disk.file.replace(`${template.name}-${disk.sha256}`, template.name)

    const lease = await acquireRunLease(env, 'verify', recipe, remoteTmp)
    const renderer = createRenderer({
        title: title(
            `Verifying ${accent(recipe.name)} ${dim('on')} ${accent(env.SSH_TARGET)}`
        ),
        outputLines: 1,
    })
    const task = renderer.task(recipe.name)
    let vmid = 0
    let lastPhase = 'first-boot'
    let savedFrame: string | null = null
    let releaseCloudInit: (() => Promise<void>) | null = null
    const unregisterCleanup = registerCleanup(() => {
        const destroy =
            vmid > 0 ? `${destroyVmCommand(vmid, env.CF_STORAGE)}; ` : ''
        spawnSync(
            'ssh',
            [
                env.SSH_TARGET,
                destroy +
                    `rm -rf ${shellQuote(remoteTmp)}; rm -f ${shellQuote(reservation)}`,
            ],
            { stdio: 'ignore' }
        )
    })

    try {
        await ssh(env.SSH_TARGET, `mkdir -p ${shellQuote(remoteTmp)}`)
        // Where each image sits on the node, keyed by the slot it imports into.
        // `import-from` takes an absolute path, so nothing has to be staged
        // into an import-content storage first.
        const files = new Map<string, string>()
        if (remoteHasBuildArtifact) {
            task.setPhase(`using remote images ${dim(remoteOutDir)}`)
            for (const disk of template.disks)
                files.set(disk.slot, `${remoteOutDir}/${localImage(disk)}`)
        } else {
            task.setPhase(`uploading images ${dim('→')} ${env.SSH_TARGET}`)
            for (const disk of template.disks) {
                const name = localImage(disk)
                const dest = `${remoteTmp}/${name}`
                await execa(
                    'scp',
                    [join(env.CF_OUT_DIR, name), `${env.SSH_TARGET}:${dest}`],
                    { stdin: 'inherit', stderr: 'inherit' }
                )
                files.set(disk.slot, dest)
            }
        }

        task.setPhase('allocating VMID')
        vmid = await reserveScratchVmid(env.SSH_TARGET, owner)
        await lease.setVmid(vmid)

        // Built through the SAME builder coport installs with, so the published
        // hardware profile is exercised on every verify run instead of being
        // metadata nothing ever reads. Unlike the old qmrestore path this
        // produces a plain VM, so there is no template flag to clear and no
        // immutable attr to strip off base-<vmid> disks before booting.
        //
        // Verify boots at the BUILD shape, not the profile's `minimum`: the
        // floor is what a consumer may configure, while these checks want the
        // resources the recipe was exercised with.
        task.setPhase(`qm create ${dim('→')} VMID ${accent(String(vmid))}`)
        await ssh(
            env.SSH_TARGET,
            createArgs(template, {
                vmid,
                storage: env.CF_STORAGE,
                bridge: env.CF_BUILD_BRIDGE || DEFAULT_BRIDGE,
                files,
                cores: recipe.buildCores,
                memory: recipe.buildMemoryMb,
                name: `cofoundry-verify-${recipe.name}`,
            })
                .map(shellQuote)
                .join(' ')
        )

        const isWindows = isWindowsRecipe(recipe.name)
        const full = (options.level ?? 'full') === 'full'

        let cloudInit: Awaited<ReturnType<typeof prepareCloudInit>> | null =
            null
        if (full) {
            task.setPhase('applying cloud-init parameters')
            cloudInit = await prepareCloudInit(
                env,
                recipe.name,
                vmid,
                remoteTmp,
                isWindows
            )
            releaseCloudInit = cloudInit.cleanup
        }

        task.setPhase(`qm start ${vmid}`)
        await ssh(env.SSH_TARGET, `qm start ${vmid}`)

        task.setPhase(
            `waiting for guest agent ${dim(`(≤${GUEST_PING_TIMEOUT_S}s)`)}`
        )
        const ok = await pingGuest(
            env.SSH_TARGET,
            vmid,
            GUEST_PING_TIMEOUT_S,
            GUEST_PING_INTERVAL_S
        )
        if (!ok) {
            throw new Error(
                `guest agent did not respond within ${GUEST_PING_TIMEOUT_S}s`
            )
        }

        if (!cloudInit) {
            task.succeed(`guest agent responded ${dim(`(VMID ${vmid})`)}`)
            return
        }

        const suite = suiteFor(recipe)
        const ctx = cloudInit.ctx
        const results: CheckResult[] = []
        const record = (r: CheckResult): void => {
            task.setPhase(
                `${r.status === 'pass' ? '✓' : r.status === 'warn' ? '!' : '✗'} ${r.id}`
            )
        }
        // Waits are reported as progress, not as phases or logs: a rebooting
        // guest refusing commands for minutes is the expected shape of this
        // run, and `qm`'s own wording for it ("QEMU guest agent is not
        // running") reads as a fault when it lands raw in the log.
        const waiting = (note: string): void => task.setProgress(dim(note))

        if (isWindows) {
            task.setPhase(
                `waiting for Cloudbase-Init ${dim(`(≤${WINDOWS_INIT_TIMEOUT_S}s)`)}`
            )
            if (
                !(await waitForWindowsInit(
                    env.SSH_TARGET,
                    vmid,
                    ctx.hostname,
                    WINDOWS_INIT_TIMEOUT_S,
                    { onWait: waiting }
                ))
            ) {
                throw new Error(
                    `Cloudbase-Init did not settle within ${WINDOWS_INIT_TIMEOUT_S}s — ` +
                        `the service is stuck (check GeneralizationState) or looping`
                )
            }
        }

        task.setPhase('running first-boot checks')
        results.push(
            ...(await runPhase(
                env.SSH_TARGET,
                vmid,
                suite,
                'first-boot',
                ctx,
                record,
                waiting
            ))
        )
        lastPhase = 'first-boot'

        task.setPhase(`rebooting ${dim(`(≤${REBOOT_TIMEOUT_S}s)`)}`)
        if (
            !(await rebootGuest(
                env.SSH_TARGET,
                vmid,
                suite.shell,
                REBOOT_TIMEOUT_S,
                { onWait: waiting }
            ))
        ) {
            throw new Error(
                `guest did not come back from a reboot within ${REBOOT_TIMEOUT_S}s`
            )
        }

        task.setPhase('running post-reboot checks')
        results.push(
            ...(await runPhase(
                env.SSH_TARGET,
                vmid,
                suite,
                'post-reboot',
                ctx,
                record,
                waiting
            ))
        )
        lastPhase = 'post-reboot'

        if (isWindows) {
            // The shell only starts for an interactive logon, so the desktop
            // has to be brought up deliberately before it can be inspected.
            task.setPhase('arming autologon')
            await guestExec(
                env.SSH_TARGET,
                vmid,
                suite.shell,
                autologonScript(ctx.ciUser, ctx.ciPassword),
                60
            )
            if (
                !(await rebootGuest(
                    env.SSH_TARGET,
                    vmid,
                    suite.shell,
                    REBOOT_TIMEOUT_S,
                    { onWait: waiting }
                ))
            ) {
                throw new Error('guest did not come back from the logon reboot')
            }
            task.setPhase(
                `letting the shell settle ${dim(`(${SHELL_SETTLE_S}s)`)}`
            )
            await new Promise(r => setTimeout(r, SHELL_SETTLE_S * 1000))
            results.push(
                ...(await runPhase(
                    env.SSH_TARGET,
                    vmid,
                    suite,
                    'post-logon',
                    ctx,
                    record,
                    waiting
                ))
            )
            lastPhase = 'post-logon'
        }

        // One framebuffer sample at the end: for Windows this is the desktop
        // that autologon painted, which is the only view that crosses the
        // session-0 boundary the guest agent is stuck behind.
        const label = lastPhase
        task.setPhase('capturing console framebuffer')
        const frame = await captureFrame(env.SSH_TARGET, vmid, remoteTmp, label)
        if (frame) {
            results.push(
                frameResult(
                    label,
                    frame.analysis,
                    suite.screenUniformThreshold,
                    suite.screenSeverity
                )
            )
            if (!options.ciMode) {
                savedFrame = await saveFrame(
                    join(
                        './diagnostics',
                        `verify-${diagnosticsRunDirName(recipe, new Date())}`
                    ),
                    label,
                    frame
                ).catch(() => null)
            }
        }

        const summary = summarize(results)
        const line =
            `${summary.passed} passed` +
            (summary.warned ? `, ${summary.warned} warned` : '') +
            (summary.failed ? `, ${summary.failed} failed` : '')

        if (summary.failed > 0) {
            task.fail(line)
            throw new Error(
                `${recipe.name}: ${summary.failed} check(s) failed\n${formatFailures(results)}`
            )
        }
        task.succeed(`${line} ${dim(`(VMID ${vmid})`)}`)
        if (summary.warned > 0) log.warn(formatWarnings(results))
        if (savedFrame) log.info(`console frame saved to ${savedFrame}`)
    } catch (err) {
        task.fail(err instanceof Error ? err.message : String(err))
        throw err
    } finally {
        unregisterCleanup()
        // The generated keypair lives in a local temp dir; drop it even when a
        // check threw partway through the battery.
        if (releaseCloudInit) await releaseCloudInit().catch(() => {})
        if (vmid > 0) await destroyVm(env.SSH_TARGET, vmid, env.CF_STORAGE)
        await sshOk(env.SSH_TARGET, `rm -rf ${shellQuote(remoteTmp)}`)
        await sshOk(env.SSH_TARGET, `rm -f ${shellQuote(reservation)}`)
        await lease.release()
        renderer.finish()
    }
}
