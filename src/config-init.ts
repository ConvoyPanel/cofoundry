import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '@/log.ts'
import { CONFIG_FILENAME, CONFIG_LOCAL_FILENAME } from '@/config-file.ts'
import { DEFAULT_PREFIX } from '@/config-file/upload.ts'
import pc from 'picocolors'

// Sensitive coordinates are never inlined by `cf init --from-env` — they stay as
// ${VAR} so a committed cofoundry.toml doesn't leak the node address or R2
// account id into a public repo. Everything else is safe to inline.
const SENSITIVE = new Set(['PVE_HOST', 'SSH_TARGET', 'R2_ENDPOINT'])

const val = (key: string, fromEnv: boolean, fallback: string): string => {
    if (SENSITIVE.has(key)) return `\${${key}}`
    if (fromEnv && process.env[key]) return process.env[key] as string
    return fallback
}

// Derive the public URL *base* from a legacy CF_PUBLIC_URL_TMPL by cutting at
// the first placeholder segment: ".../host.com/{{name}}/..." → ".../host.com".
const publicBase = (fromEnv: boolean): string => {
    const tmpl = fromEnv ? process.env.CF_PUBLIC_URL_TMPL : undefined
    if (!tmpl) return 'https://templates.example.com'
    return tmpl.split(/\/?\{\{/)[0]!.replace(/\/+$/, '')
}

const renderTemplate = (fromEnv: boolean): string => {
    const q = (s: string) => `"${s}"`
    const attempts =
        fromEnv && process.env.CF_BUILD_ATTEMPTS
            ? `attempts = ${process.env.CF_BUILD_ATTEMPTS}`
            : '# attempts = 3   # optional global override; defaults to 3 for Windows, 1 otherwise'
    const memoryBudget =
        fromEnv && process.env.CF_BUILD_MEMORY_BUDGET_MB
            ? `memory_budget_mb = ${process.env.CF_BUILD_MEMORY_BUDGET_MB}`
            : '# memory_budget_mb = 16384  # required when concurrency > 1'
    const cpuBudget =
        fromEnv && process.env.CF_BUILD_CPU_BUDGET
            ? `cpu_budget = ${process.env.CF_BUILD_CPU_BUDGET}`
            : '# cpu_budget = 8             # required when concurrency > 1'
    return `# cofoundry.toml — non-secret deployment config for \`cf\`.
# Committed and reviewable. Inspect the resolved result with \`cf config\`.
#
# Secrets (PVE_TOKEN_SECRET, AWS_*) come from the environment, never here.
# Sensitive coordinates use \${VAR} so they stay out of a public repo; a
# gitignored ${CONFIG_LOCAL_FILENAME} can override any value per machine.
# Resolution order: flag > env > \${VAR} > ${CONFIG_LOCAL_FILENAME} > this file > default.

[node]
host     = ${q(val('PVE_HOST', fromEnv, '${PVE_HOST}'))}      # sensitive → from env
ssh      = ${q(val('SSH_TARGET', fromEnv, '${SSH_TARGET}'))}    # sensitive → from env
node     = ${q(val('PVE_NODE', fromEnv, 'pve'))}
token_id = ${q(val('PVE_TOKEN_ID', fromEnv, 'root@pam!cofoundry'))}
port     = ${val('PVE_PORT', fromEnv, '8006')}
dump_dir = ${q(val('PVE_DUMP_DIR', fromEnv, '/var/lib/vz/dump'))}

[storage]
disks = ${q(val('CF_STORAGE', fromEnv, 'local'))}
isos  = ${q(val('CF_ISO_STORAGE', fromEnv, 'local'))}

[network]
bridge       = ${q(val('CF_BRIDGE', fromEnv, 'vmbr0'))}   # direct-network builds
build_bridge = ${q(val('CF_BUILD_BRIDGE', fromEnv, 'vmbr1'))}   # ISO-installer + Windows NAT bridge
build_dns    = ${q(val('CF_BUILD_DNS', fromEnv, '1.1.1.1'))}

[upload]
# Object key is generated from \`layout\` (grouped|flat). For a custom path set
#   key = "{{recipe}}/{{recipe}}-{{arch}}-{{sha256}}"
# Placeholders: {{recipe}} {{arch}} {{group}} {{sha256}}.
endpoint   = ${q(val('R2_ENDPOINT', fromEnv, '${R2_ENDPOINT}'))}   # sensitive (account id) → from env
bucket     = ${q(val('R2_BUCKET', fromEnv, 'cofoundry-templates'))}
layout     = "grouped"   # <prefix>/{{group}}/{{recipe}}-{{arch}}/{{sha256}}
public_url = ${q(publicBase(fromEnv))}
prefix     = ${q(val('R2_PREFIX', fromEnv, DEFAULT_PREFIX))}   # scanned by \`cf publish --r2\`, and where keys are written

[build]
${attempts}
concurrency          = ${val('CF_BUILD_CONCURRENCY', fromEnv, '1')}
${memoryBudget}
${cpuBudget}
download_concurrency = ${val('CF_DOWNLOAD_CONCURRENCY', fromEnv, '8')}

[local]
out_dir = ${q(val('CF_OUT_DIR', fromEnv, './dist'))}
`
}

export interface InitOptions {
    fromEnv?: boolean
    force?: boolean
}

export const runInit = (
    opts: InitOptions,
    cwd: string = process.cwd()
): void => {
    const path = join(cwd, CONFIG_FILENAME)
    if (existsSync(path) && !opts.force) {
        throw new Error(
            `${CONFIG_FILENAME} already exists. Pass ${pc.cyan('--force')} to overwrite.`
        )
    }
    writeFileSync(path, renderTemplate(Boolean(opts.fromEnv)))
    log.ok(`Wrote ${pc.cyan(CONFIG_FILENAME)}.`)
    if (opts.fromEnv) {
        log.note(
            'Filled from current env. Review it, then move any private values you '
        )
        log.note(
            `don't want committed into ${pc.cyan(CONFIG_LOCAL_FILENAME)} (gitignored).`
        )
    }
    log.note(`Verify with ${pc.cyan('cf config')} and ${pc.cyan('cf doctor')}.`)
    log.blank()
}
