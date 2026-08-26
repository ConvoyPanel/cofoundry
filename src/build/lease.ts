import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import {
    captureRemote,
    registerCleanup,
    remoteExitCode,
} from '@/build/remote.ts'
import { PACKER_TMP_ROOT } from '@/build/packer.ts'
import { shellQuote } from '@/util.ts'

export const RUN_LEASE_DIR = '/var/lib/cofoundry/run-leases'
export const RUN_LEASE_LOCK = '/var/lib/cofoundry/run-leases.lock'
export const OWNED_VMID_DIR = '/var/lib/cofoundry/owned-vmids'
/**
 * How long a lease may go unrefreshed before an admission sweep reaps it and
 * destroys the run's VM and scratch.
 *
 * This is a tolerance for losing the LINK to the node, not for the build dying:
 * packer runs on the node, so a build survives its launcher losing SSH — what
 * stops is cf's ability to heartbeat. At 10 minutes a brief tunnel outage
 * therefore threw away hours of real work. On 2026-08-26 a windows-server-2025
 * rebuild was killed 2h33m in ("10 consecutive heartbeats failed"), and two
 * other Windows runs died the same way earlier that day.
 *
 * 30 minutes is chosen against the thing being protected: a Windows build costs
 * 1-3 hours, so holding a dead run's resources for an extra 20 minutes is far
 * cheaper than discarding a live one. Reaping is still bounded, and a genuinely
 * dead launcher still frees everything well inside the next build's setup.
 */
export const RUN_LEASE_STALE_SECS = 30 * 60

const HEARTBEAT_MS = 60_000
const RETRY_MS = 10_000

// Distinct heartbeat exit status for "the lease file is gone", so it cannot be
// confused with an SSH transport failure (255) or a failed touch.
export const HEARTBEAT_GONE_EXIT = 44

// Consecutive heartbeat failures after which the lease must be presumed lost:
// by then its mtime is at least RUN_LEASE_STALE_SECS old, so any admission
// sweep that ran meanwhile has reaped it and destroyed the run's resources.
export const HEARTBEAT_LOST_AFTER_FAILURES = Math.ceil(
    (RUN_LEASE_STALE_SECS * 1000) / HEARTBEAT_MS
)

export type RunLease = {
    id: string
    /** Rejects once the lease is confirmed reaped, or the node has been
     *  unreachable past the stale window. Race leased work against it via
     *  `raceLeasedWork` (executor.ts), which also aborts and terminates the
     *  losing work instead of leaving it running. */
    lost: Promise<never>
    setVmid: (vmid: number) => Promise<void>
    release: () => Promise<void>
}

type LeaseRequest = {
    id: string
    kind: 'build' | 'verify'
    recipe: RecipeInfo
    remoteTmpDir: string
    packerTmpDir?: string
    preserveVm: boolean
    storage: string
}

const leasePath = (id: string): string => `${RUN_LEASE_DIR}/${id}`

/**
 * The lease id doubles as its filename, so deriving it from a caller-supplied
 * run id makes a run's leases findable by anything that knows the run — without
 * the process having to report anything.
 *
 * That matters because the case this exists for is the process being killed
 * outright: a cancelled CI job gets no grace period and loses its network
 * before it could publish an id anywhere. `CF_RUN_ID` is known to the CI job
 * that cleans up, independently of whether the build survived long enough to
 * say anything.
 *
 * Kind and recipe keep runs that build several recipes, or build then verify,
 * from colliding on one id while staying under the run's prefix.
 */
export const runLeaseId = (
    runId: string | undefined,
    kind: LeaseRequest['kind'],
    recipeName: string
): string =>
    runId
        ? `${sanitizeIdPart(runId)}-${kind}-${sanitizeIdPart(recipeName)}`
        : randomUUID()

// The id becomes a filename and a glob operand; keep it to characters that are
// inert in both.
const sanitizeIdPart = (value: string): string =>
    value.replace(/[^A-Za-z0-9._]+/g, '-')

