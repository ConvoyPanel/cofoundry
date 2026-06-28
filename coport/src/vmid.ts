import { access } from 'node:fs/promises'
import type { Template } from '@/registry/schema.ts'

export const vmidTaken = async (vmid: number): Promise<boolean> => {
    const paths = [
        `/etc/pve/qemu-server/${vmid}.conf`,
        `/etc/pve/lxc/${vmid}.conf`,
    ]
    for (const p of paths) {
        try {
            await access(p)
            return true
        } catch {
            // not found — continue
        }
    }
    return false
}

export const findFreeVmid = async (
    start: number,
    reserved: Set<number>
): Promise<number> => {
    let id = start
    while (reserved.has(id) || (await vmidTaken(id))) {
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
    preferred?: Map<string, number>
): Promise<VmidAssignment[]> => {
    const reserved = new Set<number>()
    const assignments: VmidAssignment[] = []

    for (const t of templates) {
        // A cached VMID the user previously installed into wins over the
        // registry's suggestion, so `--upgrade` lands in the same slot.
        const desired = preferred?.get(t.name) ?? t.suggested_vmid
        const desiredTaken = desired ? await vmidTaken(desired) : false
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
            const free = await findFreeVmid(vmidStart, reserved)
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
