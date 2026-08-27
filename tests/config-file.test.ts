import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    resolveConfig,
    applyConfigToEnv,
    uploadPathTemplate,
} from '../src/config-file.ts'

let dir: string
const savedEnv: Record<string, string | undefined> = {}

// Keys the tests touch — snapshot/restore so cases don't leak into each other.
const TOUCHED = [
    'PVE_HOST',
    'PVE_NODE',
    'PVE_PORT',
    'SSH_TARGET',
    'CF_STORAGE',
    'CF_BRIDGE',
    'R2_ENDPOINT',
    'R2_BUCKET',
    'CF_UPLOAD_CMD',
    'CF_SIDECAR_UPLOAD_CMD',
    'CF_PUBLIC_URL_TMPL',
    'CF_BUILD_CONCURRENCY',
    'CF_BUILD_MEMORY_BUDGET_MB',
    'CF_BUILD_CPU_BUDGET',
    'FROM_ENV',
]

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cf-config-'))
    for (const k of TOUCHED) {
        savedEnv[k] = process.env[k]
        delete process.env[k]
    }
})

afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of TOUCHED) {
        if (savedEnv[k] === undefined) delete process.env[k]
        else process.env[k] = savedEnv[k]
    }
})

const writeToml = (name: string, body: string): void =>
    writeFileSync(join(dir, name), body)

const find = (rows: ReturnType<typeof resolveConfig>, key: string) =>
    rows.find(r => r.key === key)

describe('resolveConfig', () => {
    test('returns [] when no config file exists', () => {
        expect(resolveConfig(dir)).toEqual([])
    })

    test('maps toml fields to canonical env keys', () => {
        writeToml(
            'cofoundry.toml',
            `[node]\nhost = "pve.example.com"\nport = 8006\n[storage]\ndisks = "fast"\n[build]\nconcurrency = 3\nmemory_budget_mb = 16384\ncpu_budget = 8\n`
        )
        const rows = resolveConfig(dir)
        expect(find(rows, 'PVE_HOST')).toMatchObject({
            value: 'pve.example.com',
            source: 'toml',
        })
        // Numbers are stringified.
        expect(find(rows, 'PVE_PORT')).toMatchObject({ value: '8006' })
        expect(find(rows, 'CF_STORAGE')).toMatchObject({ value: 'fast' })
        expect(find(rows, 'CF_BUILD_CONCURRENCY')).toMatchObject({
            value: '3',
        })
        expect(find(rows, 'CF_BUILD_MEMORY_BUDGET_MB')).toMatchObject({
            value: '16384',
        })
        expect(find(rows, 'CF_BUILD_CPU_BUDGET')).toMatchObject({ value: '8' })
        expect(find(rows, 'CF_OUT_DIR')).toMatchObject({
            value: './dist',
            source: 'default',
        })
    })

    test('env wins over the file', () => {
        writeToml('cofoundry.toml', `[node]\nhost = "from-file"\n`)
        process.env.PVE_HOST = 'from-env'
        expect(find(resolveConfig(dir), 'PVE_HOST')).toMatchObject({
            value: 'from-env',
            source: 'env',
        })
    })

    test('${VAR} interpolates from the environment', () => {
        writeToml('cofoundry.toml', `[node]\nssh = "root@\${FROM_ENV}"\n`)
        process.env.FROM_ENV = 'host.lan'
        expect(find(resolveConfig(dir), 'SSH_TARGET')).toMatchObject({
            value: 'root@host.lan',
            source: 'toml',
            detail: 'root@${FROM_ENV}',
        })
    })

    test('unset ${VAR} yields an unresolved field', () => {
        writeToml('cofoundry.toml', `[node]\nhost = "\${FROM_ENV}"\n`)
        expect(find(resolveConfig(dir), 'PVE_HOST')).toMatchObject({
            value: undefined,
            source: 'unset',
        })
    })

    test('cofoundry.local.toml overrides cofoundry.toml', () => {
        writeToml('cofoundry.toml', `[node]\nhost = "base"\n`)
        writeToml('cofoundry.local.toml', `[node]\nhost = "override"\n`)
        expect(find(resolveConfig(dir), 'PVE_HOST')).toMatchObject({
            value: 'override',
            source: 'local',
        })
    })
})

