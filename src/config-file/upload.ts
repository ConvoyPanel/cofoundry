import {
    getConfigPath,
    interpolateConfigValue,
    isObject,
    type Toml,
} from '@/config-file/toml.ts'

export type UploadLayout = 'grouped' | 'flat'
export type DerivedUpload = {
    uploadCmd?: string
    sidecarCmd?: string
    publicUrl?: string
}

const LAYOUT_KEY: Record<UploadLayout, string> = {
    grouped: 'templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}',
    flat: 'templates/{{recipe}}-{{arch}}/{{sha256}}',
}

export const uploadPathTemplate = (layout: UploadLayout): string =>
    LAYOUT_KEY[layout]

const resolveKeyTemplate = (upload: Record<string, unknown>): string => {
    if (upload.key !== undefined && typeof upload.key !== 'string')
        throw new Error('cofoundry.toml [upload].key must be a string')
    if (upload.key)
        return upload.key
            .replace(/\.(qcow2|efivars\.raw|json)$/, '')
            .replace(/^\/+/, '')
    const layout = upload.layout ?? 'grouped'
    if (layout !== 'grouped' && layout !== 'flat')
        throw new Error(
            `cofoundry.toml [upload].layout must be "grouped" or "flat" (got "${layout}"); or set [upload].key for a custom path`
        )
    return LAYOUT_KEY[layout]
}

export const deriveUpload = (merged: Toml): DerivedUpload => {
    const upload = getConfigPath(merged, 'upload')
    if (!isObject(upload)) return {}
    const key = resolveKeyTemplate(upload)
    const resolve = (value: unknown): string | undefined => {
        if (value === undefined) return undefined
        return interpolateConfigValue(String(value)).value
    }
    const endpoint = resolve(upload.endpoint)
    const bucket = resolve(upload.bucket)
    // A template publishes several images with different extensions (a system
    // .qcow2 and, on OVMF recipes, an .efivars.raw), so the object name cannot
    // carry a fixed one. `{{ext}}` is substituted per artifact, which keeps the
    // hash-named layout intact while letting one command serve every image.
    const command = (extension: string): string =>
        `aws --endpoint-url $R2_ENDPOINT s3 cp {{file}} s3://$R2_BUCKET/${key}${extension}`
    const publicUrl = upload.public_url
        ? `${String(upload.public_url).replace(/\/+$/, '')}/${key}{{ext}}`
        : undefined
    const uploadCmd =
        resolve(upload.command) ??
        (endpoint && bucket ? command('{{ext}}') : undefined)
    return {
        uploadCmd,
        sidecarCmd:
            resolve(upload.sidecar_command) ??
            (endpoint && bucket ? command('.json') : undefined),
        publicUrl: uploadCmd ? resolve(publicUrl) : undefined,
    }
}
