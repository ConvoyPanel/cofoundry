import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import byteSize from 'byte-size'
import pc from 'picocolors'
import { log } from '@/log.ts'
import { s3api, s3Get } from '@/r2.ts'
import {
    systemDisk,
    templateSize,
    type Registry,
    type Group,
    type Sidecar,
    type Template,
} from '@/registry/schema.ts'
import { renderUploadTemplate, uploadVariables } from '@/upload/template.ts'

interface GroupDef {
    id: string
    display_name: string
    description?: string | null
}

const GROUPS_FILE = fileURLToPath(
    new URL('../registry.groups.json', import.meta.url)
)

const loadGroupDefs = async (): Promise<Map<string, GroupDef>> => {
    const defs: GroupDef[] = JSON.parse(await readFile(GROUPS_FILE, 'utf8'))
    return new Map(defs.map(g => [g.id, g]))
}

/**
 * Fill in a disk's public URL when the sidecar shipped without one.
 *
 * The exporter renders `url` from CF_PUBLIC_URL_TMPL at build time, so a build
 * that never saw that template writes `"url": ""` — and a registry entry with
 * no URL is one coport cannot download at all. Reconstructible here because the
 * object key and the public URL are both derived from the single `[upload].key`
 * template, against the same placeholders the uploader rendered: an entry
 * backfilled from a sidecar is byte-identical to one the exporter wrote.
 *
 * Recovery, not the mechanism — `buildRemoteEnv` exports the template for every
 * build. It is what lets a registry broken by a past build be repaired by a
 * re-publish instead of by rebuilding the images.
 */
export const withPublicUrls = (
    sidecar: Sidecar,
    template = process.env.CF_PUBLIC_URL_TMPL
): Sidecar => {
    if (!template || sidecar.disks.every(disk => disk.url)) return sidecar
    return {
        ...sidecar,
        disks: sidecar.disks.map(disk =>
            disk.url
                ? disk
                : {
                      ...disk,
                      url: renderUploadTemplate(
                          template,
                          uploadVariables(sidecar, disk, disk.file)
                      ),
                  }
        ),
    }
}

/** Every `template/slot` still lacking a download URL. */
export const disksMissingUrls = (registry: Registry): string[] =>
    registry.groups.flatMap(group =>
        group.templates.flatMap(template =>
            template.disks
                .filter(disk => !disk.url)
                .map(disk => `${template.name} (${disk.slot})`)
        )
    )

const assembleRegistry = (
    sidecars: Sidecar[],
    groupDefs: Map<string, GroupDef>
): Registry => {
    sidecars.sort((a, b) => a.name.localeCompare(b.name))

    const groupMap = new Map<string, Template[]>()
    for (const raw of sidecars) {
        const s = withPublicUrls(raw)
        const gid = s.group ?? 'other'
        if (!groupMap.has(gid)) groupMap.set(gid, [])
        // `group` and `schema_version` identify the sidecar, not the template;
        // the group becomes the enclosing Group and the version the registry's.
        const { group: _group, schema_version: _schema, ...template } = s
        groupMap.get(gid)!.push(template)
    }

    const groups: Group[] = []
    for (const [id, templates] of groupMap) {
        const def = groupDefs.get(id)
        groups.push({
            id,
            display_name:
                def?.display_name ??
                id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            description: def?.description ?? null,
            templates,
        })
    }

    return {
        schema_version: '2',
        name: 'Cofoundry Templates',
        description: 'Proxmox VM disk images built with Cofoundry',
        generated_at: new Date().toISOString(),
        groups,
    }
}

/**
 * Read the existing registry at `outPath`, if any. Returns null when the file
 * is missing or unparseable so callers just treat it as a fresh write.
 */
const readExistingRegistry = async (
    outPath: string
): Promise<Registry | null> => {
    try {
        return JSON.parse(await readFile(outPath, 'utf8')) as Registry
    } catch {
        return null
    }
}

const writeRegistry = async (
    outPath: string,
    registry: Registry
): Promise<string> => {
    // Refuse to publish a registry nobody can install from. `url` is the only
    // field coport cannot work around: it hands the value straight to fetch(),
    // so a blank one fails the template with "URL must not be a blank string"
    // and no template is installable. This is a hard error rather than a
    // warning because that is exactly how it shipped unnoticed once — a green
    // publish whose registry could not download a single image.
    const missing = disksMissingUrls(registry)
    if (missing.length > 0)
        throw new Error(
            `Refusing to write ${outPath}: no download URL for ${missing.join(', ')}. ` +
                `Set [upload].public_url in cofoundry.toml (or CF_PUBLIC_URL_TMPL) and re-run.`
        )

    const parent = dirname(outPath)
    if (parent && parent !== '.') await mkdir(parent, { recursive: true })

    // Keep the file byte-stable when only `generated_at` would change: every
    // publish regenerates the whole registry with a fresh timestamp, so without
    // this a no-op rebuild still produces a diff and defeats the CI commit
    // guard (`git diff --quiet`), churning registry.json's history. Reuse the
    // prior timestamp whenever the template data is otherwise identical.
    const existing = await readExistingRegistry(outPath)
    if (existing) {
        const sameExceptTimestamp =
            JSON.stringify({ ...existing, generated_at: '' }) ===
            JSON.stringify({ ...registry, generated_at: '' })
        if (sameExceptTimestamp) registry.generated_at = existing.generated_at
    }

    await writeFile(outPath, JSON.stringify(registry, null, 2) + '\n')
    const templateCount = registry.groups.reduce(
        (n, g) => n + g.templates.length,
        0
    )
    log.blank()
    log.ok(
        `Wrote ${pc.cyan(outPath)} ${pc.dim(`(${templateCount} templates in ${registry.groups.length} groups)`)}`
    )
    return outPath
}

