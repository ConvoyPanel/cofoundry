import { systemDisk, type DiskImage, type Template } from '@/registry/schema.ts'
import {
    supportsFormatKey,
    supportsOption,
    type QmCreateSchema,
} from '@/registry/qm-schema.ts'

/**
 * Builds the `qm create` invocation that rebuilds a VM around a template's
 * downloaded disk images.
 *
 * Shared by `coport` (which then marks the result a template) and `cf verify`
 * (which boots it). Verify going through this same builder is the point: a
 * hardware profile that is never used to start anything will drift from what
 * the images actually need, and nothing would catch it.
 */

/**
 * Hardware keys that are not `qm create` flags: they name a thing to allocate
 * rather than a value to set, so they are handled explicitly below.
 */
const SYNTHESIZED = new Set(['net_model', 'tpm'])

/** Default VM shape when a template publishes no `minimum` block. */
export const FALLBACK_CORES = 2
export const FALLBACK_MEMORY = 2048

export const DEFAULT_BRIDGE = 'vmbr0'

export interface CreateOptions {
    vmid: number
    storage: string
    bridge: string
    /** Absolute path of each downloaded image, keyed by its target slot. */
    files: Map<string, string>
    /** Override the profile's `minimum` shape (verify boots larger). */
    cores?: number
    memory?: number
    /** VM name; defaults to the template name. */
    name?: string
    /**
     * What the target node's `qm create` accepts, from
     * `parseQmCreateSchema`. Omitted = install everything the template
     * publishes, which is what a node older than the builder chokes on.
     */
    schema?: QmCreateSchema
    /** Called once per option dropped as unknown to that node. */
    onUnsupported?: (message: string) => void
}

/**
 * The image's own options, minus any the node cannot parse. Dropping one costs
 * nothing here: `import-from` writes the same bytes either way, and these keys
 * only describe or tune what surrounds them.
 */
const diskOptions = (disk: DiskImage, options: CreateOptions): string =>
    Object.entries(disk.options ?? {})
        .filter(([key]) => {
            if (supportsFormatKey(options.schema, disk.slot, key)) return true
            options.onUnsupported?.(
                `dropped --${disk.slot} ${key}: not in this node's qm create schema`
            )
            return false
        })
        .map(([key, value]) => `,${key}=${value}`)
        .join('')

/**
 * Deliberately omitted:
 *   format=   the target storage's default is always valid; forcing qcow2
 *             would break block storages (LVM/ZFS) outright.
 *   citype=   Proxmox derives it from ostype (configdrive2 for Windows,
 *             nocloud otherwise), and the profile already carries ostype.
 *   machine=  passed through as the bare type. Proxmox re-pins it per node at
 *             create time for Windows guests ("pinning machine type to
 *             'pc-q35-11.0' for Windows guest OS"), so a published pin would
 *             only risk naming a QEMU this node does not have.
 */
export const createArgs = (
    template: Template,
    options: CreateOptions
): string[] => {
    const { vmid, storage, bridge, files } = options
    const { hardware, minimum } = template
    const args = [
        'qm',
        'create',
        String(vmid),
        '--name',
        options.name ?? template.name,
    ]

    for (const [key, value] of Object.entries(hardware)) {
        if (value === undefined || SYNTHESIZED.has(key)) continue
        // Capture is a denylist, so a profile can name hardware a node this
        // old has never heard of. Skipping it beats failing the create.
        if (!supportsOption(options.schema, key)) {
            options.onUnsupported?.(
                `dropped --${key}: not in this node's qm create schema`
            )
            continue
        }
        args.push(`--${key}`, String(value))
    }

    args.push(
        '--cores',
        String(options.cores ?? minimum?.cores ?? FALLBACK_CORES),
        '--memory',
        String(options.memory ?? minimum?.memory ?? FALLBACK_MEMORY)
    )

    for (const disk of template.disks) {
        const path = files.get(disk.slot)
        if (!path) throw new Error(`no downloaded file for ${disk.slot}`)
        args.push(
            `--${disk.slot}`,
            `${storage}:0,import-from=${path}${diskOptions(disk, options)}`
        )
    }

    // Allocated fresh, never downloaded: the image is generalized so nothing is
    // sealed to the TPM, and one shipped varstore would give every VM the same
    // endorsement key.
    if (hardware.tpm)
        args.push('--tpmstate0', `${storage}:0,version=${hardware.tpm}`)

    // Always ide2. Windows builds strand the drive on ide3 because ide0-2 held
    // the boot, virtio, and answer-file ISOs; Cloudbase-Init finds the config
    // drive by label, not slot.
    args.push('--ide2', `${storage}:cloudinit`)
    args.push('--net0', `${hardware.net_model ?? 'virtio'},bridge=${bridge}`)
    args.push('--boot', `order=${systemDisk(template).slot}`)

    return args
}
