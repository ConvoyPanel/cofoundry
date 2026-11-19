import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OWNED_VMID_DIR } from '@/build/lease.ts'
import {
    canonicalPackerIsoPath,
    ephemeralPackerIsoFind,
    findBuildVmsCommand,
    isCofoundryVmidFunction,
    orphanDiskFind,
    ownedTelemetryCleanupCommand,
    ownedTelemetryFindCommand,
} from '@/prune/node.ts'

const ISO_STORE = '/var/lib/vz/template/iso'

describe('ephemeralPackerIsoFind', () => {
    test('always sweeps answer ISOs and hash-named download-cache copies', () => {
        const cmd = ephemeralPackerIsoFind(ISO_STORE, { preserveVirtio: false })
        expect(cmd).toContain(`find ${ISO_STORE} -maxdepth 1`)
        expect(cmd).toContain("-name 'packer*.iso'")
        expect(cmd).toContain("-name 'packer*.iso.tmp'")
        expect(cmd).toContain("-name 'packer*.iso.tmp.*'")
        expect(cmd).toContain('[0-9a-f]{40}')
    })

    test('preserveVirtio excludes the persistent virtio-win cache', () => {
        const cmd = ephemeralPackerIsoFind(ISO_STORE, { preserveVirtio: true })
        // The `! -name` exclusion must precede the match group so find ANDs it
        // against the pattern group rather than swallowing it into the OR.
        // A glob, so every pinned version (packer-virtio-win-<version>.iso)
        // and the legacy unversioned filename stay preserved.
        expect(cmd).toContain("! -name 'packer-virtio-win*.iso'")
        expect(cmd.indexOf('! -name')).toBeLessThan(cmd.indexOf('\\('))
    })

    test('without preserveVirtio the virtio cache is not spared', () => {
        const cmd = ephemeralPackerIsoFind(ISO_STORE, { preserveVirtio: false })
        expect(cmd).not.toContain('! -name')
    })

    test('routine mode is age-gated and skips media referenced by a VM', () => {
        const cmd = ephemeralPackerIsoFind(ISO_STORE, {
            preserveVirtio: true,
            olderThanDays: 7,
            unreferencedOnly: true,
        })
        expect(cmd).toContain('-mtime +7')
        expect(cmd).toContain('/etc/pve/qemu-server')
        expect(cmd).toContain('grep -RqsF')
        const result = spawnSync('bash', ['-n'], {
            input: cmd,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })
})

describe('canonicalPackerIsoPath', () => {
    test('maps interrupted prefetch names back to their locked destination', () => {
        expect(canonicalPackerIsoPath('/iso/packer-debian.iso')).toBe(
            '/iso/packer-debian.iso'
        )
        expect(canonicalPackerIsoPath('/iso/packer-debian.iso.tmp')).toBe(
            '/iso/packer-debian.iso'
        )
        expect(canonicalPackerIsoPath('/iso/packer-debian.iso.tmp.1234')).toBe(
            '/iso/packer-debian.iso'
        )
        expect(canonicalPackerIsoPath('/iso/packer-debian.iso.tmp.run-a')).toBe(
            '/iso/packer-debian.iso'
        )
    })
})

describe('orphanDiskFind', () => {
    const recipes = [{ buildVmid: 4001 }, { buildVmid: 2002 }]

    test('scopes the volume scan to the given storage pool', () => {
        const cmd = orphanDiskFind('local-zfs', recipes)
        expect(cmd).toContain("pvesm list 'local-zfs' --content images")
        expect(cmd).toContain('set -o pipefail')
    })

    test('shell-quotes the storage pool name', () => {
        expect(orphanDiskFind("a'b", recipes)).toContain("'a'\\''b'")
    })

    /**
     * Run the real command against a fake cluster: `pvesm` is a stub listing
     * `volumes`, and /etc/pve/nodes plus the ownership directory are redirected
     * into a temp dir holding the given VM configs.
     */
    const orphansOn = (
        volumes: { volid: string; vmid: number }[],
        configs: { node: string; kind: 'qemu-server' | 'lxc'; vmid: number }[],
        owned: number[] = []
    ): string[] => {
        const root = mkdtempSync(join(tmpdir(), 'cofoundry-orphans-'))
        try {
            for (const c of configs) {
                mkdirSync(join(root, 'nodes', c.node, c.kind), {
                    recursive: true,
                })
                writeFileSync(
                    join(root, 'nodes', c.node, c.kind, `${c.vmid}.conf`),
                    ''
                )
            }
            mkdirSync(join(root, 'owned'), { recursive: true })
            for (const vmid of owned)
                writeFileSync(join(root, 'owned', String(vmid)), '')
            const listing = [
                'Volid Format Type Size VMID',
                ...volumes.map(v => `${v.volid} raw images 1 ${v.vmid}`),
            ].join('\\n')
            const cmd = orphanDiskFind('shared-rbd', recipes)
                .replaceAll('/etc/pve/nodes', join(root, 'nodes'))
                .replaceAll(`'${OWNED_VMID_DIR}'`, `'${join(root, 'owned')}'`)
            const result = spawnSync(
                'bash',
                ['-c', `pvesm() { printf '${listing}\\n'; }\n${cmd}`],
                { encoding: 'utf8' }
            )
            expect(result.status).toBe(0)
            return result.stdout.split('\n').filter(Boolean)
        } finally {
            rmSync(root, { recursive: true, force: true })
        }
    }

    test('frees a cofoundry disk whose VM is gone from every node', () => {
        expect(
            orphansOn([{ volid: 'rbd:vm-400100-disk-0', vmid: 400100 }], [])
        ).toEqual(['rbd:vm-400100-disk-0'])
    })

    test('never frees a disk whose VM lives on another node', () => {
        // Shared storage lists every node's disks; `qm config` only sees the
        // local node, which is how a peer's live VM used to look orphaned.
        expect(
            orphansOn(
                [{ volid: 'rbd:vm-400100-disk-0', vmid: 400100 }],
                [{ node: 'pve2', kind: 'qemu-server', vmid: 400100 }]
            )
        ).toEqual([])
    })

    test('treats a container config as owning its VMID', () => {
        expect(
            orphansOn(
                [{ volid: 'rbd:vm-4001-disk-0', vmid: 4001 }],
                [{ node: 'pve3', kind: 'lxc', vmid: 4001 }]
            )
        ).toEqual([])
    })

    test('never frees a disk with a VMID cofoundry did not allocate', () => {
        expect(
            orphansOn([{ volid: 'rbd:vm-123-disk-0', vmid: 123 }], [])
        ).toEqual([])
    })

    test('frees a recorded build VMID outside the recipe ranges', () => {
        expect(
            orphansOn([{ volid: 'rbd:vm-777-disk-0', vmid: 777 }], [], [777])
        ).toEqual(['rbd:vm-777-disk-0'])
    })
})

describe('findBuildVmsCommand', () => {
    test('requires a cofoundry VMID, not just a packer-* name', () => {
        for (const includeTemplates of [true, false]) {
            const cmd = findBuildVmsCommand({
                recipes: [{ buildVmid: 4001 }],
                includeTemplates,
                olderThanDays: includeTemplates ? undefined : 3,
            })
            const nameMatch = cmd.indexOf('/^packer-/')
            const ownership = cmd.indexOf('is_cofoundry_vmid "$v" || continue')
            expect(nameMatch).toBeGreaterThan(-1)
            expect(ownership).toBeGreaterThan(nameMatch)
            expect(cmd.indexOf('echo "$v"')).toBeGreaterThan(ownership)
        }
    })
})

describe('isCofoundryVmidFunction', () => {
    const owned = (vmid: string): boolean =>
        spawnSync(
            'bash',
            [
                '-c',
                `${isCofoundryVmidFunction([{ buildVmid: 2002 }, { buildVmid: 1001 }])}\nis_cofoundry_vmid '${vmid}'`,
            ],
            { encoding: 'utf8' }
        ).status === 0

    test('claims recipe bases, their build slots, and the verify range', () => {
        for (const vmid of ['1001', '2002', '100100', '200249', '9500', '9999'])
            expect(owned(vmid)).toBe(true)
    })

    test('leaves every other VMID alone', () => {
        // 200250 is past the 50-slot block; 300100 belongs to no recipe.
        for (const vmid of ['100', '1002', '200250', '300100', '', 'abc'])
            expect(owned(vmid)).toBe(false)
    })
})

describe('ownedTelemetryCleanupCommand', () => {
    test('limits telemetry cleanup to recipe slots and verify VMIDs', () => {
        const cmd = ownedTelemetryCleanupCommand([
            { buildVmid: 2002 },
            { buildVmid: 1001 },
        ])
        expect(cmd).toContain('1001|2002|9[5-9][0-9][0-9]')
        expect(cmd).toContain('FORGET %s')
        expect(cmd).toContain('set -euo pipefail')
        expect(cmd).toContain('/var/log/vzdump/qemu-*.log')
        const result = spawnSync('bash', ['-n'], {
            input: cmd,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })

    test('tolerates rrdcached replies that mean nothing is cached', () => {
        const cmd = ownedTelemetryCleanupCommand([{ buildVmid: 1002 }])
        const start = cmd.indexOf('case "$response" in')
        const end = cmd.indexOf('esac', start)
        expect(start).toBeGreaterThan(-1)
        const caseBlock = cmd.slice(start, end + 'esac'.length)

        const check = (response: string) =>
            spawnSync('bash', ['-c', `rel=pve-vm-9.0/100200; ${caseBlock}`], {
                env: { ...process.env, response },
                encoding: 'utf8',
            })

        // An unknown RRD is already in the state FORGET aims for.
        expect(check('-1 No such file or directory').status).toBe(0)
        expect(check('0').status).toBe(0)
        expect(check('0 messages').status).toBe(0)
        // Real failures must still abort the clean.
        expect(check('-1 Invalid argument').status).toBe(1)
    })

    test('can verify telemetry absence without deleting it', () => {
        const cmd = ownedTelemetryFindCommand([{ buildVmid: 1001 }])
        expect(cmd).not.toContain('rm -f')
        expect(cmd).not.toContain('FORGET %s')
        const result = spawnSync('bash', ['-n'], {
            input: cmd,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })
})
