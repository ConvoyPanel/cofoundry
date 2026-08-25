import { describe, expect, test } from 'bun:test'
import { createArgs } from '@/registry/create.ts'
import type { Template } from '@/registry/schema.ts'

const systemDiskEntry = {
    slot: 'scsi0',
    role: 'system' as const,
    format: 'qcow2' as const,
    file: 'x.qcow2',
    url: 'https://example.com/x.qcow2',
    sha256: 'a'.repeat(64),
    size: 10,
    virtual_size: '32G',
    options: { discard: 'on' },
}

const windows: Template = {
    name: 'windows-server-2025-amd64',
    display: 'Windows Server 2025 Datacenter',
    arch: 'amd64',
    built_at: '2026-08-04T16:53:31Z',
    disks: [
        systemDiskEntry,
        {
            slot: 'efidisk0',
            role: 'efivars',
            format: 'raw',
            file: 'x.efivars.raw',
            url: 'https://example.com/x.efivars.raw',
            sha256: 'b'.repeat(64),
            size: 540672,
            options: {
                'efitype': '4m',
                'pre-enrolled-keys': 1,
                'ms-cert': '2023k',
            },
        },
    ],
    hardware: {
        ostype: 'win11',
        bios: 'ovmf',
        machine: 'q35',
        scsihw: 'virtio-scsi-single',
        cpu: 'host',
        agent: 1,
        net_model: 'virtio',
        tpm: 'v2.0',
    },
    minimum: { cores: 2, memory: 4096 },
}

const linux: Template = {
    name: 'debian-12-amd64',
    display: 'Debian 12',
    arch: 'amd64',
    built_at: '2026-08-04T01:28:57Z',
    disks: [systemDiskEntry],
    hardware: {
        ostype: 'l26',
        bios: 'seabios',
        machine: 'q35',
        scsihw: 'virtio-scsi-single',
        serial0: 'socket',
        ciuser: 'root',
    },
    minimum: { cores: 1, memory: 1024 },
}

const opts = {
    vmid: 9001,
    storage: 'local-zfs',
    bridge: 'vmbr0',
    files: new Map([
        ['scsi0', '/tmp/x.qcow2'],
        ['efidisk0', '/tmp/x.efivars.raw'],
    ]),
}

/** Value that followed `--flag`, or undefined when the flag is absent. */
const flag = (args: string[], name: string): string | undefined => {
    const i = args.indexOf(`--${name}`)
    return i < 0 ? undefined : args[i + 1]
}

describe('createArgs', () => {
    test('imports every published disk from its downloaded path', () => {
        const args = createArgs(windows, opts)
        expect(flag(args, 'scsi0')).toBe(
            'local-zfs:0,import-from=/tmp/x.qcow2,discard=on'
        )
        // The varstore's options describe the image and must ride along, or the
        // enrolled Secure Boot keys are imported under the wrong sizing.
        expect(flag(args, 'efidisk0')).toBe(
            'local-zfs:0,import-from=/tmp/x.efivars.raw,efitype=4m,pre-enrolled-keys=1,ms-cert=2023k'
        )
    })

    test('allocates TPM and cloud-init fresh rather than importing them', () => {
        const args = createArgs(windows, opts)
        // Nothing is sealed to the TPM in a generalized image, and one shipped
        // varstore would give every VM the same endorsement key.
        expect(flag(args, 'tpmstate0')).toBe('local-zfs:0,version=v2.0')
        expect(flag(args, 'tpmstate0')).not.toContain('import-from')
        // Always ide2 — Windows builds strand the drive on ide3 only because
        // ide0-2 held the boot, virtio, and answer-file ISOs.
        expect(flag(args, 'ide2')).toBe('local-zfs:cloudinit')
        expect(args).not.toContain('--ide3')
    })

    test('omits the TPM entirely for images that have none', () => {
        // windows-server-2019 and every Linux recipe have no tpmstate0.
        expect(createArgs(linux, opts)).not.toContain('--tpmstate0')
    })

    test('passes hardware through but never as a bare flag name', () => {
        const args = createArgs(windows, opts)
        expect(flag(args, 'ostype')).toBe('win11')
        expect(flag(args, 'bios')).toBe('ovmf')
        expect(flag(args, 'scsihw')).toBe('virtio-scsi-single')
        expect(flag(args, 'cpu')).toBe('host')
        expect(flag(args, 'agent')).toBe('1')

        // net_model and tpm name things to allocate, not values to set; a
        // literal `--net_model virtio` would be rejected by qm.
        expect(args).not.toContain('--net_model')
        expect(args).not.toContain('--tpm')
        expect(flag(args, 'net0')).toBe('virtio,bridge=vmbr0')
    })

    test('publishes the bare machine type and lets Proxmox pin it', () => {
        // Proxmox re-pins per node at create time for Windows guests, so a
        // published pin could only name a QEMU the target node lacks.
        expect(flag(createArgs(windows, opts), 'machine')).toBe('q35')
    })

    test('sizes the VM from `minimum`, not the build shape', () => {
        const args = createArgs(windows, opts)
        expect(flag(args, 'cores')).toBe('2')
        expect(flag(args, 'memory')).toBe('4096')
    })

    test('falls back to a usable shape when minimum is absent', () => {
        const { minimum: _minimum, ...bare } = windows
        const args = createArgs(bare as Template, opts)
        expect(flag(args, 'cores')).toBe('2')
        expect(flag(args, 'memory')).toBe('2048')
    })

    test('boots from the system disk and carries Linux console settings', () => {
        const args = createArgs(linux, { ...opts })
        expect(flag(args, 'boot')).toBe('order=scsi0')
        expect(flag(args, 'serial0')).toBe('socket')
        expect(flag(args, 'ciuser')).toBe('root')
        expect(args).not.toContain('--efidisk0')
    })

    test('refuses to build a command referencing a file it never downloaded', () => {
        expect(() =>
            createArgs(windows, { ...opts, files: new Map() })
        ).toThrow('no downloaded file for scsi0')
    })

    test('leaves format and citype to Proxmox', () => {
        const args = createArgs(windows, opts)
        // format= would break block storages; citype is derived from ostype.
        expect(args).not.toContain('--format')
        expect(args).not.toContain('--citype')
    })
})
