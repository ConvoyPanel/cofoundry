import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
    mkdtemp,
    copyFile,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    buildManifest,
    disksMissingUrls,
    selectNewestSidecars,
    withPublicUrls,
    type R2Sidecar,
} from '../src/manifest.ts'
import type { Registry, Sidecar } from '../src/registry/schema.ts'

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

    test('refuses to publish a registry no consumer can download from', async () => {
        // A registry entry with a blank `url` is unusable: coport hands the
        // value to fetch() and every install of that template fails. Publishing
        // one succeeded silently once, and shipped a registry in which not a
        // single template could be installed.
        const previous = process.env.CF_PUBLIC_URL_TMPL
        delete process.env.CF_PUBLIC_URL_TMPL
        try {
            const sidecar = JSON.parse(
                await readFile(join(sourceDir, 'debian-12.json'), 'utf8')
            )
            sidecar.disks[0].url = ''
            await writeFile(
                join(sourceDir, 'debian-12.json'),
                JSON.stringify(sidecar)
            )

            await expect(buildManifest(sourceDir, outPath)).rejects.toThrow(
                'no download URL for debian-12-amd64 (scsi0)'
            )
            // Nothing half-written: the previous good registry is preferable to
            // a fresh broken one.
            expect(await readdir(sourceDir)).not.toContain('registry.json')
        } finally {
            if (previous === undefined) delete process.env.CF_PUBLIC_URL_TMPL
            else process.env.CF_PUBLIC_URL_TMPL = previous
        }
    })

    test('backfills a blank URL from the configured public URL template', async () => {
        const previous = process.env.CF_PUBLIC_URL_TMPL
        process.env.CF_PUBLIC_URL_TMPL =
            'https://cdn.example.com/templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}{{ext}}'
        try {
            const sidecar = JSON.parse(
                await readFile(join(sourceDir, 'debian-12.json'), 'utf8')
            )
            sidecar.disks[0].url = ''
            await writeFile(
                join(sourceDir, 'debian-12.json'),
                JSON.stringify(sidecar)
            )

            await buildManifest(sourceDir, outPath)
            const manifest = JSON.parse(await readFile(outPath, 'utf8'))
            const debian = manifest.groups
                .flatMap((g: any) => g.templates)
                .find((t: any) => t.name === 'debian-12-amd64')
            expect(debian.disks[0].url).toBe(
                'https://cdn.example.com/templates/debian/debian-12-amd64/aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888.qcow2'
            )
        } finally {
            if (previous === undefined) delete process.env.CF_PUBLIC_URL_TMPL
            else process.env.CF_PUBLIC_URL_TMPL = previous
        }
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

describe('withPublicUrls', () => {
    // The shape that actually shipped broken: a Windows template whose system
    // disk and EFI varstore both carry `"url": ""`.
    const blank = (): Sidecar =>
        ({
            name: 'windows-server-2022-amd64',
            display: 'Windows Server 2022 Datacenter',
            arch: 'amd64',
            group: 'windows-server',
            built_at: '2026-09-04T10:11:03Z',
            disks: [
                {
                    slot: 'scsi0',
                    role: 'system',
                    format: 'qcow2',
                    file: 'windows-server-2022-amd64-315736a10b7601b804d3d801aefb23fa73e71ebc6b3d6e04db35a67284b48268.qcow2',
                    url: '',
                    sha256: '315736a10b7601b804d3d801aefb23fa73e71ebc6b3d6e04db35a67284b48268',
                    size: 7480999936,
                },
                {
                    slot: 'efidisk0',
                    role: 'efivars',
                    format: 'raw',
                    file: 'windows-server-2022-amd64-64adaaed8f01e3007adff4e9ad0409d48a5e11d1980d06a9e22e492729ea9265.efivars.raw',
                    url: '',
                    sha256: '64adaaed8f01e3007adff4e9ad0409d48a5e11d1980d06a9e22e492729ea9265',
                    size: 540672,
                },
            ],
            hardware: { ostype: 'win11', bios: 'ovmf', machine: 'q35' },
        }) as Sidecar

    const TMPL =
        'https://cofoundry.cdn.convoypanel.com/templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}{{ext}}'

    test('reconstructs the address each artifact was actually uploaded to', () => {
        // Both URLs are the live objects: the images published fine, only the
        // metadata pointing at them was empty. Per-disk `{{sha256}}`/`{{ext}}`
        // matter — rendering once for the template would give the varstore the
        // system disk's hash and a `.qcow2` extension.
        const filled = withPublicUrls(blank(), TMPL)
        expect(filled.disks.map(d => d.url)).toEqual([
            'https://cofoundry.cdn.convoypanel.com/templates/windows-server/windows-server-2022-amd64/315736a10b7601b804d3d801aefb23fa73e71ebc6b3d6e04db35a67284b48268.qcow2',
            'https://cofoundry.cdn.convoypanel.com/templates/windows-server/windows-server-2022-amd64/64adaaed8f01e3007adff4e9ad0409d48a5e11d1980d06a9e22e492729ea9265.efivars.raw',
        ])
    })

    test('never overwrites a URL the exporter already wrote', () => {
        const sidecar = blank()
        sidecar.disks[0]!.url = 'https://mirror.example.com/pinned.qcow2'
        const filled = withPublicUrls(sidecar, TMPL)
        expect(filled.disks[0]!.url).toBe(
            'https://mirror.example.com/pinned.qcow2'
        )
        expect(filled.disks[1]!.url).toEndWith('.efivars.raw')
    })

    test('leaves the sidecar untouched when no template is configured', () => {
        const sidecar = blank()
        expect(withPublicUrls(sidecar, undefined)).toBe(sidecar)
    })
})

describe('disksMissingUrls', () => {
    const registryWith = (url: string): Registry =>
        ({
            schema_version: '2',
            name: 'Cofoundry Templates',
            description: '',
            generated_at: '2026-09-04T10:25:51.917Z',
            groups: [
                {
                    id: 'debian',
                    display_name: 'Debian',
                    description: null,
                    templates: [
                        {
                            name: 'debian-13-amd64',
                            display: 'Debian 13',
                            arch: 'amd64',
                            built_at: '2026-09-04T00:00:00Z',
                            disks: [
                                {
                                    slot: 'scsi0',
                                    role: 'system',
                                    format: 'qcow2',
                                    file: 'debian-13-amd64-abc.qcow2',
                                    url,
                                    sha256: 'abc',
                                    size: 1,
                                },
                            ],
                            hardware: {
                                ostype: 'l26',
                                bios: 'seabios',
                                machine: 'q35',
                            },
                        },
                    ],
                },
            ],
        }) as Registry

    test('names the template and slot that cannot be downloaded', () => {
        expect(disksMissingUrls(registryWith(''))).toEqual([
            'debian-13-amd64 (scsi0)',
        ])
    })

    test('reports nothing when every disk is addressable', () => {
        expect(
            disksMissingUrls(registryWith('https://example.com/a.qcow2'))
        ).toEqual([])
    })
})
