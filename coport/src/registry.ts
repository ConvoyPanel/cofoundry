import { readFile } from 'node:fs/promises'
import { RegistrySchema, type Registry } from '@/registry/schema.ts'
import { RegistryKind, type RegistrySource } from './config.ts'
import { readStdinSync } from './tty.ts'
import { log } from '@cofoundry/ui'

// Read the raw registry text from wherever it lives. Note `Inline` vs `Stdin`:
// `Inline` already holds the JSON (it came in as a CLI argument), so we just hand
// it back; `Stdin` still has to be drained from fd 0. They are *not* the same —
// one is a string we already have, the other is a stream we must read.
const readSource = async (source: RegistrySource): Promise<string> => {
    switch (source.kind) {
        case RegistryKind.Inline:
            return source.json
        case RegistryKind.Stdin:
            return readStdinSync()
        case RegistryKind.File:
            return readFile(source.path, 'utf8')
        case RegistryKind.Url: {
            const res = await fetch(source.url)
            if (!res.ok) {
                throw new Error(
                    `Failed to fetch registry: ${res.status} ${res.statusText}`
                )
            }
            return res.text()
        }
    }
}

export const fetchRegistry = async (
    source: RegistrySource
): Promise<Registry> => {
    const raw = await readSource(source)

    let json: unknown
    try {
        json = JSON.parse(raw)
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(`Registry is not valid JSON: ${detail}`)
    }

    const parsed = RegistrySchema.safeParse(json)
    if (!parsed.success) {
        log.err(
            `Registry validation failed: ${JSON.stringify(parsed.error.format())}`
        )
        throw new Error('Invalid registry format. Try upgrading coport.')
    }

    if (parsed.data.schema_version !== '1') {
        throw new Error(
            `Unsupported registry schema_version: ${parsed.data.schema_version}. Upgrade coport.`
        )
    }

    return parsed.data
}
