import { statfsSync, accessSync, existsSync, constants } from 'node:fs'
import { readFile, readlink, readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { fmtBytes, dim, accent } from '@cofoundry/ui'
import { templateSize, type Template } from '@/registry/schema.ts'
import { TEMP_ROOT } from './download.ts'
import type { InstallItem } from './types.ts'

/**
 * Checks that run before the first byte is downloaded.
 *
 * Every failure here is one Proxmox would otherwise raise from `qm create` —
 * that is, after a multi-gigabyte download has already finished. The canonical
 * one is a storage without the `images` content type: the default `local` on a
 * fresh node carries `iso,vztmpl,backup`, so a run that picks it downloads
 * everything and then fails per template with "storage 'local' does not
 * support vm images".
 *
 * Two rules keep this honest, both borrowed from `takenVmids`:
 *
 *   - A check whose input is unavailable fails **open** — warn and continue.
 *     A probe that cannot run is not evidence of a problem.
 *   - A check whose input says the install cannot work fails **closed**.
 *
 * Anything whose answer depends on the storage backend's allocation policy is
 * a warning unless the backend makes it certain; see `storageDemand`.
 */

export type Severity = 'error' | 'warning'

export interface Finding {
    severity: Severity
    message: string
}

const err = (message: string): Finding => ({ severity: 'error', message })
const warn = (message: string): Finding => ({ severity: 'warning', message })

const KIB = 1024
const MIB = 1024 * 1024

/**
 * Fixed-size volumes `qm create` allocates that no image supplies: the
 * cloud-init drive (always) and the TPM state (when the profile asks for one).
 * Both are 4 MiB in Proxmox.
 */
const CLOUDINIT_BYTES = 4 * MIB
const TPM_BYTES = 4 * MIB

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** One row of `pvesm status`. Sizes are bytes; pvesm reports KiB. */
export interface StorageStatus {
    name: string
    type: string
    status: string
    active: boolean
    availableBytes: number
}

/** What the local node offers, as probed once per run. */
export interface NodeStorages {
    /** Every configured storage visible to this node, by name. */
    all: Map<string, StorageStatus>
    /** Those whose content types include `images`. */
    imageCapable: Set<string>
}

/**
 * Backends that allocate a volume's full virtual size up front. Plain LVM
 * carves out every extent at creation, so a 30G image needs 30G free however
 * little of it is written — the one case where the virtual size, not the
 * downloaded size, is the number that must fit.
 */
const THICK_TYPES: ReadonlySet<string> = new Set(['lvm'])

/**
 * Backends that can store a volume in less space than its data occupies, via
 * transparent compression or dedup. Their free-space shortfalls are reported
 * as warnings: the arithmetic that says "this will not fit" does not hold when
 * the filesystem may halve the bytes on the way down.
 */
const COMPRESSING_TYPES: ReadonlySet<string> = new Set([
    'zfspool',
    'zfs',
    'btrfs',
])

/**
 * Parse `pvesm status` (with or without `--content images`):
 *
 *     Name    Type   Status  Total (KiB)  Used (KiB)  Available (KiB)      %
 *     local    dir   active     220284968    47402860        163203624  21.52%
 *
 * PVE 9.1 labels the size columns `Total (KiB)` and older releases just
 * `Total`, so the header is skipped by its first field rather than by row
 * index or column count — a node that prints a banner line cannot shift a real
 * row out of the table either way. Rows that do not
 * carry the full six columns are dropped: a half-parsed row would be worse
 * than an absent one, since a missing storage is reported as a hard error.
 */
export const parsePvesmStatus = (
    stdout: string
): Map<string, StorageStatus> => {
    const rows = new Map<string, StorageStatus>()
    for (const line of stdout.split('\n')) {
        const cols = line.trim().split(/\s+/)
        if (cols.length < 6) continue
        const [name, type, status, , , available] = cols as [
            string,
            string,
            string,
            string,
            string,
            string,
        ]
        if (name === 'Name') continue
        if (!/^\d+$/.test(available)) continue
        rows.set(name, {
            name,
            type,
            status,
            active: status === 'active',
            availableBytes: Number(available) * KIB,
        })
    }
    return rows
}

/**
 * `pvesm status` stats every configured storage, so one unreachable NFS/CIFS
 * mount can stall it. Cap the wait and fail open: a preflight that hangs is
 * worse than one that does not run.
 */
const PVESM_TIMEOUT_MS = 20_000

const capture = async (
    argv: string[],
    timeout: number
): Promise<string | undefined> => {
    try {
        const proc = Bun.spawn(argv, {
            stdout: 'pipe',
            stderr: 'ignore',
            timeout,
        })
        const out = await new Response(proc.stdout).text()
        if ((await proc.exited) !== 0) return undefined
        return out
    } catch {
        return undefined // binary absent: not a Proxmox node, or not on PATH
    }
}

/**
 * The node's storage table, probed once per run — it cannot change under us,
 * and both the storage prompt and the preflight want the same answer.
 *
 * Fails open: undefined means `pvesm` could not be run, and callers skip the
 * storage checks rather than blocking an install on a probe that never ran.
 */
let probe: Promise<NodeStorages | undefined> | undefined

export const probeStorages = async (): Promise<NodeStorages | undefined> => {
    probe ??= (async () => {
        const [allOut, imagesOut] = await Promise.all([
            capture(['pvesm', 'status'], PVESM_TIMEOUT_MS),
            capture(
                ['pvesm', 'status', '--content', 'images'],
                PVESM_TIMEOUT_MS
            ),
        ])
        if (allOut === undefined) return undefined
        const all = parsePvesmStatus(allOut)
        if (all.size === 0) return undefined
        return {
            all,
            imageCapable: new Set(parsePvesmStatus(imagesOut ?? '').keys()),
        }
    })()
    return probe
}

/** Test seam: replace or clear the memoised probe. */
export const setProbedStorages = (node: NodeStorages | undefined): void => {
    probe = Promise.resolve(node)
}

/** Storages a template can actually be imported into, roomiest first. */
export const usableStorages = (node: NodeStorages): StorageStatus[] =>
    [...node.all.values()]
        .filter(s => node.imageCapable.has(s.name) && s.active)
        .sort((a, b) => b.availableBytes - a.availableBytes)

const suggest = (node: NodeStorages): string => {
    const usable = usableStorages(node)
    if (usable.length === 0) {
        return (
            'No storage on this node accepts VM images. Add the "Disk image" ' +
            'content type to one in Datacenter → Storage, or create a storage ' +
            'that supports it (lvmthin, zfspool, dir, …).'
        )
    }
    const list = usable
        .map(s => `${s.name} (${s.type}, ${fmtBytes(s.availableBytes)} free)`)
        .join(', ')
    return `Storages on this node that accept VM images: ${list}.`
}

/**
 * Why `storage` cannot hold an imported template, or undefined if it can.
 * Pure so the message wording is testable without a Proxmox node.
 */
export const storageProblem = (
    storage: string,
    node: NodeStorages
): string | undefined => {
    const row = node.all.get(storage)
    if (!row) {
        return (
            `No storage named "${storage}" is configured on this node ` +
            `(\`pvesm status\` does not list it). ${suggest(node)}`
        )
    }
    if (!node.imageCapable.has(storage)) {
        return (
            `Storage "${storage}" (type ${row.type}) does not support VM images — ` +
            `its content types do not include \`images\`, so \`qm create\` would ` +
            `fail with "storage '${storage}' does not support vm images" after ` +
            `every download finished. Either add the "Disk image" content type ` +
            `to it (Datacenter → Storage → ${storage} → Content) or pick another ` +
            `storage. ${suggest(node)}`
        )
    }
    if (!row.active) {
        return (
            `Storage "${storage}" is ${row.status}, not active — \`qm create\` ` +
            `cannot allocate on it. Bring it online, or pick another storage. ` +
            `${suggest(node)}`
        )
    }
    return undefined
}

/**
 * A `virtual_size` as the registry publishes it — `30G`, `8192M`, or a bare
 * byte count. Binary units, matching `qm`/`qemu-img`. Undefined when the
 * string is absent or in a shape we do not recognise, so callers fall back to
 * the on-wire size rather than inventing a number.
 */
export const parseVirtualSize = (raw?: string): number | undefined => {
    if (!raw) return undefined
    const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGTP]?)i?B?\s*$/i.exec(raw)
    if (!m) return undefined
    const scale: Record<string, number> = {
        '': 1,
        'K': KIB,
        'M': MIB,
        'G': MIB * KIB,
        'T': MIB * MIB,
        'P': MIB * MIB * KIB,
    }
    return Math.round(Number(m[1]) * scale[m[2]!.toUpperCase()]!)
}

