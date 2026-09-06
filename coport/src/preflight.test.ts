import { afterEach, describe, expect, test } from 'bun:test'
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
    symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Template } from '@/registry/schema.ts'
import {
    checkArtifacts,
    checkBridge,
    checkStorages,
    checkTemp,
    checkTooling,
    checkVmids,
    isWritable,
    localNodeName,
    parsePvesmStatus,
    parseVirtualSize,
    peakTempBytes,
    preflight,
    probeArtifacts,
    probeGuest,
    setProbedStorages,
    storageDemand,
    storageProblem,
    usableStorages,
    type ArtifactProbe,
    type GuestLocation,
    type NodeStorages,
} from './preflight.ts'
import type { InstallItem } from './types.ts'

const GB = 1_000_000_000
const GIB = 1024 ** 3
const MIB = 1024 ** 2

// Real shape of `pvesm status` on a stock node: `local` is dir-backed but
// carries only iso/vztmpl/backup, so it is absent from the --content images
// listing even though it appears here. `vg0` is plain LVM — thick.
const STATUS = `Name             Type     Status           Total            Used       Available        %
local             dir     active        98559220        12345678        81234567   12.53%
local-lvm     lvmthin     active       350000000        50000000       300000000   14.29%
tank          zfspool     active       100000000        50000000        50000000   50.00%
vg0               lvm     active        20971520               0        20971520    0.00%
backup            nfs   inactive       500000000               0       500000000    0.00%
`

const IMAGES = ['local-lvm', 'tank', 'vg0', 'backup']

const node = (): NodeStorages => ({
    all: parsePvesmStatus(STATUS),
    imageCapable: new Set(IMAGES),
})

const template = (
    name: string,
    bytes: number,
    virtual?: string,
    tpm?: string
): Template => ({
    name,
    display: name,
    arch: 'amd64',
    built_at: '2026-01-01T00:00:00Z',
    disks: [
        {
            slot: 'scsi0',
            role: 'system',
            format: 'qcow2',
            file: `${name}.qcow2`,
            url: `https://example.invalid/${name}.qcow2`,
            sha256: 'a'.repeat(64),
            size: bytes,
            virtual_size: virtual,
        },
    ],
    hardware: { ostype: 'l26', bios: 'ovmf', machine: 'q35', tpm },
})

const item = (
    name: string,
    bytes: number,
    storage: string,
    extra: Partial<InstallItem> & { virtual?: string } = {}
): InstallItem => ({
    template: template(name, bytes, extra.virtual),
    vmid: extra.vmid ?? 100,
    storage,
    overwrite: extra.overwrite ?? false,
})

const messages = (findings: { message: string }[]): string =>
    findings.map(f => f.message).join('\n')

afterEach(() => {
    setProbedStorages(undefined)
})

// ---------------------------------------------------------------------------

describe('parsePvesmStatus', () => {
    test('parses rows, skips the header, and converts KiB to bytes', () => {
        const rows = parsePvesmStatus(STATUS)
        expect([...rows.keys()]).toEqual([
            'local',
            'local-lvm',
            'tank',
            'vg0',
            'backup',
        ])
        expect(rows.get('local')).toMatchObject({
            type: 'dir',
            status: 'active',
            active: true,
            availableBytes: 81234567 * 1024,
        })
        expect(rows.get('backup')!.active).toBe(false)
    })

    test('drops short and non-numeric rows rather than half-parsing them', () => {
        const rows = parsePvesmStatus(
            'Name Type Status Total Used Available %\nbroken dir active\nweird dir active x y z\n'
        )
        expect(rows.size).toBe(0)
    })

    test('returns nothing for empty output', () => {
        expect(parsePvesmStatus('').size).toBe(0)
    })

    test('reads the PVE 9.1 header, which labels the size columns (KiB)', () => {
        // Verbatim from us-west, pve-manager/9.1.18. The header row splits
        // into ten fields rather than seven, which must not shift a real row.
        const rows = parsePvesmStatus(
            'Name         Type     Status     Total (KiB)      Used (KiB) Available (KiB)        %\n' +
                'local         dir     active       220284968        47402860       163203624   21.52%\n'
        )
        expect(rows.size).toBe(1)
        expect(rows.get('local')).toMatchObject({
            type: 'dir',
            active: true,
            availableBytes: 163203624 * 1024,
        })
    })
})

