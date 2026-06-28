import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_REGISTRY = 'https://cofoundry.cdn.convoypanel.com/registry.json'

interface CoportConfig {
    registry?: string
    storage?: string
}

const readConfigFile = async (): Promise<CoportConfig> => {
    const path = join(homedir(), '.coport', 'config.json')
    try {
        return JSON.parse(await readFile(path, 'utf8')) as CoportConfig
    } catch {
        return {}
    }
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
    | { kind: RegistryKind.Stdin }

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

export interface ResolvedConfig {
    source: RegistrySource
    defaultStorage?: string
}

export const resolveConfig = async (
    cliArg?: string
): Promise<ResolvedConfig> => {
    if (cliArg) {
        return { source: classifySource(cliArg) }
    }
    if (process.env.COPORT_REGISTRY) {
        return { source: classifySource(process.env.COPORT_REGISTRY) }
    }
    // No explicit registry: a non-TTY stdin means the document is being piped in.
    if (!process.stdin.isTTY) {
        return { source: { kind: RegistryKind.Stdin } }
    }
    const fileConfig = await readConfigFile()
    return {
        source: classifySource(fileConfig.registry ?? DEFAULT_REGISTRY),
        defaultStorage: fileConfig.storage,
    }
}
