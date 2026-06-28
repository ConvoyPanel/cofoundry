import { readFile } from 'node:fs/promises'
import { RegistrySchema, type Registry } from '../../src/registry/schema.ts'
import type { RegistrySource } from './config.ts'
import { readStdinSync } from './tty.ts'
import { log } from '@cofoundry/ui'

const readSource = async (source: RegistrySource): Promise<string> => {
    switch (source.kind) {
        case 'inline':
            return source.json
        case 'stdin':
            return readStdinSync()
        case 'file':
            return readFile(source.path, 'utf8')
        case 'url': {
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
