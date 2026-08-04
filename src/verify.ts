import { execa } from 'execa'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { createRenderer, title, accent, dim } from '@cofoundry/ui'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { shellQuote } from '@/util.ts'
import { buildRemoteOutDir } from '@/build/paths.ts'
import { acquireRunLease } from '@/build/lease.ts'
import { registerCleanup } from '@/build/remote.ts'
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
 * Smoke-test the locally-built artifact by qmrestore-ing it on the PVE node and
 * exercising it the way a user's clone is exercised: cloud-init parameters
 * injected and asserted, a battery of in-guest checks over `qm guest exec`, a
 * reboot round-trip, and a look at the actual console framebuffer.
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
    const artifactName = `${recipe.name}-${recipe.arch}.vma.zst`
    const local = join(env.CF_OUT_DIR, artifactName)
    const remoteBuildFile = `${buildRemoteOutDir(env)}/${artifactName}`
    // Scratch dir lives under PVE_DUMP_DIR so hard-linking the artifact into
    // it always works (same filesystem). /var/tmp on the node may be on a
    // different mount.
    const owner = randomUUID()
    const remoteTmp = `${env.PVE_DUMP_DIR}/cofoundry-verify-${owner}`
    const reservation = `${VERIFY_STATE_DIR}/${owner}`

    // Prefer the artifact already on the PVE node from the build step
    // (CI sets CF_SKIP_ARTIFACT_SYNC=1, so it never lands locally). Fall back to
    // uploading the local file when running outside CI.
    const remoteHasBuildArtifact = await sshOk(
        env.SSH_TARGET,
        `test -f ${shellQuote(remoteBuildFile)}`
    )
    const localExists = await Bun.file(local).exists()
    if (!remoteHasBuildArtifact && !localExists) {
        throw new Error(
            `artifact not found locally (${local}) or on ${env.SSH_TARGET} (${remoteBuildFile})`
        )
    }

    const sourceFile = remoteHasBuildArtifact
        ? remoteBuildFile
        : `${remoteTmp}/${basename(local)}`
    // qmrestore parses the basename to extract VMID/type and rejects anything
    // that doesn't match Proxmox's vzdump regex:
    //   /vzdump-(qemu|lxc|openvz)-(\d+)-(\d{4}_\d{2}_\d{2}-\d{2}_\d{2}_\d{2})\.…/
    // (date/time separator is a dash, not an underscore.) It also resolves
    // realpath() before parsing, so a symlink won't help — we need a hard
    // link with the right name. Hard linking requires the same filesystem,
    // hence remoteTmp under PVE_DUMP_DIR.
    const d = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const ts =
        `${d.getUTCFullYear()}_${pad(d.getUTCMonth() + 1)}_${pad(d.getUTCDate())}` +
        `-${pad(d.getUTCHours())}_${pad(d.getUTCMinutes())}_${pad(d.getUTCSeconds())}`

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
        if (remoteHasBuildArtifact) {
            task.setPhase(`using remote artifact ${dim(remoteBuildFile)}`)
            await ssh(env.SSH_TARGET, `mkdir -p ${shellQuote(remoteTmp)}`)
        } else {
            task.setPhase(`uploading artifact ${dim('→')} ${env.SSH_TARGET}`)
            await ssh(env.SSH_TARGET, `mkdir -p ${shellQuote(remoteTmp)}`)
            await execa('scp', [local, `${env.SSH_TARGET}:${sourceFile}`], {
                stdin: 'inherit',
                stderr: 'inherit',
            })
        }

        task.setPhase('allocating VMID')
        vmid = await reserveScratchVmid(env.SSH_TARGET, owner)
        await lease.setVmid(vmid)

        const restoreFile = `${remoteTmp}/vzdump-qemu-${vmid}-${ts}.vma.zst`
        await ssh(
            env.SSH_TARGET,
            `ln -f ${shellQuote(sourceFile)} ${shellQuote(restoreFile)}`
        )

        task.setPhase(`qmrestore ${dim('→')} VMID ${accent(String(vmid))}`)
        await ssh(
            env.SSH_TARGET,
            `qmrestore ${shellQuote(restoreFile)} ${vmid} --storage ${shellQuote(env.CF_STORAGE)} --unique 1`
        )
        // vzdump-of-a-template restores as a template: (1) the config has
        // `template: 1`, blocking `qm start`; and (2) on dir/file storage,
        // each disk has the immutable attr (chattr +i) set and a base-<vmid>
        // filename prefix, so KVM can't open them ("Operation not permitted").
        // Strip both so we can boot the restored VM.
        await ssh(
            env.SSH_TARGET,
            // (1) Clear template flag in both API and on-disk config.
            `qm set ${vmid} --template 0 >/dev/null 2>&1 || true; ` +
                `sed -i '/^template:/d' /etc/pve/qemu-server/${vmid}.conf; ` +
                // (2) Clear immutable attr on all disk files for this VMID
                // across whatever storages were used. Resolve each disk volid
                // through `pvesm path` so this works regardless of CF_STORAGE.
                `qm config ${vmid} | ` +
                `sed -nE 's/^(scsi|sata|ide|virtio|efidisk|tpmstate)[0-9]+: ([^,]+).*/\\2/p' | ` +
                `while read vol; do ` +
                `  p=$(pvesm path "$vol" 2>/dev/null) || continue; ` +
                `  [ -n "$p" ] && [ -f "$p" ] && chattr -i "$p" 2>/dev/null || true; ` +
                `done`
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