describe('storageProblem', () => {
    test('rejects a storage without the images content type', () => {
        const problem = storageProblem('local', node())
        expect(problem).toContain('does not support VM images')
        // The message must name a storage that would have worked.
        expect(problem).toContain('local-lvm')
    })

    test('rejects a storage the node does not have', () => {
        expect(storageProblem('nope', node())).toContain(
            'No storage named "nope"'
        )
    })

    test('rejects an image-capable storage that is offline', () => {
        expect(storageProblem('backup', node())).toContain('not active')
    })

    test('accepts an active image-capable storage', () => {
        expect(storageProblem('local-lvm', node())).toBeUndefined()
    })

    test('says what to do when no storage anywhere accepts images', () => {
        const bare: NodeStorages = {
            all: parsePvesmStatus(STATUS),
            imageCapable: new Set(),
        }
        expect(storageProblem('local', bare)).toContain(
            'No storage on this node accepts VM images'
        )
    })
})

describe('usableStorages', () => {
    test('keeps only active image-capable storages, roomiest first', () => {
        expect(usableStorages(node()).map(s => s.name)).toEqual([
            'local-lvm',
            'tank',
            'vg0',
        ])
    })
})

// ---------------------------------------------------------------------------

describe('parseVirtualSize', () => {
    test('reads the binary units qm and the registry publish', () => {
        expect(parseVirtualSize('30G')).toBe(30 * GIB)
        expect(parseVirtualSize('5G')).toBe(5 * GIB)
        expect(parseVirtualSize('8192M')).toBe(8 * GIB)
        expect(parseVirtualSize('1T')).toBe(1024 * GIB)
        expect(parseVirtualSize('32.5G')).toBe(Math.round(32.5 * GIB))
        expect(parseVirtualSize('40GiB')).toBe(40 * GIB)
        expect(parseVirtualSize('1048576')).toBe(1048576)
    })

    test('returns undefined rather than guessing at a shape it does not know', () => {
        expect(parseVirtualSize(undefined)).toBeUndefined()
        expect(parseVirtualSize('')).toBeUndefined()
        expect(parseVirtualSize('lots')).toBeUndefined()
        expect(parseVirtualSize('30 gigs')).toBeUndefined()
    })
})

describe('storageDemand', () => {
    test('separates the download floor from the full virtual size', () => {
        // The real gap: a 7.5 GB Windows download declaring a 30 GiB disk.
        const demand = storageDemand([template('win', 7.5 * GB, '30G')])
        expect(demand.download).toBe(7.5 * GB + 4 * MIB)
        expect(demand.virtual).toBe(30 * GIB + 4 * MIB)
    })

    test('counts the cloud-init drive, and the TPM state when there is one', () => {
        const plain = storageDemand([template('deb', GB, '5G')])
        const tpm = storageDemand([template('win', GB, '5G', 'v2.0')])
        expect(tpm.download - plain.download).toBe(4 * MIB)
    })

    test('falls back to the on-wire size when no virtual size is published', () => {
        const demand = storageDemand([template('efi', 540672)])
        expect(demand.virtual - 4 * MIB).toBe(540672)
    })
})

