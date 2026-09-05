import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { readStdinSync } from './tty.ts'

const DEFAULT_REGISTRY = 'https://cofoundry.cdn.convoypanel.com/registry.json'

const CoportConfigSchema = z.object({
    registry: z.string().optional(),
    storage: z.string().optional(),
})
type CoportConfig = z.infer<typeof CoportConfigSchema>

// Same config conventions as `cf`: TOML preferred, ${VAR} interpolation.
// The legacy JSON path is still read for back-compat.
const CONFIG_PATHS = [
    join(homedir(), '.config', 'coport', 'config.toml'),
    join(homedir(), '.coport', 'config.json'),
]

const interpolate = (
    value: string | undefined,
    field: string
): string | undefined => {
    if (value === undefined) return undefined
    const missing = new Set<string>()
    const resolved = value.replace(
        /\$\{([A-Z_][A-Z0-9_]*)\}/g,
        (_, name: string) => {
            const replacement = process.env[name]
            if (!replacement) missing.add(name)
            return replacement ?? ''
        }
    )
    if (missing.size > 0) {
        throw new Error(
            `Unresolved environment variable${missing.size === 1 ? '' : 's'} in coport ${field}: ${[...missing].join(', ')}`
        )
    }
    return resolved
}

interface LoadedConfig extends CoportConfig {
    /** Which file the config was read from, for `coport --config`. */
    path?: string
}

export const loadFileConfig = async (
    paths: readonly string[] = CONFIG_PATHS
): Promise<LoadedConfig> => readConfigFile(paths)

const readConfigFile = async (
    paths: readonly string[] = CONFIG_PATHS
): Promise<LoadedConfig> => {
    for (const path of paths) {
        let raw: string
        try {
            raw = await readFile(path, 'utf8')
        } catch {
            continue // try the next candidate
        }
        let parsed: CoportConfig
        try {
            parsed = CoportConfigSchema.parse(
                path.endsWith('.toml') ? parseToml(raw) : JSON.parse(raw)
            )
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            throw new Error(`Failed to parse ${path}: ${message}`)
        }
        return {
            registry: interpolate(parsed.registry, 'registry'),
            storage: interpolate(parsed.storage, 'storage'),
            path,
        }
    }
    return {}
}

// Where the registry document comes from. The two no-file modes are distinct:
// `Inline` carries a JSON document passed *as an argument* on the command line
// (`coport '{…}'`); `Stdin` reads the document *piped* into fd 0
// (`curl … | coport -`). Same payload, different transport.
export enum RegistryKind {
    Url = 'url',
    File = 'file',
    Inline = 'inline',
    Stdin = 'stdin',
}

export type RegistrySource =
    | { kind: RegistryKind.Url; url: string }
    | { kind: RegistryKind.File; path: string }
    | { kind: RegistryKind.Inline; json: string }
    | { kind: RegistryKind.Stdin; json?: string }

// A URL has a scheme like `https://`; anything else (absolute, ./relative,
// ../relative, or a bare filename) is treated as a local file path.
const hasUrlScheme = (s: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(s)

export const classifySource = (raw: string): RegistrySource => {
    const trimmed = raw.trim()
    if (trimmed === '-') return { kind: RegistryKind.Stdin }
    if (trimmed.startsWith('{')) return { kind: RegistryKind.Inline, json: raw }
    if (hasUrlScheme(trimmed)) return { kind: RegistryKind.Url, url: trimmed }
    return { kind: RegistryKind.File, path: trimmed }
}

export const describeSource = (source: RegistrySource): string => {
    switch (source.kind) {
        case RegistryKind.Url:
            return source.url
        case RegistryKind.File:
            return source.path
        case RegistryKind.Inline:
            return '<inline JSON>'
        case RegistryKind.Stdin:
            return '<stdin>'
    }
}

export type RegistryOrigin = 'argument' | 'env' | 'stdin' | 'file' | 'default'

export interface ResolvedConfig {
    source: RegistrySource
    defaultStorage?: string
    /** Where the registry setting came from (for `coport --config`). */
    origin: RegistryOrigin
    /** Config file the storage/registry defaults were read from, if any. */
    configPath?: string
}

interface ResolveOptions {
    configPaths?: readonly string[]
    stdinIsTTY?: boolean
    /** Injectable for tests; drains fd 0 by default. */
    readStdin?: () => string
}

export const resolveConfig = async (
    cliArg?: string,
    options: ResolveOptions = {}
): Promise<ResolvedConfig> => {
    const fileConfig = await readConfigFile(options.configPaths)
    const fileDefaults = {
        defaultStorage: fileConfig.storage,
        configPath: fileConfig.path,
    }
    if (cliArg) {
        return {
            source: classifySource(cliArg),
            origin: 'argument',
            ...fileDefaults,
        }
    }
    if (process.env.COPORT_REGISTRY) {
        return {
            source: classifySource(process.env.COPORT_REGISTRY),
            origin: 'env',
            ...fileDefaults,
        }
    }
    // No explicit registry: a non-TTY stdin *may* mean the document is being
    // piped in — but plenty of non-TTY fd 0s carry nothing at all (`ssh node
    // coport --all`, cron, systemd, CI, `< /dev/null`). Drain it and only treat
    // it as the registry if a document actually arrived; an empty read falls
    // through to the config file / built-in default instead of failing with a
    // JSON parse error. An explicit `-` argument still forces stdin.
    if (!(options.stdinIsTTY ?? process.stdin.isTTY)) {
        const piped = (options.readStdin ?? readStdinSync)()
        if (piped.trim()) {
            return {
                source: { kind: RegistryKind.Stdin, json: piped },
                origin: 'stdin',
                ...fileDefaults,
            }
        }
    }
    return {
        source: classifySource(fileConfig.registry ?? DEFAULT_REGISTRY),
        origin: fileConfig.registry ? 'file' : 'default',
        ...fileDefaults,
    }
}