const leaseRecord = (request: LeaseRequest, vmid: number): string =>
    [
        request.kind,
        request.recipe.name,
        vmid,
        request.recipe.buildMemoryMb ?? 0,
        request.recipe.buildCores ?? 0,
        request.remoteTmpDir,
        request.preserveVm ? 1 : 0,
        request.storage,
        request.packerTmpDir ?? '',
    ].join('\t')

/**
 * The destroy half of a reap. Expects `$lease` to name an existing lease file;
 * frees only the resources that lease records, then unlinks it.
 *
 * Shared by the age-gated sweep and the run-targeted reap so there is exactly
 * one implementation of "what a lease owns".
 */
const reapLeaseBody = (reason: string): string => `
    IFS=$'\\t' read -r kind recipe vmid memory cores tmpdir preserve_vm storage packer_tmpdir < "$lease" || true
    echo "reaping ${reason} cofoundry $kind lease \${lease##*/} ($recipe)" >&2
    if [ "$preserve_vm" != 1 ]; then
        case "$vmid" in
            ''|0|*[!0-9]*) ;;
            *)
                qm stop "$vmid" --skiplock 1 >/dev/null 2>&1 || true
                qm unlock "$vmid" >/dev/null 2>&1 || true
                qm destroy "$vmid" --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true
                if ! qm config "$vmid" >/dev/null 2>&1 && [ -n "$storage" ]; then
                    pvesm list "$storage" --content images 2>/dev/null | awk -v id="$vmid" 'NR>1 && $NF==id {print $1}' | while IFS= read -r volid; do
                        pvesm free "$volid" >/dev/null 2>&1 || true
                    done
                fi
                ;;
        esac
    fi
    case "$tmpdir" in
        */cofoundry-tmp/build-*)
            pkill -9 -f -- "$tmpdir" >/dev/null 2>&1 || true
            rm -rf -- "$tmpdir"
            ;;
        */cofoundry-verify-*)
            pkill -9 -f -- "$tmpdir" >/dev/null 2>&1 || true
            owner=\${tmpdir##*cofoundry-verify-}
            rm -rf -- "$tmpdir"
            rm -f -- "/var/lib/cofoundry/verify-reservations/$owner"
            ;;
    esac
    case "$packer_tmpdir" in
        ${PACKER_TMP_ROOT}/*) rm -rf -- "$packer_tmpdir" ;;
    esac
    rm -f -- "$lease"
`

/**
 * Shell shared by admission and prune. A stale lease means its runner stopped
 * heartbeating; reap only resources named by that lease, then remove it.
 */
export const sweepRunLeasesScript = (
    staleSeconds = RUN_LEASE_STALE_SECS
): string => `
now=$(date +%s)
for lease in ${shellQuote(RUN_LEASE_DIR)}/*; do
    [ -f "$lease" ] || continue
    modified=$(stat -c %Y "$lease" 2>/dev/null || echo "$now")
    [ "$((now - modified))" -gt ${staleSeconds} ] || continue
${reapLeaseBody('stale')}
done
`

/**
 * A lease id prefix is used to select leases for the run-targeted reap, so it
 * reaches a glob and a `rm -rf` path. Anything outside this set could escape
 * the lease directory or widen the match — `*` alone would reap every live
 * build on the node, age gate and all.
 */
const SAFE_LEASE_PREFIX = /^[A-Za-z0-9._-]+$/

/**
 * Reap every lease whose id starts with `prefix`, **ignoring age**.
 *
 * The age gate exists so the generic sweep can never reap a build that is still
 * heartbeating. That gate is unusable for cleaning up after a run that just
 * died: CI cleanup fires seconds later, when the lease still looks perfectly
 * healthy, and no threshold low enough to catch it would be safe for other
 * builds. Identity replaces age — the caller must name one run, which is why
 * the prefix carries a run id and attempt rather than something like a recipe
 * name that a concurrent build could share.
 */
