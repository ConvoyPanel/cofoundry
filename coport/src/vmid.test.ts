import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Template } from '@/registry/schema.ts'
import { findFreeVmid, resolveVmids, takenVmids, vmidTaken } from './vmid.ts'

let pveDir: string

beforeEach(() => {
    pveDir = mkdtempSync(join(tmpdir(), 'coport-pve-'))
})

afterEach(() => {
    rmSync(pveDir, { recursive: true, force: true })
})

const writeVmlist = (content: string): void => {
    writeFileSync(join(pveDir, '.vmlist'), content)
}

// Mirrors the pmxcfs output format (status.c cfs_create_vmlist_msg).
const vmlistWith = (ids: Record<string, { node: string; type: string }>) => {
    const entries = Object.entries(ids)
        .map(
            ([vmid, v]) =>
                `"${vmid}": { "node": "${v.node}", "type": "${v.type}", "version": 1 }`
        )
        .join(',\n')
    return `{\n"version": 5,\n"ids": {\n${entries}}\n}\n`
}

const writeConf = (
    node: string,
    kind: 'qemu-server' | 'lxc',
    vmid: number
): void => {
    const dir = join(pveDir, 'nodes', node, kind)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${vmid}.conf`), 'memory: 2048\n')
}

const template = (name: string, suggested?: number): Template => ({
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
            url: `https://example.com/${name}.qcow2`,
            sha256: 'a'.repeat(64),
            size: 1,
            virtual_size: '5G',
        },
    ],
    hardware: { ostype: 'l26', bios: 'seabios', machine: 'q35' },
    ...(suggested !== undefined && { suggested_vmid: suggested }),
})

describe('takenVmids', () => {
    test('collects VMIDs from every node via .vmlist', async () => {
        writeVmlist(
            vmlistWith({
                '9001': { node: 'pve-node01', type: 'qemu' },
                '20105': { node: 'pve-node02', type: 'qemu' },
                '300': { node: 'pve-node03', type: 'lxc' },
            })
        )
        expect(await takenVmids(pveDir)).toEqual(new Set([9001, 20105, 300]))
    })

    test('treats a .vmlist without an ids key as an empty cluster', async () => {
        // pmxcfs omits "ids" entirely when there are no guests; the file is
        // authoritative, so config directories must not be consulted.
        writeVmlist('{\n"version": 1\n}\n')
        writeConf('pve-node01', 'qemu-server', 9001)
        expect(await takenVmids(pveDir)).toEqual(new Set())
    })

    test('falls back to scanning node config dirs when .vmlist is missing', async () => {
        writeConf('pve-node01', 'qemu-server', 9001)
        writeConf('pve-node02', 'qemu-server', 20105)
        writeConf('pve-node03', 'lxc', 300)
        expect(await takenVmids(pveDir)).toEqual(new Set([9001, 20105, 300]))
    })

    test('falls back to scanning when .vmlist is malformed', async () => {
        writeVmlist('not json at all')
        writeConf('pve-node02', 'lxc', 4711)
        expect(await takenVmids(pveDir)).toEqual(new Set([4711]))
    })

    test('scan includes the local symlink dirs and ignores non-conf entries', async () => {
        const local = join(pveDir, 'qemu-server')
        mkdirSync(local, { recursive: true })
        writeFileSync(join(local, '100.conf'), '')
        writeFileSync(join(local, 'not-a-vm.txt'), '')
        writeConf('pve-node02', 'qemu-server', 200)
        expect(await takenVmids(pveDir)).toEqual(new Set([100, 200]))
    })

    test('returns an empty set for a mounted node with no guests', async () => {
        // A readable but empty nodes/ tree: genuinely no guests, not an
        // unreadable /etc/pve.
        mkdirSync(join(pveDir, 'nodes', 'pve-node01', 'qemu-server'), {
            recursive: true,
        })
        expect(await takenVmids(pveDir)).toEqual(new Set())
    })

    test('throws when the cluster state is entirely unreadable', async () => {
        // No .vmlist and no readable guest-config dirs — e.g. pmxcfs unmounted
        // mid pve-cluster restart. Reporting "nothing taken" here would assign
        // a colliding VMID that only fails after a multi-GB download, so refuse.
        expect(takenVmids(pveDir)).rejects.toThrow(/cluster state/)
    })
})

describe('vmidTaken', () => {
    test('detects guests that live on other cluster nodes', async () => {
        writeVmlist(
            vmlistWith({ '20105': { node: 'pve-node02', type: 'qemu' } })
        )
        expect(await vmidTaken(20105, pveDir)).toBe(true)
        expect(await vmidTaken(9000, pveDir)).toBe(false)
    })
})

describe('findFreeVmid', () => {
    test('skips both batch-reserved and cluster-taken VMIDs', () => {
        expect(findFreeVmid(9000, new Set([9001]), new Set([9000, 9002]))).toBe(
            9003
        )
    })
})

describe('resolveVmids', () => {
    test('reassigns when the suggested VMID is taken on another node', async () => {
        writeVmlist(
            vmlistWith({
                '9000': { node: 'pve-node02', type: 'qemu' },
                '9001': { node: 'pve-node03', type: 'qemu' },
            })
        )
        const [a] = await resolveVmids(
            [template('debian-13', 9001)],
            9000,
            false,
            undefined,
            pveDir
        )
        expect(a).toMatchObject({
            vmid: 9002,
            conflict: true,
            overwrite: false,
        })
    })

    test('keeps the suggested VMID and flags overwrite when allowed', async () => {
        writeVmlist(
            vmlistWith({ '9001': { node: 'pve-node02', type: 'qemu' } })
        )
        const [a] = await resolveVmids(
            [template('debian-13', 9001)],
            9000,
            true,
            undefined,
            pveDir
        )
        expect(a).toMatchObject({
            vmid: 9001,
            conflict: false,
            overwrite: true,
        })
    })

    test('prefers a cached VMID over the registry suggestion', async () => {
        // Empty but present .vmlist: a mounted, guest-less cluster.
        writeVmlist('{\n"version": 1\n}\n')
        const [a] = await resolveVmids(
            [template('debian-13', 9001)],
            9000,
            false,
            new Map([['debian-13', 12345]]),
            pveDir
        )
        expect(a).toMatchObject({ vmid: 12345, conflict: false })
    })

    test('assigns sequential free VMIDs within a batch', async () => {
        writeVmlist(vmlistWith({ '9000': { node: 'pve-node01', type: 'lxc' } }))
        const result = await resolveVmids(
            [template('a'), template('b')],
            9000,
            false,
            undefined,
            pveDir
        )
        expect(result.map(r => r.vmid)).toEqual([9001, 9002])
    })
})
