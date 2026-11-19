import { execa } from 'execa'
import { accent, dim } from '@cofoundry/ui'
import type { Env } from '@/env.ts'
import { log } from '@/log.ts'
import { shellQuote } from '@/util.ts'
import { remotePaths } from '@/build/paths.ts'
import { destroyVmCommand } from '@/build/vm.ts'
import { assetLockPath } from '@/build/prefetch.ts'
import { PACKER_TMP_ROOT } from '@/build/packer.ts'
import { acquireRemoteMaintenanceLock } from '@/build/maintenance.ts'
import type { RecipeInfo } from '@/config.ts'
import {
    OWNED_VMID_DIR,
    RUN_LEASE_DIR,
    RUN_LEASE_LOCK,
    reapLeasesByPrefixScript,
    sweepRunLeasesScript,
} from '@/build/lease.ts'

const LEGACY_WORK_DIR = '/tmp/cofoundry'
const LEGACY_ISO_CACHE = '/var/lib/cofoundry/iso-cache'

// Persistent cache prefetch re-uses across Windows builds. It lives in the ISO
// store under a `packer-` prefix, so the ephemeral-ISO sweep matches it by
// accident; routine prunes must skip it to avoid forcing a ~700MB re-download
// every cycle. A glob, because the filename carries the pinned version
// (packer-virtio-win-<version>.iso) — it also spares the legacy unversioned
// name. See src/build/prefetch.ts.
const VIRTIO_WIN_ISO_GLOB = 'packer-virtio-win*.iso'

export interface PruneOptions {
    days: number
    dryRun: boolean
    /**
     * Reap every lease under this id prefix regardless of age, before the
     * age-gated sweep. Set by a CI cleanup job to clear resources left by its
     * own run after the build process was killed without a chance to release
     * them. See `reapLeasesByPrefixScript`.
     */
    reapLeasePrefix?: string
    /** Recipes whose VMIDs mark a VM or disk as cofoundry's to remove. */
    recipes?: Pick<RecipeInfo, 'buildVmid'>[]
}

const ssh = async (target: string, cmd: string): Promise<string> => {
    const { stdout } = await execa('ssh', [target, cmd], {
        stdin: 'inherit',
        stderr: 'inherit',
    })
    return stdout.trim()
}

const lines = (s: string): string[] =>
    s
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean)

const sizeOrAbsent = (path: string, absentLabel = '(absent)'): string =>
    `if [ -e ${shellQuote(path)} ]; then du -sh ${shellQuote(path)} | cut -f1; else echo ${shellQuote(absentLabel)}; fi`

const remove = async (
    env: Env,
    paths: string[],
    dryRun: boolean
): Promise<void> => {
    if (dryRun) return
    for (const f of paths) {
        await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
    }
}

const report = (label: string, paths: string[], dryRun: boolean): void => {
    if (paths.length === 0) {
        log.info(`${label}: none found`)
        return
    }
    const verb = dryRun ? 'would remove' : 'removed'
    log.ok(`${label} ${dim('·')} ${verb} ${paths.length}`)
    for (const f of paths) log.note(f)
}

// rm -rf each path (directories and symlinks, which `remove`'s rm -f can't take).
const removeDirs = async (
    env: Env,
    paths: string[],
    dryRun: boolean
): Promise<void> => {
    if (dryRun) return
    for (const p of paths) {
        await ssh(env.SSH_TARGET, `rm -rf ${shellQuote(p)}`)
    }
}

// Ephemeral ISOs Packer leaves in the Proxmox ISO store: its answer-file ISOs
// (`packer*.iso[.tmp]`) and SHA-hash-named download-cache copies. `preserveVirtio`
// keeps the persistent virtio-win cache (routine prune), which the `packer*`
// glob would otherwise catch by accident.
export const ephemeralPackerIsoFind = (
    isoStore: string,
    {
        preserveVirtio,
        olderThanDays,
        unreferencedOnly = false,
    }: {
        preserveVirtio: boolean
        olderThanDays?: number
        unreferencedOnly?: boolean
    }
): string =>
    `find ${isoStore} -maxdepth 1 ` +
    (preserveVirtio ? `! -name ${shellQuote(VIRTIO_WIN_ISO_GLOB)} ` : '') +
    `\\( -name 'packer*.iso' -o -name 'packer*.iso.tmp' -o -name 'packer*.iso.tmp.*' ` +
    `-o -regextype posix-extended -regex '.*\/[0-9a-f]{40}\\.iso(\\.tmp(\\.[^/]+)?)?' \\) ` +
    (olderThanDays === undefined ? '' : `-mtime +${olderThanDays} `) +
    (unreferencedOnly
        ? `-print0 2>/dev/null | while IFS= read -r -d '' iso; do ` +
          `base=\${iso##*/}; ref=\${base%.tmp}; ref=\${ref%.tmp.*}; ` +
          `grep -RqsF "iso/$ref" /etc/pve/qemu-server 2>/dev/null || echo "$iso"; done`
        : `-print 2>/dev/null || true`)