describe('checkStorages', () => {
    test('blocks a storage that cannot hold images', () => {
        const findings = checkStorages([item('deb', GB, 'local')], node())
        expect(findings).toHaveLength(1)
        expect(findings[0]!.severity).toBe('error')
    })

    test('reports each bad storage once, not once per template', () => {
        const findings = checkStorages(
            [
                item('deb', GB, 'local'),
                item('ubuntu', GB, 'local'),
                item('win', GB, 'nope'),
            ],
            node()
        )
        expect(findings).toHaveLength(2)
    })

    test('blocks thick LVM on the virtual size, not the download size', () => {
        // vg0 has 20 GiB free; a 2 GB download declaring 30 GiB does not fit.
        const findings = checkStorages(
            [item('win', 2 * GB, 'vg0', { virtual: '30G' })],
            node()
        )
        expect(findings[0]!.severity).toBe('error')
        expect(findings[0]!.message).toContain('full virtual size at creation')
    })

    test('says nothing about a thick storage that clears the virtual size', () => {
        expect(
            checkStorages(
                [item('deb', 200_000_000, 'vg0', { virtual: '5G' })],
                node()
            )
        ).toEqual([])
    })

    test('lets the same template onto a thin pool, silently when it clears the ceiling', () => {
        // local-lvm has ~307 GB free, which clears the 30 GiB virtual size as
        // well as the download, so there is nothing to say.
        expect(
            checkStorages(
                [item('win', 2 * GB, 'local-lvm', { virtual: '30G' })],
                node()
            )
        ).toEqual([])
    })

    test('flags a sparse backend that clears the download but not the virtual size', () => {
        // tank (zfspool) has ~51 GB free: the 4 GB of downloads fit, the
        // 60 GiB of virtual disk does not. Measured on us-west, a compressed
        // qcow2 expands ~3x on import, so this range is a real risk — but not
        // a refusal, because the expanded size is not published.
        const findings = checkStorages(
            [
                item('a', 2 * GB, 'tank', { virtual: '30G' }),
                item('b', 2 * GB, 'tank', { virtual: '30G' }),
            ],
            node()
        )
        expect(findings[0]!.severity).toBe('warning')
        expect(findings[0]!.message).toContain('decompress')
        expect(findings[0]!.message).not.toContain('will succeed')
    })

    test('only warns when a compressing backend is below the download floor', () => {
        const findings = checkStorages([item('big', 80 * GB, 'tank')], node())
        expect(findings[0]!.severity).toBe('warning')
        expect(findings[0]!.message).toContain('may compress them back down')
    })

    test('errors when a non-compressing backend is below the download floor', () => {
        const findings = checkStorages(
            [item('big', 400 * GB, 'local-lvm')],
            node()
        )
        expect(findings[0]!.severity).toBe('error')
        expect(findings[0]!.message).toContain('expand on import')
    })

    test('passes a plan that fits', () => {
        expect(checkStorages([item('deb', GB, 'local-lvm')], node())).toEqual(
            []
        )
    })
})

// ---------------------------------------------------------------------------

describe('checkTooling', () => {
    test('blocks a run off a Proxmox node', () => {
        const findings = checkTooling({ qm: false, pvesm: false, root: true })
        expect(findings[0]!.severity).toBe('error')
        expect(findings[0]!.message).toContain('`qm` was not found')
    })

    test('blocks a non-root run', () => {
        const findings = checkTooling({ qm: true, pvesm: true, root: false })
        expect(messages(findings)).toContain('not running as root')
    })

    test('warns, not blocks, when only pvesm is missing', () => {
        const findings = checkTooling({ qm: true, pvesm: false, root: true })
        expect(findings).toHaveLength(1)
        expect(findings[0]!.severity).toBe('warning')
    })

    test('says nothing on a healthy node', () => {
        expect(checkTooling({ qm: true, pvesm: true, root: true })).toEqual([])
    })
})

// ---------------------------------------------------------------------------

const guest = (over: Partial<GuestLocation> = {}): GuestLocation => ({
    vmid: 4001,
    node: 'pve1',
    kind: 'qemu',
    running: false,
    ...over,
})