export const reapLeasesByPrefixScript = (prefix: string): string => {
    if (!SAFE_LEASE_PREFIX.test(prefix))
        throw new Error(
            `unsafe lease prefix ${JSON.stringify(prefix)}: expected only letters, digits, dot, dash, underscore`
        )
    return `
for lease in ${shellQuote(RUN_LEASE_DIR)}/${prefix}*; do
    [ -f "$lease" ] || continue
${reapLeaseBody('orphaned')}
done
`
}

export const buildLeaseAdmissionScript = (
    env: Pick<Env, 'CF_BUILD_MEMORY_BUDGET_MB' | 'CF_BUILD_CPU_BUDGET'>,
    request: LeaseRequest
): string => {
    const file = leasePath(request.id)
    const memory = request.recipe.buildMemoryMb ?? 0
    const cores = request.recipe.buildCores ?? 0
    const configuredMemory = env.CF_BUILD_MEMORY_BUDGET_MB
    const configuredCpu = env.CF_BUILD_CPU_BUDGET

    return `set -euo pipefail
mkdir -p ${shellQuote(RUN_LEASE_DIR)}
exec 9>${shellQuote(RUN_LEASE_LOCK)}
flock -x 9
${sweepRunLeasesScript()}
memory_capacity=$(awk '/MemTotal/ { print int($2 / 1024 * 0.8) }' /proc/meminfo)
cpu_capacity=$(nproc)
memory_budget=${configuredMemory ?? '$memory_capacity'}
cpu_budget=${configuredCpu ?? '$cpu_capacity'}
[ "$memory_budget" -le "$memory_capacity" ] || memory_budget=$memory_capacity
[ "$cpu_budget" -le "$cpu_capacity" ] || cpu_budget=$cpu_capacity
memory_used=0
cpu_used=0
same_recipe=0
for lease in ${shellQuote(RUN_LEASE_DIR)}/*; do
    [ -f "$lease" ] || continue
    IFS=$'\\t' read -r _kind active_recipe _vmid active_memory active_cores _tmp < "$lease" || continue
    memory_used=$((memory_used + active_memory))
    cpu_used=$((cpu_used + active_cores))
    [ "$active_recipe" = ${shellQuote(request.recipe.name)} ] && same_recipe=1
done
if [ ${memory} -gt "$memory_budget" ] || [ ${cores} -gt "$cpu_budget" ]; then
    echo "REJECT $memory_budget $cpu_budget"
elif [ "$same_recipe" -eq 1 ] || [ $((memory_used + ${memory})) -gt "$memory_budget" ] || [ $((cpu_used + ${cores})) -gt "$cpu_budget" ]; then
    echo "WAIT $memory_used $memory_budget $cpu_used $cpu_budget $same_recipe"
else
    tmp=${shellQuote(`${file}.tmp`)}.$$
    trap 'rm -f "$tmp"' EXIT
    printf '%s\\n' ${shellQuote(leaseRecord(request, 0))} > "$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" ${shellQuote(file)}
    trap - EXIT
    echo "ACQUIRED $memory_budget $cpu_budget"
fi
`
}

export const updateLeaseVmidScript = (
    request: LeaseRequest,
    vmid: number
): string => {
    const file = leasePath(request.id)
    return `set -euo pipefail
exec 9>${shellQuote(RUN_LEASE_LOCK)}
flock -x 9
test -f ${shellQuote(file)}
tmp=${shellQuote(`${file}.tmp`)}.$$
trap 'rm -f "$tmp"' EXIT
printf '%s\\n' ${shellQuote(leaseRecord(request, vmid))} > "$tmp"
chmod 600 "$tmp"
mv -f "$tmp" ${shellQuote(file)}
mkdir -p ${shellQuote(OWNED_VMID_DIR)}
: > ${shellQuote(`${OWNED_VMID_DIR}/${vmid}`)}
trap - EXIT
`
}

/**
 * Refresh the lease's mtime, or report through a distinct exit status that the
 * file is gone (a stale-lease sweep reaped it). The former
 * `test ! -f … || touch …` form exited 0 on a missing file, so a reaped lease
 * looked exactly like a healthy heartbeat.
 */
