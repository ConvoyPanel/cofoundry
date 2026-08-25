import { afterEach, describe, expect, test } from 'bun:test'
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execa } from 'execa'

// The script's _pve helper re-parses its argument with `bash -c "$*"`, which
// strips backslashes from Windows-style paths. Forward slashes are valid on
// both platforms, so normalize paths handed to the script (no-op on POSIX).
const bashPath = (p: string) => p.replaceAll('\\', '/')

const roots: string[] = []

afterEach(async () => {
    await Promise.all(
        roots.splice(0).map(root => rm(root, { recursive: true, force: true }))
    )
})

/**
 * Stand up a fake Proxmox node: `qm config` prints the supplied config, `pvesm
 * path` maps a volid to a file under `images/`, and `qemu-img convert` copies
 * with a marker so the test can prove the export ran through it rather than
 * reading the source directly.
 */
const makeNode = async (config: string) => {
    const root = await mkdtemp(join(tmpdir(), 'cofoundry-export-'))
    roots.push(root)

    const bin = join(root, 'bin')
    const dump = join(root, 'dump')
    const out = join(root, 'out')
    const images = join(root, 'images')
    await Promise.all([mkdir(bin), mkdir(dump), mkdir(out), mkdir(images)])

    await writeFile(
        join(bin, 'qm'),
        `#!/usr/bin/env bash
if [ "$1" = config ]; then cat <<'CFG'
${config}
CFG
fi
exit 0
`
    )
    // volid "local:2002/base-2002-disk-0.raw" -> <images>/base-2002-disk-0.raw
    await writeFile(
        join(bin, 'pvesm'),
        `#!/usr/bin/env bash
if [ "$1" = path ]; then echo "${bashPath(images)}/\${2##*/}"; fi
exit 0
`
    )
    await writeFile(
        join(bin, 'qemu-img'),
        `#!/usr/bin/env bash
# convert -c -O qcow2 <src> <dst>
src="\${@: -2:1}"; dst="\${@: -1}"
printf 'converted:' > "$dst"
cat "$src" >> "$dst"
`
    )
    await Promise.all(
        ['qm', 'pvesm', 'qemu-img'].map(b => chmod(join(bin, b), 0o755))
    )

    return { root, bin, dump, out, images }
}

const run = (
    node: Awaited<ReturnType<typeof makeNode>>,
    env: Record<string, string>,
    opts: { reject?: boolean; all?: boolean } = {}
) =>
    execa('bash', [resolve('recipes/_shared/post/export-and-cleanup.sh')], {
        env: {
            PATH: `${node.bin}:${process.env.PATH}`,
            SSH_TARGET: 'local',
            PVE_DUMP_DIR: bashPath(node.dump),
            CF_OUT_DIR: bashPath(node.out),
            CF_ARCH: 'amd64',
            ...env,
        },
        ...opts,
    })

const LINUX_CONFIG = `agent: 1
bios: seabios
boot: order=scsi0;net0
ciuser: root
cores: 2
cpu: host
description: # Convoy Template%0A%0ACreated
ide1: local:4002/vm-4002-cloudinit.qcow2,media=cdrom
kvm: 1
machine: q35
memory: 2048
meta: creation-qemu=11.0.0,ctime=1785806938
name: debian-13
net0: virtio=02:50:4b:00:00:9c,bridge=vmbr1
numa: 0
onboot: 0
ostype: l26
scsi0: local:4002/base-4002-disk-0.qcow2,cache=none,discard=on,iothread=1,replicate=0,size=5G,ssd=1
scsihw: virtio-scsi-single
serial0: socket
smbios1: uuid=3c9d5477-f18a-4fda-a83d-f45881da56b3
sockets: 1
template: 1
vga: type=std
vmgenid: fa47d848-82a1-45ad-8444-1cdc7d4da824`

// A real windows-server-2025 config from the build node, including the pinned
// machine version and the cloud-init drive stranded on ide3.
//
// Driven under a non-`windows-*` recipe name on purpose. assert_generalized
// gates on the recipe NAME, and proving an image is generalized means attaching
// the disk with qemu-nbd and mounting NTFS as root — neither is available here.
// Nothing in these tests concerns that gate; they cover what the OVMF *config*
// makes the exporter do.
const OVMF_CONFIG = `agent: 1
bios: ovmf
boot: order=scsi0;net0
cores: 4
cpu: host
efidisk0: local:2002/base-2002-disk-0.raw,efitype=4m,ms-cert=2023k,pre-enrolled-keys=1,size=528K
ide3: local:2002/vm-2002-cloudinit.qcow2,media=cdrom
kvm: 1
machine: pc-q35-11.0
memory: 8192
name: windows-server-2025
net0: virtio=02:50:4b:00:00:9c,bridge=vmbr1
numa: 0
ostype: win11
scsi0: local:2002/base-2002-disk-1.qcow2,cache=none,discard=on,iothread=1,replicate=0,size=32G
scsihw: virtio-scsi-single
sockets: 1
template: 1
tpmstate0: local:2002/base-2002-disk-2.raw,size=17K,version=v2.0`

