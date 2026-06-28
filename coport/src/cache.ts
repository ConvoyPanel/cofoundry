import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { Template } from '@/registry/schema.ts'

// Persistent record of what coport has installed on this node, so `--upgrade`
// can reinstall only changed templates and reuse the VMID the user picked last
// time instead of re-prompting. Stored next to ~/.coport/config.json.
const CACHE_PATH = join(homedir(), '.coport', 'cache.json')

export interface CacheRecord {
    /** Registry template name, e.g. "debian-12". Primary key. */
    name: string
    /** Human label at install time, e.g. "Debian 12". */
    display: string
    /** VMID the template was restored into (suggested, cached, or user-edited). */
    vmid: number
    /** Proxmox storage the template was restored to. */
    storage: string
    /** Version identity — changes when the template is rebuilt. */
    sha256: string
    builtAt: string
    /** ISO timestamp of the last successful install. */
    installedAt: string
}

const CacheRecordSchema = z.object({
    name: z.string(),
    display: z.string(),
    vmid: z.number(),
    storage: z.string(),
    sha256: z.string(),
    builtAt: z.string(),
    installedAt: z.string(),
})

const CacheSchema = z.object({
    version: z.literal(1),
    records: z.array(CacheRecordSchema),
})

export type Cache = Map<string, CacheRecord>

export const readCache = async (): Promise<Cache> => {
    let raw: string
    try {
        raw = await readFile(CACHE_PATH, 'utf8')
    } catch {
        return new Map()
    }
    const parsed = CacheSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return new Map()
    return new Map(parsed.data.records.map(r => [r.name, r]))
}

export const writeCache = async (cache: Cache): Promise<void> => {
    await mkdir(dirname(CACHE_PATH), { recursive: true })
    const payload = {
        version: 1 as const,
        records: [...cache.values()].sort((a, b) =>
            a.name.localeCompare(b.name)
        ),
    }
    await writeFile(CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

/** True when the registry template differs from what the cache last installed. */
export const isStale = (record: CacheRecord, template: Template): boolean =>
    record.sha256 !== template.sha256 || record.builtAt !== template.built_at

export const recordFor = (
    template: Template,
    vmid: number,
    storage: string
): CacheRecord => ({
    name: template.name,
    display: template.display,
    vmid,
    storage,
    sha256: template.sha256,
    builtAt: template.built_at,
    installedAt: new Date().toISOString(),
})