export const canonicalPackerIsoPath = (path: string): string =>
    path.replace(/\.tmp(?:\.[^/]+)?$/, '')

// Build VMs are named `packer-<recipe>` (the vm_name in every recipe), so match
// by name rather than a VMID range: per-build VMIDs are slot-derived
// (build_vmid * 100 + slot), which a range match silently misses. The name is
// not proof of ownership, though -- any Packer workflow on the node may name its
// VMs `packer-*` -- so a match must also carry a VMID cofoundry allocated
// (is_cofoundry_vmid). `includeTemplates` controls the one behavioural split
// between prune and clean: routine prune spares `packer-*` templates (a
// successful build leaves one on purpose), while a full `clean` teardown reaps
// them too.
type BuildVmQuery = {
    recipes: Pick<RecipeInfo, 'buildVmid'>[]
    includeTemplates: boolean
    olderThanDays?: number
}

export const findBuildVmsCommand = ({
    recipes,
    includeTemplates,
    olderThanDays,
}: BuildVmQuery): string => {
    // A clean (templates included, no age gate) runs under the exclusive
    // maintenance lock, so no build is live and leases need no check.
    const skipLeased = !(includeTemplates && olderThanDays === undefined)
    return (
        `${isCofoundryVmidFunction(recipes)}\n` +
        (skipLeased
            ? `active=" $(awk -F '\\t' '{printf "%s ", $3}' ${shellQuote(RUN_LEASE_DIR)}/* 2>/dev/null || true)"; `
            : '') +
        `now=$(date +%s); ` +
        `for v in $(qm list 2>/dev/null | awk 'NR>1 && $2 ~ /^packer-/ {print $1}'); do ` +
        `is_cofoundry_vmid "$v" || continue; ` +
        (skipLeased ? `case "$active" in *" $v "*) continue ;; esac; ` : '') +
        (includeTemplates
            ? ''
            : `qm config "$v" 2>/dev/null | grep -q '^template:' && continue; `) +
        (olderThanDays === undefined
            ? ''
            : `modified=$(stat -c %Y "/etc/pve/qemu-server/$v.conf" 2>/dev/null || echo "$now"); ` +
              `[ "$((now - modified))" -gt ${olderThanDays * 86400} ] || continue; `) +
        `echo "$v"; done`
    )
}

const findBuildVms = async (env: Env, query: BuildVmQuery): Promise<string[]> =>
    lines(await ssh(env.SSH_TARGET, findBuildVmsCommand(query)))

const reapBuildVms = async (
    env: Env,
    dryRun: boolean,
    options: BuildVmQuery
): Promise<void> => {
    const orphans = await findBuildVms(env, options)
    if (orphans.length === 0) {
        log.info('build VMs: none found')
        return
    }
    const verb = dryRun ? 'would destroy' : 'destroying'
    for (const vmid of orphans) {
        log.note(`${verb} VM ${vmid}`)
        if (!dryRun) {
            await ssh(
                env.SSH_TARGET,
                destroyVmCommand(Number(vmid), env.CF_STORAGE)
            )
            await ssh(
                env.SSH_TARGET,
                `set -eo pipefail; if qm config ${vmid} >/dev/null 2>&1; then ` +
                    `echo ${shellQuote(`VM ${vmid} still exists after destroy`)} >&2; exit 1; fi; ` +
                    `remaining=$(pvesm list ${shellQuote(env.CF_STORAGE)} --content images 2>/dev/null | ` +
                    `awk -v id=${vmid} 'NR>1 && $NF==id {print $1}'); ` +
                    `[ -z "$remaining" ] || { echo "VM ${vmid} volumes still exist: $remaining" >&2; exit 1; }`
            )
        }
    }
    log.ok(
        `build VMs ${dim('·')} ${dryRun ? 'would destroy' : 'destroyed'} ${orphans.length}`
    )
}