export interface StorageDemand {
    /**
     * Bytes on the wire — a floor, and only a floor. Artifacts are published
     * with `qemu-img convert -c` (recipes/_shared/post/export-disks.sh), so
     * every image is a *compressed* qcow2 that the import decompresses: a
     * 622 MB Debian download lands as 1.8 GB on the storage. The registry does
     * not publish the expanded size, so the real cost is unknowable from here
     * and sits somewhere in this range.
     */
    download: number
    /**
     * The disks' full virtual size — the ceiling, and exactly what a thick
     * allocator reserves on day one.
     */
    virtual: number
}

/**
 * What installing `templates` costs one storage, bounded both ways.
 *
 * The gap is not academic: a Windows template is a 7.5 GB download declaring a
 * 30 GiB disk. Plain LVM takes the latter at create time; a sparse backend
 * takes whatever the images decompress to, which is neither number.
 */
export const storageDemand = (templates: Template[]): StorageDemand => {
    let download = 0
    let virtual = 0
    for (const template of templates) {
        for (const disk of template.disks) {
            download += disk.size
            virtual += parseVirtualSize(disk.virtual_size) ?? disk.size
        }
        const extras = CLOUDINIT_BYTES + (template.hardware.tpm ? TPM_BYTES : 0)
        download += extras
        virtual += extras
    }
    return { download, virtual }
}

