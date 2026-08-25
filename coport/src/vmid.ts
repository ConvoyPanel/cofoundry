import { readFile, readdir } from 'node:fs/promises'
import type { Template } from '@/registry/schema.ts'

// VMIDs are cluster-global, but /etc/pve/qemu-server and /etc/pve/lxc are
// symlinks to the LOCAL node's directory only. Detection must cover every
// node, or we hand out a "free" VMID that `qm create` later rejects — after
// the multi-GB artifact has already been downloaded.
const PVE_DIR = '/etc/pve'

/**
 * Parse the pmxcfs-generated `.vmlist`: a JSON registry of every guest in
 * the cluster, shaped `{"version": N, "ids": {"<vmid>": {...}, ...}}`. The
 * `ids` key is omitted entirely when the cluster has no guests. Returns null
 * when the file is missing or malformed so callers can fall back to scanning
 * per-node config directories.
 */
export const readVmlist = async (
    pveDir = PVE_DIR
): Promise<Set<number> | null> => {
    let raw: string
    try {
        raw = await readFile(`${pveDir}/.vmlist`, 'utf8')
    } catch {
        return null
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    const ids = (parsed as { ids?: unknown }).ids ?? {}
    if (ids === null || typeof ids !== 'object' || Array.isArray(ids)) {
        return null
    }
    const taken = new Set<number>()
    for (const key of Object.keys(ids)) {
        const vmid = Number(key)
        if (Number.isInteger(vmid) && vmid > 0) taken.add(vmid)
    }
    return taken
}

/**
 * Fallback when `.vmlist` is unavailable: enumerate `<vmid>.conf` files under
 * every node's qemu-server/ and lxc/ directories, plus the local-node
 * symlinks so degraded setups keep at least the old local-only detection.
 */
export const scanGuestConfigs = async (
    pveDir = PVE_DIR
): Promise<Set<number>> => {
    const dirs = [`${pveDir}/qemu-server`, `${pveDir}/lxc`]
    try {
        for (const node of await readdir(`${pveDir}/nodes`)) {
            dirs.push(
                `${pveDir}/nodes/${node}/qemu-server`,
                `${pveDir}/nodes/${node}/lxc`
            )
        }
    } catch {
        // nodes/ missing or unreadable — the local symlinks are still scanned
    }
    const taken = new Set<number>()
    for (const dir of dirs) {
        let entries: string[]
        try {
            entries = await readdir(dir)
        } catch {
            continue
        }
        for (const entry of entries) {
            const m = /^(\d+)\.conf$/.exec(entry)
            if (m) taken.add(Number(m[1]))
        }
    }
    return taken
}

/**
 * True when at least one of the cluster-state directories `scanGuestConfigs`
 * reads is accessible. Distinguishes a genuinely guest-less node (readable but
 * empty) from an unreadable `/etc/pve` — e.g. pmxcfs unmounted mid
 * `pve-cluster` restart — where the scan would silently come back empty and we
 * would hand out a VMID that is actually taken.
 */
const clusterStateReadable = async (pveDir: string): Promise<boolean> => {
    for (const dir of [
        `${pveDir}/nodes`,
        `${pveDir}/qemu-server`,
        `${pveDir}/lxc`,
    ]) {
        try {
            await readdir(dir)
            return true
        } catch {
            // try the next candidate directory
        }
    }
    return false
}

/**
 * Every VMID currently in use anywhere in the cluster.
 *
 * A parseable `.vmlist` is authoritative — an empty one means an empty cluster.
 * When it is missing/malformed we fall back to scanning per-node config dirs,
 * but only if `/etc/pve` is actually readable: if neither the list nor any
 * guest-config directory can be read, the cluster state is unknown (pmxcfs
 * unmounted, say), and reporting "nothing taken" would assign a colliding VMID
 * that only fails after a multi-GB download. Refuse loudly instead.
 */
export const takenVmids = async (pveDir = PVE_DIR): Promise<Set<number>> => {
    const fromVmlist = await readVmlist(pveDir)
    if (fromVmlist) return fromVmlist
    if (!(await clusterStateReadable(pveDir))) {
        throw new Error(
            `coport: could not read the Proxmox cluster state under ${pveDir} — ` +
                `no .vmlist and no readable guest-config directories. Refusing to ` +
                `assign VMIDs without knowing which are taken (a blind assignment ` +
                `would fail only after a multi-GB download). Is pve-cluster running ` +
                `and ${pveDir} mounted? Retry once it is.`
        )
    }
    return scanGuestConfigs(pveDir)
}

export const vmidTaken = async (
    vmid: number,
    pveDir = PVE_DIR
): Promise<boolean> => (await takenVmids(pveDir)).has(vmid)

export const findFreeVmid = (
    start: number,
    reserved: Set<number>,
    taken: Set<number>
): number => {
    let id = start
    while (reserved.has(id) || taken.has(id)) {
        id++
    }
    return id
}

export interface VmidAssignment {
    template: Template
    vmid: number
    conflict: boolean
    overwrite: boolean
}

export const resolveVmids = async (
    templates: Template[],
    vmidStart: number,
    overwriteTaken = false,
    /** Preferred VMID per template name (e.g. from the install cache). */
    preferred?: Map<string, number>,
    pveDir = PVE_DIR
): Promise<VmidAssignment[]> => {
    // Snapshot cluster-wide usage once; VMIDs assigned within this batch are
    // tracked separately in `reserved`.
    const taken = await takenVmids(pveDir)
    const reserved = new Set<number>()
    const assignments: VmidAssignment[] = []

    for (const t of templates) {
        // A cached VMID the user previously installed into wins over the
        // registry's suggestion, so `--upgrade` lands in the same slot.
        const desired = preferred?.get(t.name) ?? t.suggested_vmid
        const desiredTaken = desired ? taken.has(desired) : false
        if (
            desired &&
            !reserved.has(desired) &&
            (!desiredTaken || overwriteTaken)
        ) {
            reserved.add(desired)
            assignments.push({
                template: t,
                vmid: desired,
                conflict: false,
                overwrite: desiredTaken,
            })
        } else {
            const free = findFreeVmid(vmidStart, reserved, taken)
            reserved.add(free)
            assignments.push({
                template: t,
                vmid: free,
                conflict: true,
                overwrite: false,
            })
        }
    }

    return assignments
}