describe('[upload] derivation', () => {
    test('grouped layout generates prune-safe commands + url', () => {
        writeToml(
            'cofoundry.toml',
            `[upload]\nendpoint = "https://r2.example.com"\nbucket = "b"\nlayout = "grouped"\npublic_url = "https://cdn.example.com/"\n`
        )
        const rows = resolveConfig(dir)
        expect(find(rows, 'CF_UPLOAD_CMD')).toMatchObject({
            source: 'derived',
            value: 'aws --endpoint-url $R2_ENDPOINT s3 cp {{file}} s3://$R2_BUCKET/templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}{{ext}}',
        })
        expect(find(rows, 'CF_SIDECAR_UPLOAD_CMD')?.value).toEndWith('.json')
        expect(find(rows, 'CF_PUBLIC_URL_TMPL')).toMatchObject({
            value: 'https://cdn.example.com/templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}{{ext}}',
        })
    })

    test('flat layout omits the group segment', () => {
        writeToml(
            'cofoundry.toml',
            `[upload]\nendpoint = "https://r2.example.com"\nbucket = "b"\nlayout = "flat"\n`
        )
        expect(find(resolveConfig(dir), 'CF_UPLOAD_CMD')?.value).toContain(
            'templates/{{recipe}}-{{arch}}/{{sha256}}{{ext}}'
        )
    })

    test('explicit key reproduces a custom per-recipe layout', () => {
        // The real convoypanel layout: per-recipe dir, content-addressed key.
        writeToml(
            'cofoundry.toml',
            `[upload]\nendpoint = "https://r2.example.com"\nbucket = "convoy-cofoundry"\nkey = "{{recipe}}/{{recipe}}-{{arch}}-{{sha256}}"\npublic_url = "https://cofoundry.cdn.convoypanel.com"\n`
        )
        const rows = resolveConfig(dir)
        expect(find(rows, 'CF_UPLOAD_CMD')?.value).toBe(
            'aws --endpoint-url $R2_ENDPOINT s3 cp {{file}} s3://$R2_BUCKET/{{recipe}}/{{recipe}}-{{arch}}-{{sha256}}{{ext}}'
        )
        expect(find(rows, 'CF_PUBLIC_URL_TMPL')?.value).toBe(
            'https://cofoundry.cdn.convoypanel.com/{{recipe}}/{{recipe}}-{{arch}}-{{sha256}}{{ext}}'
        )
    })

    test('key with a trailing extension is normalized away', () => {
        writeToml(
            'cofoundry.toml',
            `[upload]\nendpoint = "https://r2.example.com"\nbucket = "b"\nkey = "a/{{sha256}}.qcow2"\n`
        )
        expect(find(resolveConfig(dir), 'CF_UPLOAD_CMD')?.value).toBe(
            'aws --endpoint-url $R2_ENDPOINT s3 cp {{file}} s3://$R2_BUCKET/a/{{sha256}}{{ext}}'
        )
    })

    test('raw command override wins over generation', () => {
        writeToml(
            'cofoundry.toml',
            `[upload]\nbucket = "b"\ncommand = "custom {{file}}"\n`
        )
        expect(find(resolveConfig(dir), 'CF_UPLOAD_CMD')?.value).toBe(
            'custom {{file}}'
        )
    })

    test('unresolved R2 coordinates do not enable uploads', () => {
        writeToml(
            'cofoundry.toml',
            `[upload]\nendpoint = "\${R2_ENDPOINT}"\nbucket = "\${R2_BUCKET}"\nlayout = "grouped"\npublic_url = "https://cdn.example.com"\n`
        )
        const rows = resolveConfig(dir)
        expect(find(rows, 'CF_UPLOAD_CMD')).toBeUndefined()
        expect(find(rows, 'CF_SIDECAR_UPLOAD_CMD')).toBeUndefined()
        expect(find(rows, 'CF_PUBLIC_URL_TMPL')).toBeUndefined()
    })

    test('invalid layout throws', () => {
        writeToml('cofoundry.toml', `[upload]\nlayout = "weird"\n`)
        expect(() => resolveConfig(dir)).toThrow(/grouped.*flat|flat.*grouped/)
    })

    test('uploadPathTemplate exposes both layouts', () => {
        expect(uploadPathTemplate('grouped')).toContain('{{group}}')
        expect(uploadPathTemplate('flat')).not.toContain('{{group}}')
    })
})

describe('applyConfigToEnv', () => {
    test('seeds unset keys and never overrides env', () => {
        writeToml('cofoundry.toml', `[node]\nhost = "seeded"\nnode = "n"\n`)
        process.env.PVE_NODE = 'env-node'
        applyConfigToEnv(dir)
        expect(process.env.PVE_HOST).toBe('seeded') // was unset → seeded
        expect(process.env.PVE_NODE).toBe('env-node') // env preserved
    })
})