export const buildManifest = async (
    sourceDir: string,
    outPath: string
): Promise<string> => {
    const groupDefs = await loadGroupDefs()

    log.section(`Publish ${pc.dim('·')} ${pc.cyan(sourceDir)}`)
    const entries = await readdir(sourceDir)
    const sidecars: Sidecar[] = []
    for (const entry of entries) {
        if (!entry.endsWith('.json') || entry === 'registry.json') continue
        const path = join(sourceDir, entry)
        const raw = await readFile(path, 'utf8')
        const parsed = JSON.parse(raw) as Sidecar
        sidecars.push(parsed)
        log.raw(
            `  ${pc.green('+')} ${pc.cyan(basename(entry, '.json').padEnd(28))} ${pc.dim(systemDisk(parsed).sha256.slice(0, 12) + '…')}  ${byteSize(templateSize(parsed))}`
        )
    }

    return writeRegistry(outPath, assembleRegistry(sidecars, groupDefs))
}

export interface R2Object {
    Key: string
    LastModified: string
    Size: number
}

const normalizeR2Prefix = (prefix: string): string => {
    const trimmed = prefix.replace(/^\/+|\/+$/g, '')
    return trimmed ? `${trimmed}/` : ''
}

export interface R2Sidecar {
    key: string
    lastModified: string
    sidecar: Sidecar
}

/**
 * Keep the newest sidecar per template. The template identity comes from the
 * sidecar CONTENT (`name` is already `recipe-arch` and constant across
 * versions), never from the R2 key. Key layout is user-configurable via
 * `[upload].layout` / `[upload].key`, so any scheme that parses the key path
 * breaks on some layout — e.g. `grouped` (templates/<group>/<recipe>-<arch>/…)
 * would collapse a whole group to one entry, and a custom
 * `{{recipe}}/{{recipe}}-{{arch}}-{{sha256}}` would collapse archs of the same
 * recipe. Grouping on content is correct for every layout.
 */
export const selectNewestSidecars = (items: R2Sidecar[]): R2Sidecar[] => {
    const newest = new Map<string, R2Sidecar>()
    for (const item of items) {
        const id = item.sidecar.name
        if (!id) continue
        const cur = newest.get(id)
        if (!cur || item.lastModified > cur.lastModified) newest.set(id, item)
    }
    return [...newest.values()]
}

/**
 * Aggregate sidecar JSONs from R2 into a registry, advertising the newest
 * artifact per template (not the full history). Every `.json` under the prefix
 * is fetched and parsed: the template identity lives in the sidecar content,
 * not the layout-dependent key, so we can't select newest-per-template from the
 * listing alone. Object count is bounded by the retention `cf prune --r2` keeps.
 */
export const buildManifestFromR2 = async (
    location: { endpoint: string; bucket: string; prefix: string },
    outPath: string,
    prefix = location.prefix
): Promise<string> => {
    const { endpoint, bucket } = location
    const normalizedPrefix = normalizeR2Prefix(prefix)

    log.section(
        `Publish ${pc.dim('·')} ${pc.cyan(`s3://${bucket}/${normalizedPrefix}`)}`
    )
    log.step(`listing objects`)
    const listArgs = ['list-objects-v2', '--bucket', bucket]
    if (normalizedPrefix) listArgs.push('--prefix', normalizedPrefix)
    const raw = await s3api(endpoint, listArgs)
    const parsed = raw.trim() ? JSON.parse(raw) : { Contents: [] }
    const objects: R2Object[] = parsed.Contents ?? []

    // The mirrored registry.json also ends in .json; never treat it as a sidecar.
    const sidecarObjects = objects.filter(
        o => o.Key.endsWith('.json') && basename(o.Key) !== 'registry.json'
    )
    const fetched = (
        await Promise.all(
            sidecarObjects.map(async o => {
                const body = await s3Get(endpoint, bucket, o.Key)
                try {
                    return {
                        key: o.Key,
                        lastModified: o.LastModified,
                        sidecar: JSON.parse(body) as Sidecar,
                    }
                } catch {
                    log.warn(`Skipping unparseable sidecar ${o.Key}`)
                    return null
                }
            })
        )
    ).filter((x): x is R2Sidecar => x !== null)

    const newest = selectNewestSidecars(fetched)

    const groupDefs = await loadGroupDefs()
    const sidecars: Sidecar[] = []
    for (const { sidecar } of newest) {
        sidecars.push(sidecar)
        log.raw(
            `  ${pc.green('+')} ${pc.cyan(sidecar.name.padEnd(28))} ${pc.dim(systemDisk(sidecar).sha256.slice(0, 12) + '…')}  ${byteSize(templateSize(sidecar))}`
        )
    }

    return writeRegistry(outPath, assembleRegistry(sidecars, groupDefs))
}
