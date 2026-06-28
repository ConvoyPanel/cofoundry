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

// Where the registry document comes from. `inline` carries a JSON document passed
// directly on the command line; `stdin` is read from fd 0 (piped in).
export type RegistrySource =
    | { kind: 'url'; url: string }
    | { kind: 'file'; path: string }
    | { kind: 'inline'; json: string }
    | { kind: 'stdin' }

// A URL has a scheme like `https://`; anything else (absolute, ./relative,
// ../relative, or a bare filename) is treated as a local file path.
const hasUrlScheme = (s: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(s)

export const classifySource = (raw: string): RegistrySource => {
    const trimmed = raw.trim()
    if (trimmed === '-') return { kind: 'stdin' }
    if (trimmed.startsWith('{')) return { kind: 'inline', json: raw }
    if (hasUrlScheme(trimmed)) return { kind: 'url', url: trimmed }
    return { kind: 'file', path: trimmed }
}

export const describeSource = (source: RegistrySource): string => {
    switch (source.kind) {
        case 'url':
            return source.url
        case 'file':
            return source.path
        case 'inline':
            return '<inline JSON>'
        case 'stdin':
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
        return { source: { kind: 'stdin' } }
    }
    const fileConfig = await readConfigFile()
    return {
        source: classifySource(fileConfig.registry ?? DEFAULT_REGISTRY),
        defaultStorage: fileConfig.storage,
    }
}

export const isFilePath = (source: string): boolean =>
    source.startsWith('/') || source.startsWith('./')
