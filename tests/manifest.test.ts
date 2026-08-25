import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, copyFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    buildManifest,
    selectNewestSidecars,
    type R2Sidecar,
} from '../src/manifest.ts'

const sc = (
    name: string,
    lastModified: string,
    extra: Record<string, unknown> = {}
): R2Sidecar => ({
    key: `templates/${name}/${lastModified}.json`,
    lastModified,
    sidecar: {
        name,
        display: name,
        arch: 'amd64',
        group: name.split('-')[0]!,
        built_at: lastModified,
        disks: [
            {
                slot: 'scsi0',
                role: 'system',
                format: 'qcow2',
                file: `${name}.qcow2`,
                url: `https://example.com/${name}.qcow2`,
                sha256: lastModified.replace(/\D/g, ''),
                size: 100,
                virtual_size: '5G',
            },
        ],
        hardware: { ostype: 'l26', bios: 'seabios', machine: 'q35' },
        ...extra,
    } as R2Sidecar['sidecar'],
})

const FIXTURES = fileURLToPath(new URL('./fixtures/sidecars/', import.meta.url))

const stageFixtures = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-manifest-'))
    for (const entry of await readdir(FIXTURES)) {
        await copyFile(join(FIXTURES, entry), join(dir, entry))
    }
    return dir
}

describe('buildManifest', () => {
    let sourceDir: string
    let outPath: string

    beforeEach(async () => {
        sourceDir = await stageFixtures()
        outPath = join(sourceDir, 'registry.json')
    })

    test('writes registry.json with schema_version "2" and a generated_at timestamp', async () => {
        const path = await buildManifest(sourceDir, outPath)
        expect(path).toBe(outPath)

        const manifest = JSON.parse(await readFile(path, 'utf8'))
        expect(manifest.schema_version).toBe('2')
        expect(typeof manifest.generated_at).toBe('string')
        expect(() =>
            new Date(manifest.generated_at).toISOString()
        ).not.toThrow()
    })

    test('organizes templates into groups with sorted names', async () => {
        await buildManifest(sourceDir, outPath)
        const manifest = JSON.parse(await readFile(outPath, 'utf8'))

        expect(Array.isArray(manifest.groups)).toBe(true)

        const allNames = manifest.groups.flatMap((g: any) =>
            g.templates.map((t: any) => t.name)
        )
        expect(allNames.sort()).toEqual([
            'almalinux-9-amd64',
            'debian-12-amd64',
        ])
    })

    test('assigns correct group display names from registry.groups.json', async () => {
        await buildManifest(sourceDir, outPath)
        const manifest = JSON.parse(await readFile(outPath, 'utf8'))

        const debian = manifest.groups.find((g: any) => g.id === 'debian')
        expect(debian?.display_name).toBe('Debian')

        const alma = manifest.groups.find((g: any) => g.id === 'almalinux')
        expect(alma?.display_name).toBe('AlmaLinux')
    })

    test('carries the disk set and hardware profile through verbatim', async () => {
        await buildManifest(sourceDir, outPath)
        const manifest = JSON.parse(await readFile(outPath, 'utf8'))
        const allTemplates = manifest.groups.flatMap((g: any) => g.templates)
        const debian = allTemplates.find(
            (t: any) => t.name === 'debian-12-amd64'
        )
        expect(debian).toMatchObject({
            display: 'Debian 12 (Bookworm)',
            arch: 'amd64',
            suggested_vmid: 4001,
            built_at: '2026-05-18T12:00:00Z',
            minimum: { cores: 1, memory: 1024 },
        })
        // The hardware profile is what a consumer rebuilds the VM from, so it
        // has to survive aggregation intact rather than being summarized.
        expect(debian.hardware).toEqual({
            ostype: 'l26',
            bios: 'seabios',
            machine: 'q35',
            scsihw: 'virtio-scsi-single',
            cpu: 'host',
            agent: 1,
            net_model: 'virtio',
            serial0: 'socket',
            ciuser: 'root',
        })
        expect(debian.disks).toHaveLength(1)
        expect(debian.disks[0]).toMatchObject({
            slot: 'scsi0',
            role: 'system',
            format: 'qcow2',
            sha256: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888',
            size: 1572864000,
            virtual_size: '5G',
        })

        // `group` identifies the sidecar, not the template: it becomes the
        // enclosing Group and must not be duplicated onto the entry.
        expect(debian).not.toHaveProperty('group')
        expect(debian).not.toHaveProperty('schema_version')
    })

    test('does not include a pre-existing registry.json as a template', async () => {
        await buildManifest(sourceDir, outPath) // creates registry.json in source
        await buildManifest(sourceDir, outPath) // second pass should ignore it
        const manifest = JSON.parse(await readFile(outPath, 'utf8'))
        const allTemplates = manifest.groups.flatMap((g: any) => g.templates)
        expect(allTemplates).toHaveLength(2)
        expect(
            allTemplates.find((t: any) => t.name === 'registry')
        ).toBeUndefined()
    })

    test('keeps registry.json byte-stable when only generated_at would change', async () => {
        await buildManifest(sourceDir, outPath)
        const first = await readFile(outPath, 'utf8')
        // Re-publish from the same sidecars: nothing but generated_at would
        // otherwise change, so the file must be untouched (CI commit guard).
        await buildManifest(sourceDir, outPath)
        const second = await readFile(outPath, 'utf8')
        expect(second).toBe(first)
    })

    afterEach(async () => {
        await rm(sourceDir, { recursive: true, force: true })
    })
})