/** Storage existence, content type, liveness, and capacity for one plan. */
export const checkStorages = (
    items: InstallItem[],
    node: NodeStorages
): Finding[] => {
    const findings: Finding[] = []
    for (const storage of new Set(items.map(i => i.storage))) {
        const problem = storageProblem(storage, node)
        if (problem) {
            findings.push(err(problem))
            continue
        }
        const row = node.all.get(storage)!
        const demand = storageDemand(
            items.filter(i => i.storage === storage).map(i => i.template)
        )
        const free = fmtBytes(row.availableBytes)

        // Thick backends are the certain case: the whole virtual size is
        // reserved at create time, whatever the images actually contain.
        if (THICK_TYPES.has(row.type)) {
            if (row.availableBytes < demand.virtual) {
                findings.push(
                    err(
                        `Storage "${storage}" has ${free} free but this install needs ` +
                            `${fmtBytes(demand.virtual)} — ${row.type} reserves each disk's ` +
                            `full virtual size at creation, not the ` +
                            `${fmtBytes(demand.download)} being downloaded. Free space, or ` +
                            `install into a larger storage.`
                    )
                )
            }
            continue
        }

        // Sparse backends take what the images decompress to: more than the
        // download, less than the virtual size, and not a number the registry
        // publishes. Refuse below the floor; flag the range above it.
        if (row.availableBytes < demand.download) {
            const detail =
                `Storage "${storage}" has ${free} free, less than the ` +
                `${fmtBytes(demand.download)} of compressed images this install ` +
                `downloads — and they expand on import.`
            findings.push(
                COMPRESSING_TYPES.has(row.type)
                    ? warn(
                          `${detail} ${row.type} may compress them back down, so this ` +
                              `is a warning rather than a refusal, but the import can ` +
                              `still run out of space.`
                      )
                    : err(`${detail} Free space, or use a larger storage.`)
            )
            continue
        }
        if (row.availableBytes < demand.virtual) {
            findings.push(
                warn(
                    `Storage "${storage}" has ${free} free. The images download as ` +
                        `${fmtBytes(demand.download)} of compressed qcow2 and decompress ` +
                        `on import — up to ${fmtBytes(demand.virtual)} if the disks are ` +
                        `full. ${row.type} allocates sparsely so it will likely fit, but ` +
                        `the volume can run out as the guests write.`
                )
            )
        }
    }
    return findings
}

// ---------------------------------------------------------------------------
// Node tooling
// ---------------------------------------------------------------------------