export const runLeaseHeartbeatCommand = (file: string): string =>
    `if [ -f ${shellQuote(file)} ]; then touch ${shellQuote(file)}; else exit ${HEARTBEAT_GONE_EXIT}; fi`

/**
 * Kill every remote process whose command line names this run's temp
 * directory — the same reap `sweepRunLeasesScript` applies to a stale run. A
 * local lease-lost abort sends this over a fresh SSH connection because
 * killing the local ssh client is not enough: the packer session runs without
 * a PTY, so the remote command survives a dead client.
 *
 * The first literal character is wrapped in a bracket expression (the classic
 * `pgrep [f]oo` trick): `pkill -f` matches whole command lines, and the shell
 * sshd spawns to run this command embeds the pattern in its own argv — an
 * unescaped pattern would SIGKILL that shell mid-flight. The sweep needs no
 * such guard only because its pattern rides in an unexpanded `"$tmpdir"`.
 * `pkill` exits non-zero when nothing matched (the sweep may already have
 * killed everything), hence the trailing `|| true`.
 */
export const killLeasedRunProcessesCommand = (remoteTmpDir: string): string => {
    const pattern = remoteTmpDir.replace(/[A-Za-z0-9]/, '[$&]')
    return `pkill -9 -f -- ${shellQuote(pattern)} >/dev/null 2>&1 || true`
}

export type HeartbeatState = { failures: number }

/**
 * Per-tick lost-detection: a confirmed-missing file is immediately `gone`,
 * while transport/touch failures only escalate to `lost` once enough
 * consecutive attempts failed that the lease is stale on the node.
 */
export const evaluateHeartbeat = (
    state: HeartbeatState,
    exitCode: number
): 'alive' | 'gone' | 'lost' | 'failing' => {
    if (exitCode === 0) {
        state.failures = 0
        return 'alive'
    }
    if (exitCode === HEARTBEAT_GONE_EXIT) return 'gone'
    state.failures += 1
    return state.failures >= HEARTBEAT_LOST_AFTER_FAILURES ? 'lost' : 'failing'
}

const wait = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms))