describe('checkVmids', () => {
    const none = new Map<number, GuestLocation>()

    test('rejects a VMID outside the range qm accepts', () => {
        const findings = checkVmids(
            [item('deb', GB, 'local-lvm', { vmid: 42 })],
            none,
            'pve1'
        )
        expect(findings[0]!.severity).toBe('error')
        expect(findings[0]!.message).toContain('--vmid-start')
    })

    test('ignores occupants when not overwriting', () => {
        const guests = new Map([[4001, guest({ running: true })]])
        expect(
            checkVmids(
                [item('deb', GB, 'local-lvm', { vmid: 4001 })],
                guests,
                'pve1'
            )
        ).toEqual([])
    })

    test('blocks --overwrite of a running VM', () => {
        const guests = new Map([[4001, guest({ running: true })]])
        const findings = checkVmids(
            [item('deb', GB, 'local-lvm', { vmid: 4001, overwrite: true })],
            guests,
            'pve1'
        )
        expect(findings[0]!.severity).toBe('error')
        expect(findings[0]!.message).toContain('qm stop 4001')
    })

    test('blocks --overwrite of a locked VM', () => {
        const guests = new Map([[4001, guest({ lock: 'backup' })]])
        const findings = checkVmids(
            [item('deb', GB, 'local-lvm', { vmid: 4001, overwrite: true })],
            guests,
            'pve1'
        )
        expect(findings[0]!.message).toContain('qm unlock 4001')
    })

    test('blocks --overwrite of a container qm cannot destroy', () => {
        const guests = new Map([[4001, guest({ kind: 'lxc' })]])
        const findings = checkVmids(
            [item('deb', GB, 'local-lvm', { vmid: 4001, overwrite: true })],
            guests,
            'pve1'
        )
        expect(findings[0]!.message).toContain('pct destroy 4001')
    })

    test('blocks --overwrite of a guest owned by another node', () => {
        const guests = new Map([[4001, guest({ node: 'pve2' })]])
        const findings = checkVmids(
            [item('deb', GB, 'local-lvm', { vmid: 4001, overwrite: true })],
            guests,
            'pve1'
        )
        expect(findings[0]!.message).toContain('node "pve2"')
    })

    test('skips the ownership check when the local node name is unknown', () => {
        const guests = new Map([[4001, guest({ node: 'pve2' })]])
        expect(
            checkVmids(
                [item('deb', GB, 'local-lvm', { vmid: 4001, overwrite: true })],
                guests,
                undefined
            )
        ).toEqual([])
    })

    test('allows --overwrite of a stopped local VM', () => {
        const guests = new Map([[4001, guest()]])
        expect(
            checkVmids(
                [item('deb', GB, 'local-lvm', { vmid: 4001, overwrite: true })],
                guests,
                'pve1'
            )
        ).toEqual([])
    })
})

describe('probeGuest / localNodeName', () => {
    let pve: string
    let run: string

    const setup = (): void => {
        pve = mkdtempSync(join(tmpdir(), 'coport-pve-'))
        run = mkdtempSync(join(tmpdir(), 'coport-run-'))
        mkdirSync(join(pve, 'nodes', 'pve1', 'qemu-server'), {
            recursive: true,
        })
        mkdirSync(join(pve, 'nodes', 'pve2', 'lxc'), { recursive: true })
        symlinkSync(join(pve, 'nodes', 'pve1'), join(pve, 'local'))
    }

    afterEach(() => {
        rmSync(pve, { recursive: true, force: true })
        rmSync(run, { recursive: true, force: true })
    })

    test('locates a VM, its lock, and whether it is running', async () => {
        setup()
        writeFileSync(
            join(pve, 'nodes', 'pve1', 'qemu-server', '4001.conf'),
            'name: web\nlock: backup\nmemory: 2048\n'
        )
        writeFileSync(join(run, '4001.pid'), '1234\n')
        expect(await probeGuest(4001, pve, run)).toMatchObject({
            node: 'pve1',
            kind: 'qemu',
            lock: 'backup',
            running: true,
        })
    })

    test('finds guests on other nodes, and containers', async () => {
        setup()
        writeFileSync(
            join(pve, 'nodes', 'pve2', 'lxc', '200.conf'),
            'arch: amd64\n'
        )
        expect(await probeGuest(200, pve, run)).toMatchObject({
            node: 'pve2',
            kind: 'lxc',
            running: false,
        })
    })

    test('returns undefined for a free VMID', async () => {
        setup()
        expect(await probeGuest(999, pve, run)).toBeUndefined()
    })

    test('reads the local node name from the /etc/pve/local symlink', async () => {
        setup()
        expect(await localNodeName(pve)).toBe('pve1')
    })

    test('reports an unknown local node rather than guessing', async () => {
        setup()
        expect(await localNodeName(join(pve, 'missing'))).toBeUndefined()
    })
})

// ---------------------------------------------------------------------------

describe('peakTempBytes', () => {
    test('bounds the peak by how many images can be resident at once', () => {
        // 4 downloads + 2 imports = 6 slots, so the two smallest never overlap.
        const sizes = [8, 7, 6, 5, 4, 3, 2, 1].map(n => n * GB)
        expect(peakTempBytes(sizes, 4, 2)).toBe(33 * GB)
    })

    test('never exceeds the whole batch', () => {
        expect(peakTempBytes([GB, GB], 4, 2)).toBe(2 * GB)
    })
})