export interface Tooling {
    /** `qm` resolves on PATH. */
    qm: boolean
    /** `pvesm` resolves on PATH. */
    pvesm: boolean
    /** Effective uid is 0. */
    root: boolean
}

export const probeTooling = async (): Promise<Tooling> => ({
    qm: Bun.which('qm') !== null,
    pvesm: Bun.which('pvesm') !== null,
    root: process.getuid?.() === 0,
})

/**
 * coport drives `qm` directly, so the two ways it can be run wrong — off a
 * Proxmox node, or as a non-root user — are worth naming before a download
 * rather than letting `qm` fail per template afterwards.
 */
export const checkTooling = (tooling: Tooling): Finding[] => {
    const findings: Finding[] = []
    if (!tooling.qm) {
        findings.push(
            err(
                '`qm` was not found on PATH. coport builds templates by calling ' +
                    'qm directly, so it has to run on the Proxmox node itself, not ' +
                    'from a workstation.'
            )
        )
    }
    if (!tooling.root) {
        findings.push(
            err(
                'coport is not running as root. `qm create` and `qm destroy` need ' +
                    'root on a Proxmox node; re-run with sudo.'
            )
        )
    }
    if (tooling.qm && !tooling.pvesm) {
        findings.push(
            warn(
                '`pvesm` was not found on PATH — skipping the storage checks. A ' +
                    'storage that cannot hold VM images will only fail at import time.'
            )
        )
    }
    return findings
}

// ---------------------------------------------------------------------------
// VMIDs and overwrite targets
// ---------------------------------------------------------------------------

const PVE_DIR = '/etc/pve'
const RUN_DIR = '/run/qemu-server'

/** `qm create`'s accepted VMID range. */
export const MIN_VMID = 100
export const MAX_VMID = 999_999_999

export interface GuestLocation {
    vmid: number
    /** Node whose config directory holds it. */
    node: string
    kind: 'qemu' | 'lxc'
    /** Value of the config's `lock:` line, if any. */
    lock?: string
    running: boolean
}

/**
 * The local node's name, from the `/etc/pve/local` symlink into `nodes/<name>`.
 * Undefined when pmxcfs is not mounted, which makes every guest look remote —
 * so callers treat undefined as "cannot tell" and skip the ownership check.
 */
export const localNodeName = async (
    pveDir = PVE_DIR
): Promise<string | undefined> => {
    try {
        return basename(await readlink(`${pveDir}/local`))
    } catch {
        return undefined
    }
}

const readLock = async (path: string): Promise<string | undefined> => {
    try {
        const m = /^lock:\s*(\S+)/m.exec(await readFile(path, 'utf8'))
        return m?.[1]
    } catch {
        return undefined
    }
}

/**
 * Find which node owns `vmid` and whether it is running. Scans every node's
 * config directory, not just the local symlinks, because a VMID that belongs
 * to another node is precisely the case `qm destroy` cannot handle.
 */
export const probeGuest = async (
    vmid: number,
    pveDir = PVE_DIR,
    runDir = RUN_DIR
): Promise<GuestLocation | undefined> => {
    let nodes: string[]
    try {
        nodes = await readdir(`${pveDir}/nodes`)
    } catch {
        return undefined
    }
    for (const node of nodes) {
        for (const kind of ['qemu', 'lxc'] as const) {
            const dir = kind === 'qemu' ? 'qemu-server' : 'lxc'
            const path = `${pveDir}/nodes/${node}/${dir}/${vmid}.conf`
            if (!existsSync(path)) continue
            return {
                vmid,
                node,
                kind,
                lock: await readLock(path),
                running: existsSync(`${runDir}/${vmid}.pid`),
            }
        }
    }
    return undefined
}

/**
 * Validate the VMIDs the plan will create, and every occupant `--overwrite`
 * intends to replace.
 *
 * The overwrite path is the one that bites: `installTemplate` runs `qm destroy`
 * best-effort and ignores its exit code, so a destroy that Proxmox refuses —
 * the guest is running, locked, a container, or owned by another node — is
 * silent, and the run instead dies at `qm create` with "VM N already exists"
 * once the image is on disk.
 */
