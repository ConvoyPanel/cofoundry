import { z } from 'zod'
import { addSensitiveValues } from '@/util.ts'
import { DEFAULT_PREFIX } from '@/config-file/upload.ts'

// CI passes unset secrets/vars as empty strings, which would defeat
// `.default(...)` (Zod only applies defaults when the value is undefined).
// Strip empty-string values before parsing so defaults engage.
const stripEmpty = (input: NodeJS.ProcessEnv): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input)) {
        if (v !== '') out[k] = v
    }
    return out
}

// Default versions for the pinned Windows build assets fetched by
// src/build/prefetch.ts. The version is part of the cache filename on the
// node, so bumping a pin refetches the new release instead of trusting a
// stale cache forever. The matching default SHA256 pins live next to the
// fetch logic in src/build/prefetch.ts.
export const CLOUDBASE_INIT_DEFAULT_VERSION = '1.1.8'
export const VIRTIO_WIN_DEFAULT_VERSION = '0.1.285-1'

const EnvSchema = z.object({
    PVE_HOST: z.string().min(1),
    PVE_PORT: z.coerce.number().int().default(8006),
    PVE_NODE: z.string().min(1),
    PVE_TOKEN_ID: z.string().min(1),
    PVE_TOKEN_SECRET: z.string().min(1),

    SSH_TARGET: z.string().min(1),
    PVE_DUMP_DIR: z.string().default('/var/lib/vz/dump'),

    // Identifies the CI run owning this invocation's leases, so a cleanup job
    // can reap them by name after the build process is killed without warning.
    // Unset outside CI, where lease ids fall back to a random UUID.
    CF_RUN_ID: z.string().optional(),

    CF_OUT_DIR: z.string().default('./dist'),
    CF_SKIP_ARTIFACT_SYNC: z
        .preprocess(v => v === '1' || v === 'true' || v === true, z.boolean())
        .default(false),
    // Bridge for recipes that do not need an allocated build-network slot.
    CF_BRIDGE: z.string().default('vmbr0'),
    // NAT bridge for ISO-installer + Windows builds. Per-build dnsmasq
    // reservations are written under /etc/dnsmasq.d/cofoundry-hosts.d/.
    CF_BUILD_BRIDGE: z.string().default('vmbr1'),
    CF_STORAGE: z.string().default('local'),
    CF_ISO_STORAGE: z.string().default('local'),

    // DNS resolver for ISO-installer build VMs. The IP and gateway are now
    // allocated per-build from the configured NAT bridge (see src/build/netslot.ts),
    // so they no longer need static config.
    CF_BUILD_DNS: z.string().default('1.1.1.1'),

    // Pinned Windows build assets (cloudbase-init MSI + virtio-win ISO). The
    // version selects both the versioned download URL and the node-side cache
    // filename. When overriding a version, also set the matching CF_*_SHA256:
    // the built-in checksum pins only cover the default versions, so an
    // overridden version without one downgrades validation to a non-empty
    // check.
    CF_CLOUDBASE_INIT_VERSION: z
        .string()
        .default(CLOUDBASE_INIT_DEFAULT_VERSION),
    CF_CLOUDBASE_INIT_SHA256: z.string().optional(),
    CF_VIRTIO_WIN_VERSION: z.string().default(VIRTIO_WIN_DEFAULT_VERSION),
    CF_VIRTIO_WIN_SHA256: z.string().optional(),

    // Parallel SFTP connections for syncing artifacts back down (default 8).
    CF_DOWNLOAD_CONCURRENCY: z.coerce.number().int().min(1).default(8),

    // Packer build admission limits. Parallel builds are opt-in and require
    // both resource budgets so the node cannot be oversubscribed accidentally.
    CF_BUILD_CONCURRENCY: z.coerce.number().int().min(1).default(1),
    CF_BUILD_MEMORY_BUDGET_MB: z.coerce.number().int().min(1).optional(),
    CF_BUILD_CPU_BUDGET: z.coerce.number().int().min(1).optional(),

    // On build failure, record framebuffer screenshots + in-guest logs and pull
    // them to ./diagnostics. Screenshots are captured on a RAM-backed tmpfs ring
    // buffer during the build (Packer deletes the VM on failure). Default on;
    // set CF_DIAGNOSTICS=0 to disable entirely.
    CF_DIAGNOSTICS: z
        .preprocess(
            v => !(v === '0' || v === 'false' || v === false),
            z.boolean()
        )
        .default(true),

    // If set, skip destroying the build VM on abort (useful for debugging failed builds).
    CF_KEEP_VM: z
        .preprocess(v => v === '1' || v === 'true' || v === true, z.boolean())
        .default(false),
    CF_BUILD_ATTEMPTS: z.coerce.number().int().min(1).optional(),

    // Optional CDN integration. Generated from [upload] in cofoundry.toml.
    CF_UPLOAD_CMD: z.string().optional(),
    CF_SIDECAR_UPLOAD_CMD: z.string().optional(),
    CF_PUBLIC_URL_TMPL: z.string().optional(),

    R2_ENDPOINT: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    R2_PREFIX: z.string().default(DEFAULT_PREFIX),
})

export type Env = z.infer<typeof EnvSchema>

/** Parse a specific environment map. Kept separate from loadEnv so `cf doctor`
 *  and tests can validate an arbitrary env without touching process.env. */
export const parseEnv = (input: NodeJS.ProcessEnv): Env => {
    const env = EnvSchema.parse(stripEmpty(input))
    addSensitiveValues(
        env.PVE_TOKEN_ID,
        env.PVE_TOKEN_SECRET,
        input.AWS_ACCESS_KEY_ID,
        input.AWS_SECRET_ACCESS_KEY,
        input.AWS_SESSION_TOKEN
    )
    return env
}

export const loadEnv = (): Env => parseEnv(process.env)

/**
 * Names of env keys that fail schema validation — required vars that are unset
 * (or empty: stripEmpty removes those first) plus vars with invalid values.
 * Used by `cf doctor` to report exactly which variables need fixing instead of
 * surfacing a raw Zod error.
 */
export const missingRequiredEnv = (input: NodeJS.ProcessEnv): string[] => {
    const parsed = EnvSchema.safeParse(stripEmpty(input))
    if (parsed.success) return []
    return [
        ...new Set(
            parsed.error.issues.map(issue => String(issue.path[0] ?? ''))
        ),
    ]
        .filter(Boolean)
        .sort()
}

// Relaxed loader for `cf bootstrap` — only SSH_TARGET is needed (and even that
// can be prompted for). Used before PVE_TOKEN_* exist, since bootstrap is what
// produces them.
const PartialEnvSchema = EnvSchema.partial()
export type PartialEnv = z.infer<typeof PartialEnvSchema>

export const loadEnvPartial = (): PartialEnv => {
    const env = PartialEnvSchema.parse(stripEmpty(process.env))
    addSensitiveValues(
        env.PVE_TOKEN_ID,
        env.PVE_TOKEN_SECRET,
        process.env.AWS_ACCESS_KEY_ID,
        process.env.AWS_SECRET_ACCESS_KEY,
        process.env.AWS_SESSION_TOKEN
    )
    return env
}