describe('checkTemp', () => {
    test('blocks when the volume cannot hold the largest image', () => {
        const findings = checkTemp([8 * GB], '/tmp/x', 2 * GB, true, 4, 2)
        expect(findings[0]!.severity).toBe('error')
        expect(findings[0]!.message).toContain('largest image')
    })

    test('warns when one image fits but the peak does not', () => {
        const findings = checkTemp(
            [8 * GB, 8 * GB],
            '/tmp/x',
            10 * GB,
            true,
            4,
            2
        )
        expect(findings[0]!.severity).toBe('warning')
        expect(findings[0]!.message).toContain('at once')
    })

    test('blocks an unwritable temp root', () => {
        const findings = checkTemp([GB], '/tmp/x', 500 * GB, false, 4, 2)
        expect(findings[0]!.message).toContain('not writable')
    })

    test('says nothing when free space cannot be determined', () => {
        expect(checkTemp([GB], '/tmp/x', undefined, true, 4, 2)).toEqual([])
    })
})

describe('isWritable', () => {
    test('accepts a path that does not exist yet but has a writable parent', () => {
        const dir = mkdtempSync(join(tmpdir(), 'coport-w-'))
        expect(isWritable(join(dir, 'not', 'created', 'yet'))).toBe(true)
        rmSync(dir, { recursive: true, force: true })
    })

    test('rejects a path under an unwritable directory', () => {
        expect(isWritable('/proc/sys/kernel/coport-test')).toBe(false)
    })
})

// ---------------------------------------------------------------------------

describe('checkBridge', () => {
    test('warns about a bridge the node does not have', () => {
        const findings = checkBridge(
            'vmbr9',
            new Set(['lo', 'eno1', 'vmbr0', 'vmbr1'])
        )
        expect(findings[0]!.severity).toBe('warning')
        expect(findings[0]!.message).toContain('vmbr0, vmbr1')
    })

    test('is silent for a bridge that exists', () => {
        expect(checkBridge('vmbr0', new Set(['vmbr0']))).toEqual([])
    })

    test('is silent when the interface list is unavailable', () => {
        expect(checkBridge('vmbr0', undefined)).toEqual([])
    })
})

// ---------------------------------------------------------------------------

const probeResult = (over: Partial<ArtifactProbe> = {}): ArtifactProbe => ({
    template: 'debian-12',
    url: 'https://cdn.invalid/debian-12.qcow2',
    expected: GB,
    status: 200,
    length: GB,
    ...over,
})

describe('probeArtifacts', () => {
    test('HEADs each distinct URL once and reports status and length', async () => {
        let requests = 0
        const server = Bun.serve({
            port: 0,
            fetch(req) {
                requests++
                const { pathname } = new URL(req.url)
                if (pathname === '/missing.qcow2')
                    return new Response(null, { status: 404 })
                return new Response(null, {
                    status: 200,
                    headers: { 'content-length': String(GB) },
                })
            },
        })
        try {
            const base = `http://localhost:${server.port}`
            const one = item('deb', GB, 'local-lvm')
            one.template.disks[0]!.url = `${base}/deb.qcow2`
            // A second template pointing at the same artifact must not be
            // fetched twice, and a third that is simply not published.
            const dup = item('deb-again', GB, 'local-lvm')
            dup.template.disks[0]!.url = `${base}/deb.qcow2`
            const gone = item('win', GB, 'local-lvm')
            gone.template.disks[0]!.url = `${base}/missing.qcow2`

            const probes = await probeArtifacts([one, dup, gone])
            expect(probes).toHaveLength(2)
            expect(requests).toBe(2)
            expect(probes.find(x => x.url.endsWith('deb.qcow2'))).toMatchObject(
                { status: 200, length: GB }
            )
            expect(checkArtifacts(probes)).toHaveLength(1)
        } finally {
            server.stop(true)
        }
    })

    test('records a transport failure instead of throwing', async () => {
        const gone = item('deb', GB, 'local-lvm')
        gone.template.disks[0]!.url = 'http://127.0.0.1:1/nope.qcow2'
        const probes = await probeArtifacts([gone])
        expect(probes[0]!.status).toBeUndefined()
        expect(probes[0]!.error).toBeTruthy()
        expect(checkArtifacts(probes)[0]!.severity).toBe('warning')
    })
})