// Disk volumes in the build storage pool whose owning VMID has no VM config —
// leaked when a VM was removed but its disk was not (a dirty teardown, or a
// `qm destroy` that failed after unlinking the config). `qm destroy
// --destroy-unreferenced-disks` never reaches these because the VM it would run
// against is already gone. Emits the volid of every such orphan.
//
// Two guards, because a false positive here frees a live VM's disk:
//
//   1. The config is looked up across the whole cluster, not with `qm config`.
//      `qm` only sees VMs on the node it runs on, and on shared storage (Ceph,
//      NFS) `pvesm list` shows every node's disks — so a peer's running VM
//      looked orphaned. Containers count too: their VMIDs share the space.
//   2. Only VMIDs cofoundry allocated (is_cofoundry_vmid) are candidates.
//      CF_STORAGE is usually the node's main pool, and a disk another tool left
//      behind is not ours to free.
export const orphanDiskFind = (
    storage: string,
    recipes: Pick<RecipeInfo, 'buildVmid'>[]
): string =>
    `set -o pipefail
${isCofoundryVmidFunction(recipes)}
vmid_config_exists() {
    for _c in /etc/pve/nodes/*/qemu-server/"$1".conf /etc/pve/nodes/*/lxc/"$1".conf; do
        [ -e "$_c" ] && return 0
    done
    return 1
}
pvesm list ${shellQuote(storage)} --content images | awk 'NR>1 {print $NF"\t"$1}' | while IFS=$'\t' read -r vmid volid; do
    is_cofoundry_vmid "$vmid" || continue
    vmid_config_exists "$vmid" || echo "$volid"
done`

const freeVolumes = async (
    env: Env,
    volids: string[],
    dryRun: boolean
): Promise<void> => {
    if (dryRun) return
    for (const v of volids) {
        await ssh(env.SSH_TARGET, `pvesm free ${shellQuote(v)}`)
        await ssh(
            env.SSH_TARGET,
            `set -eo pipefail; remaining=$(pvesm list ${shellQuote(env.CF_STORAGE)} --content images | ` +
                `awk -v vol=${shellQuote(v)} 'NR>1 && $1==vol {print $1}'); ` +
                `[ -z "$remaining" ] || { echo ${shellQuote(`volume still exists after free: ${v}`)} >&2; exit 1; }`
        )
    }
}

/**
 * Shell function `is_cofoundry_vmid <vmid>`: succeeds for a VMID cofoundry
 * allocated -- one a build recorded in OWNED_VMID_DIR, a recipe's base VMID,
 * a slot-derived build VMID (base * 100 + slot), or the verify range. Anything
 * that destroys by a weaker test (a name, a storage scan) gates on this, so a
 * VM or disk some other tool owns is never ours to remove.
 */
export const isCofoundryVmidFunction = (
    recipes: Pick<RecipeInfo, 'buildVmid'>[]
): string => {
    const bases = [
        ...new Set(
            recipes
                .map(recipe => recipe.buildVmid)
                .filter((vmid): vmid is number => vmid !== undefined)
        ),
    ].sort((a, b) => a - b)
    const ownedBases = bases.join('|') || '__no_recipe_vmids__'
    return `is_cofoundry_vmid() {
    _cv="$1"
    case "$_cv" in ''|*[!0-9]*) return 1 ;; esac
    [ -f ${shellQuote(OWNED_VMID_DIR)}/"$_cv" ] && return 0
    case "$_cv" in
        ${ownedBases}|9[5-9][0-9][0-9]) return 0 ;;
    esac
    case "$((_cv / 100))" in
        ${ownedBases}) [ "$((_cv % 100))" -lt 50 ] && return 0 ;;
    esac
    return 1
}`
}

