import type { DiskImage } from '@/registry/schema.ts'
import type { Sidecar } from '@/upload/model.ts'

export type UploadVariables = Record<
    | 'file'
    | 'recipe'
    | 'arch'
    | 'sha256'
    | 'group'
    | 'name'
    | 'filename'
    | 'ext',
    string
>

export const renderUploadTemplate = (
    template: string,
    variables: Record<string, string>
): string => {
    let output = template
    for (const [key, value] of Object.entries(variables))
        output = output.split(`{{${key}}}`).join(value)
    return output
}

export const recipeNameFromSidecar = (sidecar: Sidecar): string =>
    sidecar.name.endsWith(`-${sidecar.arch}`)
        ? sidecar.name.slice(0, -(sidecar.arch.length + 1))
        : sidecar.name

/**
 * Placeholders for one artifact. A template now ships several images with
 * different hashes, so `{{sha256}}` and `{{filename}}` are per-DISK — rendering
 * them once for the whole template would mislabel every artifact but the first.
 * The exporter already wrote each disk's published name into `file`.
 */
export const uploadVariables = (
    sidecar: Sidecar,
    disk: DiskImage,
    file: string
): UploadVariables => {
    const recipe = recipeNameFromSidecar(sidecar)
    return {
        file,
        recipe,
        arch: sidecar.arch,
        sha256: disk.sha256,
        group: sidecar.group,
        name: recipe,
        filename: disk.file,
        ext: artifactExtension(sidecar, disk),
    }
}

/**
 * Extension of a published image, including the leading dot — `.qcow2` or
 * `.efivars.raw`. The default R2 key layout names objects by hash, so it needs
 * this separately to serve images with different extensions from one template.
 */
export const artifactExtension = (sidecar: Sidecar, disk: DiskImage): string =>
    disk.file.slice(`${sidecar.name}-${disk.sha256}`.length)

/**
 * Name of a disk's file as it sits in the output directory. The exporter writes
 * `<template>.qcow2` / `<template>.efivars.raw` locally but publishes under
 * `<template>-<sha256><ext>`, so the local name is the published one with the
 * hash removed — derived rather than re-listed, so the two cannot drift.
 */
export const localArtifactName = (sidecar: Sidecar, disk: DiskImage): string =>
    disk.file.replace(`${sidecar.name}-${disk.sha256}`, sidecar.name)

export const formatArtifactSize = (bytes: number): string => {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)}GB`
    if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)}MB`
    return `${(bytes / 1e3).toFixed(0)}KB`
}