export const checkVmids = (
    items: InstallItem[],
    guests: Map<number, GuestLocation>,
    localNode: string | undefined
): Finding[] => {
    const findings: Finding[] = []
    for (const item of items) {
        const { vmid } = item
        const label = item.template.display
        if (!Number.isInteger(vmid) || vmid < MIN_VMID || vmid > MAX_VMID) {
            findings.push(
                err(
                    `${label}: VMID ${vmid} is outside the range Proxmox accepts ` +
                        `(${MIN_VMID}–${MAX_VMID}). Check --vmid-start.`
                )
            )
            continue
        }
        if (!item.overwrite) continue
        const guest = guests.get(vmid)
        if (!guest) continue // nothing there to destroy; create will just work
        if (guest.kind === 'lxc') {
            findings.push(
                err(
                    `${label}: VMID ${vmid} belongs to an LXC container, which ` +
                        `\`qm destroy\` cannot remove. Pick another VMID, or delete ` +
                        `the container with \`pct destroy ${vmid}\` first.`
                )
            )
            continue
        }
        if (localNode && guest.node !== localNode) {
            findings.push(
                err(
                    `${label}: VMID ${vmid} is a VM on node "${guest.node}", not this ` +
                        `one — coport can only replace guests on the node it runs on. ` +
                        `Pick another VMID, or run coport on ${guest.node}.`
                )
            )
            continue
        }
        if (guest.running) {
            findings.push(
                err(
                    `${label}: VMID ${vmid} is running, so --overwrite cannot destroy ` +
                        `it and the create would fail with "VM ${vmid} already exists". ` +
                        `Stop it first: \`qm stop ${vmid}\`.`
                )
            )
            continue
        }
        if (guest.lock) {
            findings.push(
                err(
                    `${label}: VMID ${vmid} is locked (${guest.lock}), so --overwrite ` +
                        `cannot destroy it. Wait for the operation to finish, or clear ` +
                        `it with \`qm unlock ${vmid}\`.`
                )
            )
        }
    }
    return findings
}

// ---------------------------------------------------------------------------
// Temp space
// ---------------------------------------------------------------------------

/** Free bytes on the filesystem holding `path`, or its nearest existing parent. */
export const freeBytes = (path: string): number | undefined => {
    for (let dir = path; ; dir = dirname(dir)) {
        try {
            const fs = statfsSync(dir)
            return Number(fs.bsize) * Number(fs.bavail)
        } catch {
            const parent = dirname(dir)
            if (parent === dir) return undefined
        }
    }
}

/** Whether the temp root, or the nearest existing parent we would create it under, is writable. */
export const isWritable = (path: string): boolean => {
    for (let dir = path; ; dir = dirname(dir)) {
        try {
            accessSync(dir, constants.W_OK)
            return true
        } catch {
            const parent = dirname(dir)
            // A path that exists but is not writable is a definite no; keep
            // walking only while the failure is "not there yet".
            if (existsSync(dir) || parent === dir) return false
        }
    }
}

/**
 * Peak bytes resident in the temp directory at once.
 *
 * Images are deleted as their import finishes or fails, so the ceiling is not
 * the whole batch: it is the largest few, bounded by how many can be in flight
 * — downloading, or downloaded and waiting on the import semaphore.
 */
export const peakTempBytes = (
    sizes: number[],
    downloadLimit: number,
    installLimit: number
): number =>
    [...sizes]
        .sort((a, b) => b - a)
        .slice(0, Math.max(1, downloadLimit) + Math.max(1, installLimit))
        .reduce((total, n) => total + n, 0)

/**
 * Room for the downloads themselves. Exact, unlike the storage estimate: these
 * are the very bytes about to be written, so a batch whose largest single
 * image does not fit is an error rather than a warning.
 */
export const checkTemp = (
    sizes: number[],
    tempRoot: string,
    free: number | undefined,
    writable: boolean,
    downloadLimit: number,
    installLimit: number
): Finding[] => {
    const findings: Finding[] = []
    if (!writable) {
        findings.push(
            err(
                `${tempRoot} is not writable. Images are downloaded there before ` +
                    `import; create it, or fix its permissions.`
            )
        )
    }
    if (free === undefined || sizes.length === 0) return findings

    const largest = Math.max(...sizes)
    const peak = peakTempBytes(sizes, downloadLimit, installLimit)
    if (free < largest) {
        findings.push(
            err(
                `Only ${fmtBytes(free)} free on ${tempRoot}, but the largest image ` +
                    `is ${fmtBytes(largest)}. Downloads land there before import — ` +
                    `free space, or point the node's /var/lib/vz at a larger volume.`
            )
        )
    } else if (free < peak) {
        findings.push(
            warn(
                `${fmtBytes(free)} free on ${tempRoot}; this run can hold up to ` +
                    `${fmtBytes(peak)} of images at once. Lower ` +
                    `--download-concurrency to reduce the peak.`
            )
        )
    }
    return findings
}