const ownedTelemetryCommand = (
    recipes: Pick<RecipeInfo, 'buildVmid'>[],
    remove: boolean
): string => {
    const removeRrd = remove
        ? `
        if [ -S /var/run/rrdcached.sock ]; then
            command -v socat >/dev/null 2>&1 || { echo 'socat is required to clean active RRD telemetry' >&2; exit 1; }
            rel=\${rrd#/var/lib/rrdcached/db/}
            response=$(printf 'FORGET %s\\n' "$rel" | socat - UNIX-CONNECT:/var/run/rrdcached.sock)
            # A "-1 No such file or directory" reply means rrdcached holds no
            # cached writes for this RRD, which is the state FORGET is meant to
            # reach, so treat it as success alongside a normal "0" ack.
            case "$response" in
                0|0' '*) ;;
                -1' 'No' 'such' 'file*) ;;
                *) echo "rrdcached failed to forget $rel: $response" >&2; exit 1 ;;
            esac
        fi
        rm -f -- "$rrd"
        [ ! -e "$rrd" ] || { echo "RRD telemetry still exists: $rrd" >&2; exit 1; }
`
        : ''
    const removeLog = remove
        ? `
    rm -f -- "$logfile"
    [ ! -e "$logfile" ] || { echo "vzdump telemetry still exists: $logfile" >&2; exit 1; }
`
        : ''
    return `
set -euo pipefail
${isCofoundryVmidFunction(recipes)}
for rrd_dir in /var/lib/rrdcached/db/pve-vm-*; do
    [ -d "$rrd_dir" ] || continue
    for rrd in "$rrd_dir"/*; do
        [ -f "$rrd" ] || continue
        vmid=\${rrd##*/}
        is_cofoundry_vmid "$vmid" || continue
        [ ! -e "/etc/pve/qemu-server/$vmid.conf" ] || continue
        ${removeRrd}
        echo "$rrd"
    done
done
for logfile in /var/log/vzdump/qemu-*.log; do
    [ -f "$logfile" ] || continue
    vmid=\${logfile##*/qemu-}; vmid=\${vmid%.log}
    is_cofoundry_vmid "$vmid" || continue
    [ ! -e "/etc/pve/qemu-server/$vmid.conf" ] || continue
    ${removeLog}
    echo "$logfile"
done
`
}

export const ownedTelemetryCleanupCommand = (
    recipes: Pick<RecipeInfo, 'buildVmid'>[]
): string => ownedTelemetryCommand(recipes, true)

export const ownedTelemetryFindCommand = (
    recipes: Pick<RecipeInfo, 'buildVmid'>[]
): string => ownedTelemetryCommand(recipes, false)

export const runClean = async (
    env: Env,
    recipes: Pick<RecipeInfo, 'buildVmid'>[] = []
): Promise<void> => {
    const paths = remotePaths(env)
    log.section(`Clean ${dim('·')} ${accent(env.SSH_TARGET)}`)
    log.step('waiting for active builds and verification')
    const maintenance = await acquireRemoteMaintenanceLock(
        env.SSH_TARGET,
        'exclusive'
    )
    try {
        await Promise.race([
            runCleanLocked(env, paths, recipes),
            maintenance.lost,
        ])
    } finally {
        await maintenance.release()
    }
}

