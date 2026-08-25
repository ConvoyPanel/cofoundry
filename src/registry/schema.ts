import { z } from 'zod'

/**
 * Registry schema 2 — importable disk images instead of `.vma.zst` templates.
 *
 * A template is no longer one archive but a set of disk images plus the VM
 * configuration needed to rebuild a machine around them. See
 * docs/disk-images.md for the design and the Proxmox 9 behaviour it relies on.
 */

/**
 * One downloadable image. `size` is bytes on the wire; `virtual_size` is what
 * the guest sees after import, and only the system disk has one.
 */
export interface DiskImage {
    /** Proxmox slot to import into, e.g. `scsi0` or `efidisk0`. */
    slot: string
    role: 'system' | 'efivars'
    format: 'qcow2' | 'raw'
    file: string
    url: string
    sha256: string
    size: number
    virtual_size?: string
    /**
     * Options that describe the IMAGE, not the consumer's storage tuning —
     * `discard`/`ssd` on the system disk, `efitype`/`pre-enrolled-keys`/
     * `ms-cert` on the varstore. `cache`/`iothread`/`replicate` are
     * deliberately absent: they are the consumer's to choose.
     */
    options?: Record<string, string | number>
}

/**
 * VM configuration captured from the built machine. Keys map 1:1 onto `qm
 * create` parameters except `net_model`, which is only the NIC model — the
 * build's macaddr and bridge are the consumer's to choose.
 *
 * Open-ended on purpose. Capture is a denylist over `qm config`, so a field
 * Proxmox adds in a future release flows through to consumers rather than
 * being silently dropped by a closed schema.
 */
export interface Hardware {
    ostype: string
    bios: string
    machine: string
    scsihw?: string
    cpu?: string
    agent?: number
    net_model?: string
    /** TPM version to allocate, e.g. `v2.0`. Absent = the image has no TPM. */
    tpm?: string
    serial0?: string
    ciuser?: string
    [key: string]: string | number | undefined
}

/**
 * Runtime floor. Hand-authored per recipe rather than captured — the build's
 * cores/memory are servicing headroom, not a requirement.
 *
 * There is deliberately no disk floor: `import-from` gives the imported disk
 * the source's virtual size and `qm disk resize` cannot shrink, so
 * `disks[0].virtual_size` already enforces it structurally.
 */
export interface Minimum {
    cores?: number
    memory?: number
}

export interface Template {
    name: string
    display: string
    arch: string
    built_at: string
    disks: DiskImage[]
    hardware: Hardware
    minimum?: Minimum
    suggested_vmid?: number
    tags?: string[]
    description?: string | null
}

export interface Group {
    id: string
    display_name: string
    description?: string | null
    templates: Template[]
}

export interface Registry {
    schema_version: '2'
    name: string
    description?: string | null
    author?: string
    homepage?: string
    generated_at: string
    groups: Group[]
}

/** A published sidecar: one template plus the group it belongs to. */
export interface Sidecar extends Template {
    schema_version?: string
    group: string
}

export const DiskImageSchema = z.object({
    slot: z.string(),
    role: z.enum(['system', 'efivars']),
    format: z.enum(['qcow2', 'raw']),
    file: z.string(),
    url: z.string(),
    sha256: z.string(),
    size: z.number(),
    virtual_size: z.string().optional(),
    options: z.record(z.union([z.string(), z.number()])).optional(),
})

export const HardwareSchema = z
    .object({
        ostype: z.string(),
        bios: z.string(),
        machine: z.string(),
        scsihw: z.string().optional(),
        cpu: z.string().optional(),
        agent: z.number().optional(),
        net_model: z.string().optional(),
        tpm: z.string().optional(),
        serial0: z.string().optional(),
        ciuser: z.string().optional(),
    })
    // Captured by denylist, so unknown keys are expected and must survive — but
    // they still have to be `qm create` values. catchall keeps them typed
    // instead of `unknown`, which passthrough() would leave them as.
    .catchall(z.union([z.string(), z.number()]))

export const MinimumSchema = z.object({
    cores: z.number().optional(),
    memory: z.number().optional(),
})

export const TemplateSchema = z.object({
    name: z.string(),
    display: z.string(),
    arch: z.string(),
    built_at: z.string(),
    disks: z.array(DiskImageSchema).min(1),
    hardware: HardwareSchema,
    minimum: MinimumSchema.optional(),
    suggested_vmid: z.number().optional(),
    tags: z.array(z.string()).optional(),
    description: z.string().nullable().optional(),
})

export const GroupSchema = z.object({
    id: z.string(),
    display_name: z.string(),
    description: z.string().nullable().optional(),
    templates: z.array(TemplateSchema),
})

export const RegistrySchema = z.object({
    schema_version: z.literal('2'),
    name: z.string(),
    description: z.string().nullable().optional(),
    author: z.string().optional(),
    homepage: z.string().optional(),
    generated_at: z.string(),
    groups: z.array(GroupSchema),
})

/** The image a consumer boots from — always present, by schema. */
export const systemDisk = (template: Template): DiskImage => {
    const disk = template.disks.find(d => d.role === 'system')
    if (!disk) throw new Error(`${template.name}: no system disk in sidecar`)
    return disk
}

/** Total bytes downloaded to install a template, across all its images. */
export const templateSize = (template: Template): number =>
    template.disks.reduce((total, disk) => total + disk.size, 0)