// ---------------------------------------------------------------------------
// Network bridge
// ---------------------------------------------------------------------------

export const probeBridges = async (): Promise<Set<string> | undefined> => {
    try {
        return new Set(await readdir('/sys/class/net'))
    } catch {
        return undefined
    }
}

/**
 * A bridge Proxmox cannot find is not a create-time error — it is caught when
 * a clone is started, long after coport has exited — so this only warns. It is
 * still worth saying now: every template installed by the run carries it.
 */
export const checkBridge = (
    bridge: string,
    interfaces: Set<string> | undefined
): Finding[] =>
    !interfaces || interfaces.has(bridge)
        ? []
        : [
              warn(
                  `Bridge "${bridge}" does not exist on this node. The templates will ` +
                      `install, but a clone will refuse to start until its NIC points at ` +
                      `a real bridge. Existing: ${[...interfaces].filter(n => n.startsWith('vmbr')).join(', ') || 'none named vmbr*'}. ` +
                      `Set one with --bridge or COPORT_BRIDGE.`
              ),
          ]

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

const HEAD_TIMEOUT_MS = 10_000

export interface ArtifactProbe {
    template: string
    url: string
    /** HTTP status, or undefined when the request never completed. */
    status?: number
    /** `Content-Length`, when the server sent one. */
    length?: number
    /** Size the registry claims. */
    expected: number
    error?: string
}

/**
 * HEAD every artifact before downloading any of them. A registry that points
 * at a moved or unpublished image otherwise fails one template at a time,
 * interleaved with gigabytes of successful transfers for the others.
 */
export const probeArtifacts = async (
    items: InstallItem[],
    signal?: AbortSignal
): Promise<ArtifactProbe[]> => {
    const seen = new Set<string>()
    const targets: { template: string; url: string; expected: number }[] = []
    for (const item of items) {
        for (const disk of item.template.disks) {
            if (seen.has(disk.url)) continue
            seen.add(disk.url)
            targets.push({
                template: item.template.display,
                url: disk.url,
                expected: disk.size,
            })
        }
    }
    return Promise.all(
        targets.map(async target => {
            try {
                // The run's abort signal must still cut a hung HEAD short,
                // and a HEAD that hangs must not outlive its own budget.
                const timeout = AbortSignal.timeout(HEAD_TIMEOUT_MS)
                const res = await fetch(target.url, {
                    method: 'HEAD',
                    redirect: 'follow',
                    signal: signal
                        ? AbortSignal.any([signal, timeout])
                        : timeout,
                })
                const len = res.headers.get('content-length')
                return {
                    ...target,
                    status: res.status,
                    length: len === null ? undefined : Number(len),
                }
            } catch (e) {
                return {
                    ...target,
                    error: e instanceof Error ? e.message : String(e),
                }
            }
        })
    )
}

/**
 * A 4xx/5xx is the registry being wrong about what it publishes, and blocks.
 * Everything vaguer — a refused HEAD, a transport error, a `Content-Length`
 * that disagrees — warns: plenty of caches and proxies answer HEAD badly while
 * serving GET perfectly, and SHA-256 verification still guards the bytes.
 */