describe('selectNewestSidecars', () => {
    const names = (items: R2Sidecar[]): string[] =>
        items.map(i => i.sidecar.name).sort()

    test('picks the newest version per template by LastModified', () => {
        const newest = selectNewestSidecars([
            sc('almalinux-10-amd64', '2026-01-01T00:00:00.000Z'),
            sc('almalinux-10-amd64', '2026-02-01T00:00:00.000Z'),
        ])
        expect(newest).toHaveLength(1)
        expect(newest[0]?.lastModified).toBe('2026-02-01T00:00:00.000Z')
    })

    test('keeps every template in a group distinct (no group collapse)', () => {
        // Three AlmaLinux releases share the `almalinux` group but are separate
        // templates; grouping on content name must keep all three.
        const newest = selectNewestSidecars([
            sc('almalinux-8-amd64', '2026-01-01T00:00:00.000Z'),
            sc('almalinux-9-amd64', '2026-02-01T00:00:00.000Z'),
            sc('almalinux-10-amd64', '2026-03-01T00:00:00.000Z'),
            sc('debian-12-amd64', '2026-04-01T00:00:00.000Z'),
        ])
        expect(names(newest)).toEqual([
            'almalinux-10-amd64',
            'almalinux-8-amd64',
            'almalinux-9-amd64',
            'debian-12-amd64',
        ])
    })

    test('keeps distinct archs of the same recipe distinct', () => {
        // A custom key like {{recipe}}/{{recipe}}-{{arch}}-{{sha256}} shares a
        // directory across archs; content grouping still separates them.
        const newest = selectNewestSidecars([
            sc('debian-12-amd64', '2026-01-01T00:00:00.000Z'),
            sc('debian-12-arm64', '2026-01-01T00:00:00.000Z', {
                arch: 'arm64',
            }),
        ])
        expect(names(newest)).toEqual(['debian-12-amd64', 'debian-12-arm64'])
    })

    test('ignores sidecars with no name', () => {
        const newest = selectNewestSidecars([
            { ...sc('debian-12-amd64', '2026-01-01T00:00:00.000Z') },
            {
                key: 'templates/registry.json',
                lastModified: '2026-02-01T00:00:00.000Z',
                sidecar: { name: '' } as R2Sidecar['sidecar'],
            },
        ])
        expect(names(newest)).toEqual(['debian-12-amd64'])
    })
})
