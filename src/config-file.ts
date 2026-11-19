import {
    CONFIG_DEFAULTS,
    FIELD_MAP,
    type ResolvedValue,
} from '@/config-file/model.ts'
import {
    getConfigPath,
    interpolateConfigValue,
    loadMergedConfig,
} from '@/config-file/toml.ts'
import { deriveUpload } from '@/config-file/upload.ts'

export { CONFIG_FILENAME, CONFIG_LOCAL_FILENAME } from '@/config-file/model.ts'
export type { ConfigSource, ResolvedValue } from '@/config-file/model.ts'
export { uploadPathTemplate } from '@/config-file/upload.ts'
export type { UploadLayout } from '@/config-file/upload.ts'

/** Resolve TOML, local overlay, interpolation, environment, and defaults. */
export const resolveConfig = (cwd: string = process.cwd()): ResolvedValue[] => {
    const loaded = loadMergedConfig(cwd)
    if (!loaded) return []
    const { merged, origin } = loaded
    const output: ResolvedValue[] = []

    for (const [path, key] of FIELD_MAP) {
        const environmentValue = process.env[key]
        if (environmentValue) {
            output.push({ key, value: environmentValue, source: 'env' })
            continue
        }
        const rawValue = getConfigPath(merged, path)
        if (rawValue === undefined) {
            const value = CONFIG_DEFAULTS[key]
            output.push({
                key,
                value,
                source: value === undefined ? 'unset' : 'default',
            })
            continue
        }
        const raw = String(rawValue)
        const { value, interpolated } = interpolateConfigValue(raw)
        output.push({
            key,
            value,
            source:
                value === undefined ? 'unset' : (origin.get(path) ?? 'toml'),
            detail: interpolated ? raw : undefined,
        })
    }

    // R2_PREFIX set in the environment already wins over [upload].prefix for
    // `cf publish --r2` and `cf prune --r2` (the FIELD_MAP loop above). The
    // derived upload key has to use the same prefix, or uploads land where
    // publish and prune never look.
    const upload = merged.upload
    const environmentPrefix = process.env.R2_PREFIX
    const derived = deriveUpload(
        environmentPrefix && upload && typeof upload === 'object'
            ? { ...merged, upload: { ...upload, prefix: environmentPrefix } }
            : merged
    )
    const addDerived = (key: string, value?: string): void => {
        const environmentValue = process.env[key]
        if (environmentValue)
            output.push({ key, value: environmentValue, source: 'env' })
        else if (value !== undefined)
            output.push({ key, value, source: 'derived' })
    }
    addDerived('CF_UPLOAD_CMD', derived.uploadCmd)
    addDerived('CF_SIDECAR_UPLOAD_CMD', derived.sidecarCmd)
    addDerived('CF_PUBLIC_URL_TMPL', derived.publicUrl)
    return output
}

/**
 * Install the resolved configuration into the process environment once, at the
 * CLI boundary. This is explicit because child processes intentionally inherit
 * these values.
 */
export const applyConfigToEnv = (
    cwd: string = process.cwd()
): ResolvedValue[] => {
    const resolved = resolveConfig(cwd)
    for (const entry of resolved) {
        if (entry.value === undefined || entry.source === 'env') continue
        if (!process.env[entry.key]) process.env[entry.key] = entry.value
    }
    return resolved
}