export const checkArtifacts = (probes: ArtifactProbe[]): Finding[] => {
    const findings: Finding[] = []
    for (const p of probes) {
        if (p.status === undefined) {
            findings.push(
                warn(
                    `${p.template}: could not reach ${p.url} (${p.error}). The ` +
                        `download may fail.`
                )
            )
            continue
        }
        // 405/501 = the server refuses HEAD, not a missing artifact.
        if (p.status === 405 || p.status === 501) continue
        if (p.status >= 400) {
            findings.push(
                err(
                    `${p.template}: ${p.url} returned HTTP ${p.status}. The registry ` +
                        `points at an artifact that is not published — nothing was ` +
                        `downloaded.`
                )
            )
            continue
        }
        if (
            p.length !== undefined &&
            Number.isFinite(p.length) &&
            p.length !== p.expected
        ) {
            findings.push(
                warn(
                    `${p.template}: ${p.url} is ${fmtBytes(p.length)}, but the ` +
                        `registry lists ${fmtBytes(p.expected)}. The registry may be ` +
                        `stale; SHA-256 verification will catch it either way.`
                )
            )
        }
    }
    return findings
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface PreflightReport {
    findings: Finding[]
    /** Blocking problems; a non-empty list must abort the run. */
    errors: string[]
    /** Things worth saying that should not stop an install. */
    warnings: string[]
}

export const report = (findings: Finding[]): PreflightReport => ({
    findings,
    errors: findings.filter(f => f.severity === 'error').map(f => f.message),
    warnings: findings
        .filter(f => f.severity === 'warning')
        .map(f => f.message),
})

export interface PreflightOptions {
    downloadConcurrency: number
    restoreConcurrency: number
    bridge: string
    /**
     * Whether this run will actually call `qm`. False for `--dry-run`, which
     * only prints a plan — being non-root or off a Proxmox node says nothing
     * about whether that plan is sound.
     */
    execute?: boolean
    signal?: AbortSignal
    tempRoot?: string
    /** Injectable probes, for tests. */
    probes?: Partial<Probes>
}

interface Probes {
    storages: () => Promise<NodeStorages | undefined>
    tooling: () => Promise<Tooling>
    guest: (vmid: number) => Promise<GuestLocation | undefined>
    localNode: () => Promise<string | undefined>
    bridges: () => Promise<Set<string> | undefined>
    artifacts: (
        items: InstallItem[],
        signal?: AbortSignal
    ) => Promise<ArtifactProbe[]>
    free: (path: string) => number | undefined
    writable: (path: string) => boolean
}

const defaultProbes: Probes = {
    storages: probeStorages,
    tooling: probeTooling,
    guest: vmid => probeGuest(vmid),
    localNode: () => localNodeName(),
    bridges: probeBridges,
    artifacts: probeArtifacts,
    free: freeBytes,
    writable: isWritable,
}

/** Run every check against a finished install plan. */
export const preflight = async (
    items: InstallItem[],
    options: PreflightOptions
): Promise<PreflightReport> => {
    const p = { ...defaultProbes, ...options.probes }
    const tempRoot = options.tempRoot ?? TEMP_ROOT
    const overwriting = items.filter(i => i.overwrite).map(i => i.vmid)

    const [tooling, node, localNode, guestList, bridges, artifacts] =
        await Promise.all([
            p.tooling(),
            p.storages(),
            p.localNode(),
            Promise.all(overwriting.map(p.guest)),
            p.bridges(),
            p.artifacts(items, options.signal),
        ])

    const guests = new Map(
        guestList.filter(g => g !== undefined).map(g => [g.vmid, g])
    )

    const execute = options.execute ?? true

    return report([
        ...(execute ? checkTooling(tooling) : []),
        // `pvesm` missing is already reported by checkTooling; don't say it twice.
        ...(node ? checkStorages(items, node) : []),
        ...checkVmids(items, guests, localNode),
        ...checkTemp(
            items.map(i => templateSize(i.template)),
            tempRoot,
            p.free(tempRoot),
            p.writable(tempRoot),
            options.downloadConcurrency,
            options.restoreConcurrency
        ),
        ...checkBridge(options.bridge, bridges),
        ...checkArtifacts(artifacts),
    ])
}

/** Render a report; returns true when the run may proceed. */
export const reportPreflight = (
    result: PreflightReport,
    log: { warn: (msg: string) => void; err: (msg: string) => void }
): boolean => {
    for (const warning of result.warnings) log.warn(warning)
    for (const error of result.errors) log.err(error)
    return result.errors.length === 0
}

/** Label for a storage in the interactive picker. */
export const storageHint = (s: StorageStatus): string =>
    `${s.type} ${dim('·')} ${accent(fmtBytes(s.availableBytes))} free`