const runCleanLocked = async (
    env: Env,
    paths: ReturnType<typeof remotePaths>,
    recipes: Pick<RecipeInfo, 'buildVmid'>[]
): Promise<void> => {
    await ssh(
        env.SSH_TARGET,
        `set -eo pipefail; test -d ${shellQuote(paths.dump)}; ` +
            `test -d ${shellQuote(paths.isoStore)}; ` +
            `qm list >/dev/null; ` +
            `pvesm list ${shellQuote(env.CF_STORAGE)} --content images >/dev/null`
    )
    await ssh(
        env.SSH_TARGET,
        `for lease in ${shellQuote(RUN_LEASE_DIR)}/*; do ` +
            `[ -f "$lease" ] || continue; ` +
            `IFS=$'\\t' read -r _kind _recipe _vmid _memory _cores tmpdir _preserve _storage packer_tmpdir < "$lease" || true; ` +
            `case "$tmpdir" in */cofoundry-tmp/build-*|*/cofoundry-verify-*) pkill -9 -f -- "$tmpdir" >/dev/null 2>&1 || true ;; esac; ` +
            `done`
    )
    log.step(`removing ${LEGACY_WORK_DIR}`)
    const workSize = await ssh(
        env.SSH_TARGET,
        sizeOrAbsent(LEGACY_WORK_DIR, '(not present)')
    )
    log.info(`working dir was ${workSize}`)
    await ssh(env.SSH_TARGET, `rm -rf ${LEGACY_WORK_DIR}`)

    log.step(`removing uploaded ISOs from ${paths.isoStore}`)
    const isos = lines(
        await ssh(
            env.SSH_TARGET,
            ephemeralPackerIsoFind(paths.isoStore, { preserveVirtio: false })
        )
    )

    if (isos.length === 0) {
        log.info('no uploaded ISOs found')
    } else {
        const removed: string[] = []
        for (const f of isos) {
            const destination = canonicalPackerIsoPath(f)
            const lock = assetLockPath(destination)
            const result = await ssh(
                env.SSH_TARGET,
                `mkdir -p ${shellQuote(lock.replace(/\/[^/]+$/, ''))}; ` +
                    `exec 9>${shellQuote(lock)}; flock -x 9; ` +
                    `if [ -e ${shellQuote(f)} ]; then ` +
                    `size=$(du -sh ${shellQuote(f)} | cut -f1); ` +
                    `rm -f -- ${shellQuote(f)}; printf '%s\\t%s\\n' "$size" ${shellQuote(f)}; fi`
            )
            if (result) removed.push(result)
        }
        log.info(
            `removed ${removed.length} ISO(s)` +
                (removed.length > 0
                    ? ` — ${removed.map(item => item.split('\t')[0]).join(', ')}`
                    : '')
        )
    }

    log.step(`removing Packer download cache from ${paths.downloadedIsoCache}`)
    const downloadedIsoSize = await ssh(
        env.SSH_TARGET,
        sizeOrAbsent(paths.downloadedIsoCache)
    )
    if (downloadedIsoSize === '(absent)') {
        log.info('no Packer download cache found')
    } else {
        await ssh(
            env.SSH_TARGET,
            `rm -rf ${shellQuote(paths.downloadedIsoCache)}`
        )
        log.info(`removed ${paths.downloadedIsoCache} (${downloadedIsoSize})`)
    }

    log.step(`removing legacy ISO cache from ${LEGACY_ISO_CACHE}`)
    const legacyIsoSize = await ssh(
        env.SSH_TARGET,
        sizeOrAbsent(LEGACY_ISO_CACHE)
    )
    if (legacyIsoSize !== '(absent)') {
        await ssh(env.SSH_TARGET, `rm -rf ${shellQuote(LEGACY_ISO_CACHE)}`)
        log.info(`removed ${LEGACY_ISO_CACHE} (${legacyIsoSize})`)
    }

    // Match every VMID, not the legacy 91xx/92xx range: modern builds use
    // slot-derived VMIDs (build_vmid * 100 + slot), whose multi-GB dumps the old
    // globs missed entirely. Clean is a full wipe, so no age gate.
    log.step(`removing stale dump files from ${paths.dump}`)
    const dumps = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${shellQuote(paths.dump)} -maxdepth 1 -name 'vzdump-qemu-*' 2>/dev/null || true`
        )
    )

    if (dumps.length === 0) {
        log.info('no stale dump files found')
    } else {
        for (const f of dumps)
            await ssh(env.SSH_TARGET, `rm -f ${shellQuote(f)}`)
        log.info(`removed ${dumps.length} dump file(s)`)
    }

    log.step(`removing build data from ${paths.dump}`)
    for (const dir of [
        paths.out,
        paths.tmp,
        paths.work,
        paths.snapshots,
        paths.assetCache,
    ]) {
        const sz = await ssh(env.SSH_TARGET, sizeOrAbsent(dir))
        if (sz !== '(absent)') {
            await ssh(env.SSH_TARGET, `rm -rf ${shellQuote(dir)}`)
            log.info(`removed ${dir} (${sz})`)
        }
    }

    const verifyDirs = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${shellQuote(paths.dump)} -mindepth 1 -maxdepth 1 -type d -name 'cofoundry-verify-*' 2>/dev/null || true`
        )
    )
    await removeDirs(env, verifyDirs, false)
    report('verify scratch', verifyDirs, false)

    // Half-swapped work symlinks (`cofoundry-work.new.<pid>`) are siblings of
    // `cofoundry-work`, so the directory wipe above never touches them. A dirty
    // teardown mid-`mv` leaves one behind.
    log.step('removing orphaned work links')
    const workLinks = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${shellQuote(paths.dump)} -maxdepth 1 -name ${shellQuote(`${paths.work.split('/').pop()}.new.*`)} 2>/dev/null || true`
        )
    )
    await removeDirs(env, workLinks, false)
    report('orphaned work links', workLinks, false)

    // Destroy every `packer-*` build VM, templates included: `clean` is a full
    // teardown, so a leftover build template is a leftover like any other. Their
    // disks live in the VM storage pool (not $PVE_DUMP_DIR) and go with them.
    log.step('build VMs (packer-*, including templates)')
    await reapBuildVms(env, false, { recipes, includeTemplates: true })

    // Sweep disks orphaned in the storage pool — those whose owning VM is already
    // gone, which the VM reap above (and its --destroy-unreferenced-disks) can
    // never reach. Runs after the reap so freshly-purged disks are already gone.
    log.step(`orphaned disks in ${env.CF_STORAGE} (no owning VM)`)
    const orphanDisks = lines(
        await ssh(env.SSH_TARGET, orphanDiskFind(env.CF_STORAGE, recipes))
    )
    await freeVolumes(env, orphanDisks, false)
    report('orphaned disks', orphanDisks, false)

    log.step('removing Cofoundry VM telemetry')
    const telemetry = lines(
        await ssh(env.SSH_TARGET, ownedTelemetryCleanupCommand(recipes))
    )
    report('VM telemetry', telemetry, false)
    const remainingTelemetry = lines(
        await ssh(env.SSH_TARGET, ownedTelemetryFindCommand(recipes))
    )

    log.step('removing Cofoundry lease and reservation state')
    await ssh(
        env.SSH_TARGET,
        `rm -rf ${shellQuote(RUN_LEASE_DIR)} ${shellQuote(OWNED_VMID_DIR)} ${shellQuote(PACKER_TMP_ROOT)} /var/lib/cofoundry/verify-reservations /var/lib/cofoundry/netslots /var/lib/cofoundry/asset-locks /run/cofoundry-diag; ` +
            `rm -f ${shellQuote(RUN_LEASE_LOCK)} /var/lib/cofoundry/verify.lock /var/lib/cofoundry/netslot.lock /var/lib/cofoundry/packer-init.lock; ` +
            `rm -f /etc/dnsmasq.d/cofoundry-hosts.d/slot-*; ` +
            `(systemctl reload dnsmasq 2>/dev/null || systemctl restart dnsmasq) >/dev/null 2>&1 || true`
    )

    const remainingIsos = lines(
        await ssh(
            env.SSH_TARGET,
            ephemeralPackerIsoFind(paths.isoStore, { preserveVirtio: false })
        )
    )
    const remainingVms = await findBuildVms(env, {
        recipes,
        includeTemplates: true,
    })
    const remainingDisks = lines(
        await ssh(env.SSH_TARGET, orphanDiskFind(env.CF_STORAGE, recipes))
    )
    const remainingPaths = lines(
        await ssh(
            env.SSH_TARGET,
            `for p in ${[
                LEGACY_WORK_DIR,
                LEGACY_ISO_CACHE,
                paths.out,
                paths.tmp,
                paths.work,
                paths.snapshots,
                paths.assetCache,
                paths.downloadedIsoCache,
                PACKER_TMP_ROOT,
                RUN_LEASE_DIR,
                OWNED_VMID_DIR,
                '/var/lib/cofoundry/verify-reservations',
                '/var/lib/cofoundry/netslots',
                '/var/lib/cofoundry/asset-locks',
                '/run/cofoundry-diag',
                RUN_LEASE_LOCK,
                '/var/lib/cofoundry/verify.lock',
                '/var/lib/cofoundry/netslot.lock',
                '/var/lib/cofoundry/packer-init.lock',
            ]
                .map(shellQuote)
                .join(' ')}; do [ ! -e "$p" ] || echo "$p"; done`
        )
    )
    const remainingSlots = lines(
        await ssh(
            env.SSH_TARGET,
            `find /etc/dnsmasq.d/cofoundry-hosts.d -maxdepth 1 -name 'slot-*' -print 2>/dev/null || true`
        )
    )
    const remainingDumpResidue = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${shellQuote(paths.dump)} -maxdepth 1 ` +
                `\\( -name 'vzdump-qemu-*' -o -name 'cofoundry-verify-*' -o ` +
                `-name ${shellQuote(`${paths.work.split('/').pop()}.new.*`)} \\) -print 2>/dev/null || true`
        )
    )
    const leftovers = [
        ...remainingIsos,
        ...remainingVms.map(vmid => `VM ${vmid}`),
        ...remainingDisks,
        ...remainingPaths,
        ...remainingSlots,
        ...remainingDumpResidue,
        ...remainingTelemetry,
    ]
    if (leftovers.length > 0) {
        throw new Error(
            `clean verification failed; resources remain:\n${leftovers.join('\n')}`
        )
    }

    log.blank()
    log.ok('Clean complete.')
}