const readSidecar = async (out: string, name: string) =>
    JSON.parse(await readFile(join(out, `${name}.json`), 'utf8'))

const ovmfFixture = async () => {
    const node = await makeNode(OVMF_CONFIG)
    await Promise.all([
        writeFile(join(node.images, 'base-2002-disk-1.qcow2'), 'windisk'),
        writeFile(join(node.images, 'base-2002-disk-0.raw'), 'efivars'),
    ])
    return node
}

const OVMF_ENV = {
    CF_RECIPE_NAME: 'ovmf-guest',
    CF_RECIPE_DISPLAY: 'OVMF Guest',
    CF_BUILT_VMID: '200200',
    CF_GROUP: 'ovmf',
}

describe('export post-processor', () => {
    test('exports a Linux recipe as one compressed qcow2 plus a sidecar', async () => {
        const node = await makeNode(LINUX_CONFIG)
        await writeFile(join(node.images, 'base-4002-disk-0.qcow2'), 'disk')

        await run(node, {
            CF_RECIPE_NAME: 'debian-13',
            CF_RECIPE_DISPLAY: 'Debian 13',
            CF_BUILT_VMID: '400200',
            CF_RECIPE_BASE_VMID: '4002',
            CF_GROUP: 'debian',
            CF_MIN_CORES: '1',
            CF_MIN_MEMORY: '1024',
        })

        // Nothing is left behind in the node's dump dir.
        expect(await readdir(node.dump)).toEqual([])
        expect((await readdir(node.out)).sort()).toEqual([
            'debian-13-amd64.json',
            'debian-13-amd64.qcow2',
        ])
        // Proves the disk went through `qemu-img convert`, not a plain copy.
        expect(
            await readFile(join(node.out, 'debian-13-amd64.qcow2'), 'utf8')
        ).toBe('converted:disk')

        const sidecar = await readSidecar(node.out, 'debian-13-amd64')
        expect(sidecar.schema_version).toBe('2')
        expect(sidecar.name).toBe('debian-13-amd64')
        expect(sidecar.suggested_vmid).toBe(4002)
        expect(sidecar.minimum).toEqual({ cores: 1, memory: 1024 })

        expect(sidecar.disks).toHaveLength(1)
        expect(sidecar.disks[0]).toMatchObject({
            slot: 'scsi0',
            role: 'system',
            format: 'qcow2',
            virtual_size: '5G',
            options: { discard: 'on', ssd: 1 },
        })
        expect(sidecar.disks[0].sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(sidecar.disks[0].file).toBe(
            `debian-13-amd64-${sidecar.disks[0].sha256}.qcow2`
        )

        expect(sidecar.hardware).toEqual({
            agent: 1,
            bios: 'seabios',
            ciuser: 'root',
            cpu: 'host',
            machine: 'q35',
            net_model: 'virtio',
            ostype: 'l26',
            scsihw: 'virtio-scsi-single',
            serial0: 'socket',
        })
    })

    test('exports the EFI varstore alongside the system disk on OVMF recipes', async () => {
        const node = await ovmfFixture()

        await run(node, {
            ...OVMF_ENV,
            CF_RECIPE_BASE_VMID: '2002',
            CF_MIN_CORES: '2',
            CF_MIN_MEMORY: '4096',
        })

        expect(await readdir(node.dump)).toEqual([])
        const sidecar = await readSidecar(node.out, 'ovmf-guest-amd64')

        expect(sidecar.disks).toHaveLength(2)
        const efi = sidecar.disks.find(
            (d: { slot: string }) => d.slot === 'efidisk0'
        )
        expect(efi).toMatchObject({
            role: 'efivars',
            format: 'raw',
            options: {
                'efitype': '4m',
                'pre-enrolled-keys': 1,
                'ms-cert': '2023k',
            },
        })
        // The varstore is copied byte-for-byte — its exact contents (the boot
        // entry Setup wrote, the enrolled keys) are the entire point.
        expect(
            await readFile(
                join(node.out, 'ovmf-guest-amd64.efivars.raw'),
                'utf8'
            )
        ).toBe('efivars')
        // ...and carries no virtual_size, which only applies to the system disk.
        expect(efi.virtual_size).toBeUndefined()

        // A TPM is a property of the image, but the state volume is allocated
        // fresh by the consumer, so it is hardware and not a downloadable disk.
        expect(sidecar.hardware.tpm).toBe('v2.0')
        expect(
            sidecar.disks.some((d: { slot: string }) => d.slot === 'tpmstate0')
        ).toBe(false)
    })

    test('stages the varstore before the multi-minute system-disk conversion', async () => {
        const node = await ovmfFixture()
        const { all } = await run(node, OVMF_ENV, { all: true })

        // `pvesm path` only constructs a path, so the varstore's bytes are not
        // safe until they are copied. Converting the system disk first leaves
        // minutes between resolving the varstore and reading it — a window a
        // real build lost it in.
        const efi = all!.indexOf('copying EFI varstore')
        const system = all!.indexOf('converting')
        expect(efi).toBeGreaterThan(-1)
        expect(system).toBeGreaterThan(-1)
        expect(efi).toBeLessThan(system)
    })

    test('reports the image directory when a config names a missing volume', async () => {
        const node = await ovmfFixture()
        // The exact shape of the 2026-08-25 windows-server-2025 failure: the
        // config still names the varstore, but the file is gone.
        await rm(join(node.images, 'base-2002-disk-0.raw'))

        const result = await run(node, OVMF_ENV, { reject: false, all: true })

        expect(result.exitCode).not.toBe(0)
        expect(result.all).toContain('does not exist')
        // A bare "cp: cannot stat" says nothing about why. The listing and the
        // live config are what make the next occurrence diagnosable from
        // packer's stdout instead of needing another multi-hour rebuild.
        expect(result.all).toContain('contents of its image directory')
        expect(result.all).toContain('base-2002-disk-1.qcow2')
        expect(result.all).toContain('current VM config')
        // It must fail before writing a sidecar that advertises a missing image.
        expect(await readdir(node.out)).not.toContain('ovmf-guest-amd64.json')
    })

    test('normalizes the pinned machine version and drops build identity', async () => {
        const node = await ovmfFixture()
        await run(node, OVMF_ENV)

        const { hardware, minimum } = await readSidecar(
            node.out,
            'ovmf-guest-amd64'
        )

        // pc-q35-11.0 published as-is would refuse to start on a node running
        // older QEMU — a hard failure, not a degradation.
        expect(hardware.machine).toBe('q35')

        // Build identity and no-op defaults never reach the sidecar. Publishing
        // memory/cores would floor every consumer plan at the build's 8 GB.
        for (const key of [
            'name',
            'description',
            'template',
            'smbios1',
            'vmgenid',
            'meta',
            'memory',
            'cores',
            'sockets',
            'boot',
            'kvm',
            'numa',
            'onboot',
            'vga',
            'ide3',
        ]) {
            expect(hardware).not.toHaveProperty(key)
        }
        // Only the NIC model survives; the macaddr is the build's NAT slot.
        expect(hardware.net_model).toBe('virtio')
        expect(JSON.stringify(hardware)).not.toContain('02:50:4b')

        // No CF_MIN_* supplied, so the block is omitted rather than guessed.
        expect(minimum).toBeUndefined()
    })

    test('renders url and upload templates per artifact', async () => {
        const node = await ovmfFixture()
        const uploads = join(node.root, 'uploads.txt')

        await run(node, {
            ...OVMF_ENV,
            CF_PUBLIC_URL_TMPL:
                'https://cdn.example.com/{{group}}/{{recipe}}/{{filename}}',
            CF_UPLOAD_CMD: `echo {{filename}} >> ${bashPath(uploads)}`,
        })

        const sidecar = await readSidecar(node.out, 'ovmf-guest-amd64')

        // Each artifact has its own hash, so each gets its own URL — a single
        // {{sha256}} render for the whole recipe would mislabel one of them.
        const [system, efi] = sidecar.disks
        expect(system.sha256).not.toBe(efi.sha256)
        expect(system.url).toBe(
            `https://cdn.example.com/ovmf/ovmf-guest/ovmf-guest-amd64-${system.sha256}.qcow2`
        )
        expect(efi.url).toBe(
            `https://cdn.example.com/ovmf/ovmf-guest/ovmf-guest-amd64-${efi.sha256}.efivars.raw`
        )

        expect((await readFile(uploads, 'utf8')).trim().split('\n')).toEqual([
            `ovmf-guest-amd64-${system.sha256}.qcow2`,
            `ovmf-guest-amd64-${efi.sha256}.efivars.raw`,
        ])
    })
})