export const acquireRunLease = async (
    env: Env,
    kind: LeaseRequest['kind'],
    recipe: RecipeInfo,
    remoteTmpDir: string,
    options: {
        preserveVm?: boolean
        packerTmpDir?: string
        onWait?: (message: string) => void
    } = {}
): Promise<RunLease> => {
    if (
        !recipe.buildMemoryMb ||
        !recipe.buildCores ||
        recipe.buildMemoryMb < 1 ||
        recipe.buildCores < 1
    ) {
        throw new Error(
            `${recipe.name} must declare static memory and cores for node-wide admission`
        )
    }
    const request: LeaseRequest = {
        id: runLeaseId(env.CF_RUN_ID, kind, recipe.name),
        kind,
        recipe,
        remoteTmpDir,
        packerTmpDir: options.packerTmpDir,
        preserveVm: Boolean(options.preserveVm),
        storage: env.CF_STORAGE,
    }
    const file = leasePath(request.id)

    while (true) {
        const output = (
            await captureRemote(
                env.SSH_TARGET,
                `bash -s <<'__CF_LEASE__'\n${buildLeaseAdmissionScript(env, request)}\n__CF_LEASE__`
            )
        ).trim()
        const [status, ...values] = output.split(/\s+/)
        if (status === 'ACQUIRED') break
        if (status === 'REJECT') {
            throw new Error(
                `${recipe.name} requires ${recipe.buildMemoryMb ?? 0} MiB/${recipe.buildCores ?? 0} CPU, exceeding the node build budget ${values[0]} MiB/${values[1]} CPU`
            )
        }
        if (status !== 'WAIT')
            throw new Error(`invalid build-lease response: ${output}`)
        options.onWait?.(
            values[4] === '1'
                ? `waiting for another ${recipe.name} run`
                : `waiting for node capacity (${values[0]}/${values[1]} MiB, ${values[2]}/${values[3]} CPU in use)`
        )
        await wait(RETRY_MS)
    }

    let released = false
    const removeCommand = `rm -f -- ${shellQuote(file)}`
    const signalCleanupCommand =
        `exec 9>${shellQuote(RUN_LEASE_LOCK)}; flock -x 9; ` +
        `if [ -f ${shellQuote(file)} ]; then ` +
        `IFS=$'\\t' read -r _kind _recipe vmid _memory _cores tmpdir preserve_vm storage packer_tmpdir < ${shellQuote(file)} || true; ` +
        `pkill -9 -f -- "$tmpdir" >/dev/null 2>&1 || true; ` +
        `if [ "$preserve_vm" != 1 ]; then case "$vmid" in ''|0|*[!0-9]*) ;; *) ` +
        `qm stop "$vmid" --skiplock 1 >/dev/null 2>&1 || true; qm unlock "$vmid" >/dev/null 2>&1 || true; ` +
        `qm destroy "$vmid" --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true; ` +
        `if ! qm config "$vmid" >/dev/null 2>&1 && [ -n "$storage" ]; then pvesm list "$storage" --content images 2>/dev/null | ` +
        `awk -v id="$vmid" 'NR>1 && $NF==id {print $1}' | while IFS= read -r volid; do pvesm free "$volid" >/dev/null 2>&1 || true; done; fi ;; esac; fi; ` +
        `case "$tmpdir" in */cofoundry-tmp/build-*|*/cofoundry-verify-*) rm -rf -- "$tmpdir" ;; esac; ` +
        `case "$packer_tmpdir" in ${PACKER_TMP_ROOT}/*) rm -rf -- "$packer_tmpdir" ;; esac; ` +
        `${removeCommand}; fi`
    const unregister = registerCleanup(() => {
        if (released) return
        spawnSync('ssh', [env.SSH_TARGET, signalCleanupCommand], {
            stdio: 'ignore',
        })
    })
    let rejectLost: (error: Error) => void = () => undefined
    const lost = new Promise<never>((_resolve, reject) => {
        rejectLost = reject
    })
    // Callers race their leased work against `lost`. Keep a handler attached
    // for the hand-off window and for callers that never wire the race.
    void lost.catch(() => undefined)
    const leaseLost = (detail: string): void => {
        if (released) return
        clearInterval(heartbeat)
        rejectLost(
            new Error(
                `${request.kind} run lease for ${recipe.name} was lost: ${detail}. ` +
                    `Any admission on ${env.SSH_TARGET} sweeps leases idle for over ${RUN_LEASE_STALE_SECS}s ` +
                    `and destroys the VM and temp directories they name, so this run's resources must be presumed gone — aborting.`
            )
        )
    }
    const heartbeatCommand = runLeaseHeartbeatCommand(file)
    const heartbeatState: HeartbeatState = { failures: 0 }
    let heartbeatInFlight = false
    const heartbeat = setInterval(() => {
        // Skip ticks while an attempt is still in flight so one hung SSH
        // connection is not double-counted as several failures.
        if (heartbeatInFlight || released) return
        heartbeatInFlight = true
        void remoteExitCode(env.SSH_TARGET, heartbeatCommand).then(code => {
            heartbeatInFlight = false
            if (released) return
            const verdict = evaluateHeartbeat(heartbeatState, code)
            if (verdict === 'gone') {
                leaseLost(
                    'its file disappeared from the node, so a stale-lease sweep reaped it'
                )
            } else if (verdict === 'lost') {
                leaseLost(
                    `${heartbeatState.failures} consecutive heartbeats failed, so it has not been refreshed within the stale window`
                )
            }
        })
    }, HEARTBEAT_MS)
    heartbeat.unref()

    return {
        id: request.id,
        lost,
        setVmid: async vmid => {
            await captureRemote(
                env.SSH_TARGET,
                `bash -s <<'__CF_LEASE_VMID__'\n${updateLeaseVmidScript(request, vmid)}\n__CF_LEASE_VMID__`
            )
        },
        release: async () => {
            if (released) return
            released = true
            clearInterval(heartbeat)
            unregister()
            await captureRemote(env.SSH_TARGET, removeCommand).catch(() => {})
        },
    }
}
