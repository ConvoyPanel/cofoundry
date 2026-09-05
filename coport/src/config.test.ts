import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RegistryKind, loadFileConfig, resolveConfig } from './config.ts'

let dir: string
let configPath: string
let savedRegistry: string | undefined
let savedRegistryUrl: string | undefined

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coport-config-'))
    configPath = join(dir, 'config.toml')
    savedRegistry = process.env.COPORT_REGISTRY
    savedRegistryUrl = process.env.REGISTRY_URL
    delete process.env.COPORT_REGISTRY
    delete process.env.REGISTRY_URL
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedRegistry === undefined) delete process.env.COPORT_REGISTRY
    else process.env.COPORT_REGISTRY = savedRegistry
    if (savedRegistryUrl === undefined) delete process.env.REGISTRY_URL
    else process.env.REGISTRY_URL = savedRegistryUrl
})

describe('coport config', () => {
    test('loads TOML and interpolates environment variables', async () => {
        process.env.REGISTRY_URL = 'https://registry.example.com/registry.json'
        writeFileSync(
            configPath,
            'registry = "${REGISTRY_URL}"\nstorage = "local-zfs"\n'
        )
        expect(await loadFileConfig([configPath])).toMatchObject({
            registry: 'https://registry.example.com/registry.json',
            storage: 'local-zfs',
            path: configPath,
        })
    })

    test('keeps file storage when an argument selects the registry', async () => {
        writeFileSync(configPath, 'storage = "fast"\n')
        const resolved = await resolveConfig(
            'https://other.example.com/r.json',
            {
                configPaths: [configPath],
                stdinIsTTY: true,
            }
        )
        expect(resolved.source.kind).toBe(RegistryKind.Url)
        expect(resolved.origin).toBe('argument')
        expect(resolved.defaultStorage).toBe('fast')
        expect(resolved.configPath).toBe(configPath)
    })

    test('keeps file storage when env selects the registry', async () => {
        process.env.COPORT_REGISTRY = 'https://env.example.com/r.json'
        writeFileSync(configPath, 'storage = "fast"\n')
        const resolved = await resolveConfig(undefined, {
            configPaths: [configPath],
            stdinIsTTY: true,
        })
        expect(resolved.origin).toBe('env')
        expect(resolved.defaultStorage).toBe('fast')
    })

    test('falls through to the default when a non-TTY stdin is empty', async () => {
        // `ssh node coport --all`, cron, systemd and `< /dev/null` all hand
        // coport a non-TTY fd 0 that carries no registry.
        const resolved = await resolveConfig(undefined, {
            configPaths: [configPath],
            stdinIsTTY: false,
            readStdin: () => '',
        })
        expect(resolved.source.kind).toBe(RegistryKind.Url)
        expect(resolved.origin).toBe('default')
    })

    test('prefers the config file over an empty non-TTY stdin', async () => {
        writeFileSync(
            configPath,
            'registry = "https://file.example.com/r.json"\n'
        )
        const resolved = await resolveConfig(undefined, {
            configPaths: [configPath],
            stdinIsTTY: false,
            readStdin: () => '   \n',
        })
        expect(resolved.source).toMatchObject({
            kind: RegistryKind.Url,
            url: 'https://file.example.com/r.json',
        })
        expect(resolved.origin).toBe('file')
    })

    test('uses a piped document when stdin actually carries one', async () => {
        const doc = '{"schema_version":"2"}'
        const resolved = await resolveConfig(undefined, {
            configPaths: [configPath],
            stdinIsTTY: false,
            readStdin: () => doc,
        })
        expect(resolved.source).toMatchObject({
            kind: RegistryKind.Stdin,
            json: doc,
        })
        expect(resolved.origin).toBe('stdin')
    })

    test('fails clearly when interpolation is unresolved', async () => {
        writeFileSync(configPath, 'registry = "${REGISTRY_URL}"\n')
        expect(loadFileConfig([configPath])).rejects.toThrow(
            /Unresolved environment variable.*REGISTRY_URL/
        )
    })
})