/**
 * Folds the cleanup work that previously lived in a separate weekly cron
 * (`docs/setup.md` § "Weekly cleanup cron") into the CLI so CI can call it
 * after every build. With --dry-run, enumerates targets without deleting.
 */
export const runPrune = async (
    env: Env,
    { days, dryRun, reapLeasePrefix, recipes = [] }: PruneOptions
): Promise<void> => {
    log.section(`Prune ${dim('·')} ${accent(env.SSH_TARGET)}`)
    const maintenance = await acquireRemoteMaintenanceLock(
        env.SSH_TARGET,
        'shared'
    )
    try {
        await Promise.race([
            runPruneLocked(env, { days, dryRun, reapLeasePrefix, recipes }),
            maintenance.lost,
        ])
    } finally {
        await maintenance.release()
    }
}

const runPruneLocked = async (
    env: Env,
    { days, dryRun, reapLeasePrefix, recipes = [] }: PruneOptions
): Promise<void> => {
    const paths = remotePaths(env)
    if (dryRun) log.warn('dry-run: no files will be deleted')

    // A stale heartbeat is the only evidence that authorizes immediate cleanup
    // of a run's VM and private scratch. Active lease VMIDs remain protected by
    // the age-gated legacy sweep below.
    if (!dryRun) {
        // The targeted reap runs first and ignores age: it names one run, whose
        // orchestrator is known dead, so waiting out the stale window would only
        // leave its VM burning node capacity.
        const reap = reapLeasePrefix
            ? reapLeasesByPrefixScript(reapLeasePrefix)
            : ''
        if (reap) log.step(`reaping leases for run ${reapLeasePrefix}`)
        await ssh(
            env.SSH_TARGET,
            `mkdir -p ${shellQuote(RUN_LEASE_DIR)}; exec 9>${shellQuote(RUN_LEASE_LOCK)}; flock -x 9; ${reap}${sweepRunLeasesScript()}`
        )
    }

    // 1. Old, unreferenced Packer ISOs. Prefetch touches a cache hit, downloads
    // under a destination lock, and VMs reference attached media in their config;
    // all three checks prevent pruning a live build's media.
    log.step('ephemeral Packer ISOs in Proxmox ISO storage')
    const isoCandidates = lines(
        await ssh(
            env.SSH_TARGET,
            ephemeralPackerIsoFind(paths.isoStore, {
                preserveVirtio: true,
                olderThanDays: days,
                unreferencedOnly: true,
            })
        )
    )
    const packerIsos: string[] = []
    if (dryRun) {
        packerIsos.push(...isoCandidates)
    } else {
        for (const iso of isoCandidates) {
            const destination = canonicalPackerIsoPath(iso)
            const base = destination.split('/').pop() ?? ''
            const lock = assetLockPath(destination)
            const removed = await ssh(
                env.SSH_TARGET,
                `mkdir -p ${shellQuote(lock.replace(/\/[^/]+$/, ''))}; exec 9>${shellQuote(lock)}; flock -x 9; ` +
                    `if find ${shellQuote(iso)} -maxdepth 0 -mtime +${days} -print -quit 2>/dev/null | grep -q . ` +
                    `&& ! grep -RqsF ${shellQuote(`iso/${base}`)} /etc/pve/qemu-server 2>/dev/null; then ` +
                    `rm -f ${shellQuote(iso)}; echo ${shellQuote(iso)}; fi`
            )
            if (removed) packerIsos.push(removed)
        }
    }
    report('ephemeral Packer ISOs', packerIsos, dryRun)

    // 2. Packer's local ISO download cache. These are hash-named staging files
    // under /root, separate from the final ISO storage pool copies.
    log.step(`Packer download cache in ${paths.downloadedIsoCache}`)
    const downloadedIsos = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.downloadedIsoCache} -maxdepth 1 \\( -name '*.iso' -o -name '*.iso.lock' \\) -mtime +${days} 2>/dev/null || true`
        )
    )
    await remove(env, downloadedIsos, dryRun)
    report('Packer download cache', downloadedIsos, dryRun)

    // 3. Stale vzdump archives in the dump dir older than --days.
    // Match every VMID because installer builds use slot-derived IDs. Any dump
    // that failed to move to the artifact directory is eligible by age.
    log.step(`stale vzdump archives in ${paths.dump} older than ${days} day(s)`)
    const oldDumps = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.dump} -maxdepth 1 -name 'vzdump-qemu-*' -mtime +${days} 2>/dev/null || true`
        )
    )
    await remove(env, oldDumps, dryRun)
    report('stale vzdump archives', oldDumps, dryRun)

    // 4. Orphaned build VMs. Every build VM is named `packer-<recipe>` (the
    // vm_name in every recipe), so match by name rather than a VMID range. The
    // old range match (`9[12]xx`) silently missed the per-build VMID scheme
    // (build_vmid base * 100 + slot, e.g. 600201), so cancelled/killed builds
    // leaked VMs that nothing ever reaped. Exclude templates: a successful
    // build destroys its VM after vzdump, so a lingering `packer-*` template is
    // an intentional artifact we must not delete.
    log.step('orphaned build VMs (packer-*, excluding templates)')
    await reapBuildVms(env, dryRun, {
        recipes,
        includeTemplates: false,
        olderThanDays: days,
    })

    // 5. Orphaned per-build repo scratch in cofoundry-tmp: writable repo copies
    // (`build-*`), upload tarballs (`repo-*.tar.gz`), and download staging
    // (`sync-*`). Each build removes its own in a finally/SIGINT handler, but a
    // dirty teardown (SIGKILL/OOM/host reboot) leaks it. Age-gated so a
    // concurrent build's active scratch (fresh mtime) is never swept.
    log.step(`stale build scratch in ${paths.tmp} older than ${days} day(s)`)
    const staleScratch = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${shellQuote(paths.tmp)} -mindepth 1 -maxdepth 1 \\( -name 'build-*' -o -name 'repo-*.tar.gz' -o -name 'sync-*' \\) -mtime +${days} 2>/dev/null || true`
        )
    )
    await removeDirs(env, staleScratch, dryRun)
    report('stale build scratch', staleScratch, dryRun)

    const staleVerify = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${shellQuote(paths.dump)} -mindepth 1 -maxdepth 1 -type d -name 'cofoundry-verify-*' -mtime +${days} 2>/dev/null || true`
        )
    )
    await removeDirs(env, staleVerify, dryRun)
    report('stale verify scratch', staleVerify, dryRun)

    // 6. Content-addressed repository snapshots older than --days. Keep the
    // snapshot selected by the stable work symlink even if it is old.
    log.step(`repository snapshots older than ${days} day(s)`)
    const oldSnapshots = lines(
        await ssh(
            env.SSH_TARGET,
            `current=$(readlink -f ${shellQuote(paths.work)} 2>/dev/null || true); ` +
                `find ${shellQuote(paths.snapshots)} -mindepth 1 -maxdepth 1 -type d -mtime +${days} 2>/dev/null | ` +
                `while IFS= read -r snapshot; do [ "$snapshot" = "$current" ] || echo "$snapshot"; done`
        )
    )
    if (!dryRun) {
        for (const snapshot of oldSnapshots) {
            await ssh(env.SSH_TARGET, `rm -rf ${shellQuote(snapshot)}`)
        }
    }
    report('repository snapshots', oldSnapshots, dryRun)

    // 7. Half-swapped work links (`cofoundry-work.new.<pid>`) orphaned when a
    // dirty teardown interrupts the snapshot install's atomic `mv`. They sit
    // beside the work dir, so the step below (which only touches work itself)
    // never reaps them.
    log.step('orphaned work links')
    const workLinks = lines(
        await ssh(
            env.SSH_TARGET,
            `find ${paths.dump} -maxdepth 1 -name ${shellQuote(`${paths.work.split('/').pop()}.new.*`)} -mtime +${days} 2>/dev/null || true`
        )
    )
    await removeDirs(env, workLinks, dryRun)
    report('orphaned work links', workLinks, dryRun)

    // 8. The current link is tiny and may be needed between two SSH operations.
    // Keep valid links; only a dangling link is garbage.
    log.step(`working dir ${paths.work}`)
    const dangling =
        (await ssh(
            env.SSH_TARGET,
            `[ -L ${shellQuote(paths.work)} ] && [ ! -e ${shellQuote(paths.work)} ] && echo 1 || echo 0`
        )) === '1'
    if (dangling && !dryRun)
        await ssh(env.SSH_TARGET, `rm -f ${shellQuote(paths.work)}`)
    log.info(
        dangling
            ? `${paths.work}: ${dryRun ? 'would remove dangling link' : 'removed dangling link'}`
            : `${paths.work}: retained`
    )

    log.blank()
    log.ok(dryRun ? 'Prune dry-run complete.' : 'Prune complete.')
}
