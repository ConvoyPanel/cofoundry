import { basename } from 'node:path'
import { accent, dim } from '@cofoundry/ui'
import { log } from '@/log.ts'
import type { Sidecar } from '@/registry/schema.ts'
import { s3api, s3Get } from '@/r2.ts'

export type PruneR2Options = {
    keep: number
    dryRun: boolean
}

export type R2Location = {
    endpoint: string
    bucket: string
    prefix: string
}

export type R2Object = {
    Key: string
    LastModified: string
    Size: number
}

/**
 * A published generation: one sidecar plus the images it names. Retention is
 * driven by these rather than by the object listing alone, because a schema-2
 * template is several objects with DIFFERENT hashes -- there is no string
 * substitution that can pair a `.qcow2` with its `.efivars.raw` and its
 * sidecar the way `key.replace(/\.vma\.zst$/, '.json')` once paired two.
 */
export type R2Generation = {
    key: string
    lastModified: string
    /** `sidecar.name` -- the template identity, constant across versions. */
    template: string
    /** sha256 of every image this generation references. */
    hashes: string[]
}

export type R2PruneGroup = {
    template: string
    generations: number
    stale: R2Generation[]
}

export type R2PrunePlan = {
    groups: R2PruneGroup[]
    /** Images referenced by no surviving generation. */
    orphanObjects: string[]
    deletions: string[]
}

/** Object suffixes prune considers a template image. */
const IMAGE_SUFFIXES = ['.qcow2', '.efivars.raw', '.raw', '.vmdk']

const isImage = (key: string): boolean =>
    IMAGE_SUFFIXES.some(suffix => key.endsWith(suffix))

/**
 * Decide what to delete, keeping the `keep` newest generations per template.
 *
 * Objects are matched to a generation by the sha256 embedded in their key, not
 * by path shape: `[upload].layout` / `[upload].key` are user-configurable, so
 * any rule that parses the key path breaks on some layout. Every layout that
 * can be pruned at all is content-addressed, and each image's hash is unique.
 *
 * An image whose hash matches no surviving generation is deleted, which covers
 * both superseded versions and images orphaned by a failed publish. Objects
 * that are neither a sidecar nor a recognized image extension are never
 * touched -- the prefix may hold things prune did not put there.
 */
export const planR2Prune = (
    objects: R2Object[],
    generations: R2Generation[],
    keep: number
): R2PrunePlan => {
    if (!Number.isInteger(keep) || keep < 0)
        throw new Error('--keep must be a non-negative integer')

    const byTemplate = new Map<string, R2Generation[]>()
    for (const generation of generations) {
        if (!generation.template) continue
        const list = byTemplate.get(generation.template) ?? []
        list.push(generation)
        byTemplate.set(generation.template, list)
    }

    const deletions: string[] = []
    const liveHashes = new Set<string>()
    const groups: R2PruneGroup[] = []
    for (const [template, list] of byTemplate) {
        list.sort((a, b) => b.lastModified.localeCompare(a.lastModified))
        const live = list.slice(0, keep)
        const stale = list.slice(keep)
        for (const generation of live)
            for (const hash of generation.hashes) liveHashes.add(hash)
        for (const generation of stale) deletions.push(generation.key)
        groups.push({ template, generations: list.length, stale })
    }

    // A stale generation may share an image with a live one (an unchanged
    // varstore across rebuilds), so the live set has to be complete before any
    // image is judged.
    const orphanObjects = objects
        .filter(object => isImage(object.Key))
        .filter(object => ![...liveHashes].some(h => object.Key.includes(h)))
        .map(object => object.Key)

    deletions.push(...orphanObjects)
    return { groups, orphanObjects, deletions }
}

export const runPruneR2 = async (
    { endpoint, bucket, prefix }: R2Location,
    { keep, dryRun }: PruneR2Options
): Promise<void> => {
    log.section(`R2 prune ${dim('·')} ${accent(`s3://${bucket}/${prefix}`)}`)
    if (dryRun) log.warn('dry-run: no objects will be deleted')
    log.step('listing objects')
    const raw = await s3api(endpoint, [
        'list-objects-v2',
        '--bucket',
        bucket,
        '--prefix',
        prefix,
    ])
    const parsed = raw.trim() ? JSON.parse(raw) : { Contents: [] }
    const objects: R2Object[] = parsed.Contents ?? []

    // Retention needs the sidecars' CONTENTS, not just their keys: only the
    // sidecar knows which images belong to which generation. The mirrored
    // registry.json also ends in .json and is never a sidecar.
    const sidecarObjects = objects.filter(
        o => o.Key.endsWith('.json') && basename(o.Key) !== 'registry.json'
    )
    log.step(`reading ${sidecarObjects.length} sidecar(s)`)
    const generations = (
        await Promise.all(
            sidecarObjects.map(async o => {
                try {
                    const sidecar = JSON.parse(
                        await s3Get(endpoint, bucket, o.Key)
                    ) as Sidecar
                    return {
                        key: o.Key,
                        lastModified: o.LastModified,
                        template: sidecar.name,
                        hashes: (sidecar.disks ?? []).map(d => d.sha256),
                    }
                } catch {
                    // An unreadable sidecar must not make its images look
                    // orphaned; skipping it leaves them untouched this run.
                    log.warn(`skipping unparseable sidecar ${o.Key}`)
                    return null
                }
            })
        )
    ).filter((g): g is R2Generation => g !== null)

    const plan = planR2Prune(objects, generations, keep)

    for (const group of plan.groups) {
        if (group.stale.length === 0) {
            log.info(
                `${accent(group.template)} ${dim('·')} ${group.generations} generation(s), within keep=${keep}`
            )
            continue
        }
        const verb = dryRun ? 'would delete' : 'deleting'
        log.ok(
            `${accent(group.template)} ${dim('·')} ${group.generations} generation(s), ${verb} ${group.stale.length}`
        )
        for (const generation of group.stale)
            log.note(`${generation.key}  (${generation.lastModified})`)
    }
    if (plan.orphanObjects.length > 0) {
        const verb = dryRun ? 'would delete' : 'deleting'
        log.ok(
            `unreferenced images ${dim('·')} ${verb} ${plan.orphanObjects.length}`
        )
        for (const key of plan.orphanObjects) log.note(key)
    }

    if (!dryRun) {
        for (const key of plan.deletions) {
            await s3api(endpoint, [
                'delete-object',
                '--bucket',
                bucket,
                '--key',
                key,
            ])
        }
    }
    log.blank()
    log.ok(
        dryRun
            ? `Dry-run: ${plan.deletions.length} object(s) would be deleted across ${plan.groups.length} template(s).`
            : `Deleted ${plan.deletions.length} object(s) across ${plan.groups.length} template(s).`
    )
}