describe('checkArtifacts', () => {
    test('blocks a registry pointing at an unpublished artifact', () => {
        const findings = checkArtifacts([probeResult({ status: 404 })])
        expect(findings[0]!.severity).toBe('error')
        expect(findings[0]!.message).toContain('HTTP 404')
    })

    test('tolerates a server that refuses HEAD', () => {
        expect(checkArtifacts([probeResult({ status: 405 })])).toEqual([])
        expect(checkArtifacts([probeResult({ status: 501 })])).toEqual([])
    })

    test('warns on an unreachable host rather than blocking', () => {
        const findings = checkArtifacts([
            probeResult({ status: undefined, error: 'getaddrinfo ENOTFOUND' }),
        ])
        expect(findings[0]!.severity).toBe('warning')
    })

    test('warns when Content-Length disagrees with the registry', () => {
        const findings = checkArtifacts([probeResult({ length: 2 * GB })])
        expect(findings[0]!.severity).toBe('warning')
        expect(findings[0]!.message).toContain('registry may be stale')
    })

    test('accepts a well-formed artifact, and one with no Content-Length', () => {
        expect(checkArtifacts([probeResult()])).toEqual([])
        expect(checkArtifacts([probeResult({ length: undefined })])).toEqual([])
    })
})

// ---------------------------------------------------------------------------

describe('preflight', () => {
    const healthy = {
        downloadConcurrency: 4,
        restoreConcurrency: 2,
        bridge: 'vmbr0',
        tempRoot: '/tmp/coport-test',
        probes: {
            storages: async () => node(),
            tooling: async () => ({ qm: true, pvesm: true, root: true }),
            guest: async () => undefined,
            localNode: async () => 'pve1',
            bridges: async () => new Set(['vmbr0']),
            artifacts: async () => [],
            free: () => 500 * GB,
            writable: () => true,
        },
    }

    test('passes a healthy plan cleanly', async () => {
        const result = await preflight([item('deb', GB, 'local-lvm')], healthy)
        expect(result.errors).toEqual([])
        expect(result.warnings).toEqual([])
    })

    test('blocks the screenshot case: local, which cannot hold images', async () => {
        const result = await preflight([item('deb', GB, 'local')], healthy)
        expect(result.errors).toHaveLength(1)
        expect(result.errors[0]).toContain('does not support VM images')
    })

    test('collects findings from every check in one pass', async () => {
        const result = await preflight(
            [item('deb', GB, 'local', { vmid: 4001, overwrite: true })],
            {
                ...healthy,
                bridge: 'vmbr9',
                probes: {
                    ...healthy.probes,
                    tooling: async () => ({
                        qm: true,
                        pvesm: true,
                        root: false,
                    }),
                    guest: async () => guest({ running: true }),
                    artifacts: async () => [probeResult({ status: 404 })],
                },
            }
        )
        // not root · bad storage · running overwrite target · missing artifact
        expect(result.errors).toHaveLength(4)
        // bridge
        expect(result.warnings).toHaveLength(1)
    })

    test('skips storage checks, without blocking, when pvesm is unavailable', async () => {
        const result = await preflight([item('deb', GB, 'local')], {
            ...healthy,
            probes: {
                ...healthy.probes,
                storages: async () => undefined,
                tooling: async () => ({ qm: true, pvesm: false, root: true }),
            },
        })
        expect(result.errors).toEqual([])
        expect(result.warnings[0]).toContain('skipping the storage checks')
    })

    test('leaves the tooling checks out of a plan-only run', async () => {
        const probes = {
            ...healthy.probes,
            tooling: async () => ({ qm: false, pvesm: true, root: false }),
        }
        const blocked = await preflight([item('deb', GB, 'local-lvm')], {
            ...healthy,
            probes,
        })
        expect(blocked.errors).toHaveLength(2)
        const planOnly = await preflight([item('deb', GB, 'local-lvm')], {
            ...healthy,
            execute: false,
            probes,
        })
        expect(planOnly.errors).toEqual([])
    })

    test('passes the whole plan to the artifact sweep', async () => {
        let seen: InstallItem[] = []
        await preflight(
            [item('deb', GB, 'local-lvm'), item('ubuntu', GB, 'local-lvm')],
            {
                ...healthy,
                probes: {
                    ...healthy.probes,
                    artifacts: async items => {
                        seen = items
                        return []
                    },
                },
            }
        )
        expect(seen).toHaveLength(2)
    })
})
