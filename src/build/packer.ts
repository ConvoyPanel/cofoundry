import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { shellQuote } from '@/util.ts'
import { virtioWinIsoFilename } from '@/build/prefetch.ts'

export const PACKER_TMP_ROOT = '/var/tmp/cofoundry-packer'

// Linux sockaddr_un.sun_path is 108 bytes including its terminating NUL.
// Packer's SDK creates `$TMPDIR/packer-plugin<decimal uint32>`, so reserve the
// longest possible Go os.CreateTemp suffix when validating the directory.
const PACKER_UNIX_SOCKET_MAX_PATH_BYTES = 107
const PACKER_PLUGIN_SOCKET_MAX_NAME = 'packer-plugin4294967295'

export const packerTmpDir = (runId: string): string =>
    `${PACKER_TMP_ROOT}/${runId}`

export const assertPackerTmpDirSocketSafe = (dir: string): void => {
    const socketPath = `${dir}/${PACKER_PLUGIN_SOCKET_MAX_NAME}`
    const bytes = Buffer.byteLength(socketPath)
    if (bytes > PACKER_UNIX_SOCKET_MAX_PATH_BYTES) {
        throw new Error(
            `Packer TMPDIR is too long for its Unix plugin socket (${bytes}/${PACKER_UNIX_SOCKET_MAX_PATH_BYTES} bytes): ${dir}`
        )
    }
}

/**
 * Wrap a foreground command so its output is written to a durable logfile on
 * the node and streamed live with `tail -f`, instead of piped straight out of
 * the process over SSH.
 *
 * The logfile — not the live SSH pipe — is the source of truth. A long quiet
 * stretch (e.g. Windows setup taking 20+ minutes to reach WinRM) or a transient
 * pipe stall can no longer drop lines: whatever `tail` misses stays in the file
 * on the node. The shell also merges the command's stdout and stderr into the
 * file in write order, so the streamed output is correctly interleaved at the
 * source rather than reassembled from two races on the reader side.
 *
 * `tail --pid` exits once the command does, and the trailing `wait` re-raises
 * the command's own exit status so Packer failures still propagate to retries.
 */
export const streamViaConsoleLog = (
    command: string,
    logPath: string
): string => {
    const log = shellQuote(logPath)
    return [
        `${command} > ${log} 2>&1 &`,
        `__cf_pid=$!`,
        `tail -n +1 --pid="$__cf_pid" -f ${log} 2>/dev/null`,
        `wait "$__cf_pid"`,
    ].join('\n')
}

export type BuildNet = {
    ip: string
    gw: string
    mac: string
}

export const buildPackerVars = (
    env: Env,
    recipe: RecipeInfo,
    buildBridge: string,
    net: BuildNet | null,
    buildVmid?: number
): string[] => {
    const apiUrl = `https://${env.PVE_HOST}:${env.PVE_PORT}/api2/json`
    const vars = [
        '-var',
        `proxmox_api_url=${apiUrl}`,
        '-var',
        `proxmox_node=${env.PVE_NODE}`,
        '-var',
        `proxmox_storage_pool=${env.CF_STORAGE}`,
        '-var',
        `proxmox_iso_storage_pool=${env.CF_ISO_STORAGE}`,
        '-var',
        `proxmox_bridge=${buildBridge}`,
    ]
    // Only Windows recipes declare the virtio_win_iso variable; passing it to
    // any other recipe would fail `packer build` with an undefined -var error.
    if (recipe.name.startsWith('windows-')) {
        vars.push('-var', `virtio_win_iso=${virtioWinIsoFilename(env)}`)
    }
    if (net) {
        vars.push(
            '-var',
            `build_ip=${net.ip}`,
            '-var',
            `build_gw=${net.gw}`,
            '-var',
            `build_mac=${net.mac}`,
            '-var',
            `build_dns=${env.CF_BUILD_DNS}`
        )
    }
    if (buildVmid !== undefined) {
        vars.push('-var', `build_vmid=${buildVmid}`)
    }
    return vars
}

export const buildRemoteEnv = (
    env: Env,
    remoteOutDir: string,
    remotePackerTmpDir: string,
    arch: string,
    group: string,
    finalDiskSize?: string,
    baseVmid?: number,
    skipUpload: boolean = false,
    minimum?: { cores?: number; memoryMb?: number }
): string => {
    // Packer runs on the PVE node, so SSH_TARGET=local tells the post-processor
    // to export directly instead of SSHing back to itself.
    const pairs: Record<string, string> = {
        SSH_TARGET: 'local',
        PVE_DUMP_DIR: env.PVE_DUMP_DIR,
        CF_OUT_DIR: remoteOutDir,
        CF_ARCH: arch,
        CF_GROUP: group,
        TMPDIR: remotePackerTmpDir,
        PACKER_CACHE_DIR: '/var/lib/vz/template/iso',
        // Packer automatically maps Packer variable names from PKR_VAR_*.
        // These stay in the remote process environment instead of appearing
        // in the Packer argv/process listing.
        PKR_VAR_proxmox_username: env.PVE_TOKEN_ID,
        PKR_VAR_proxmox_token: env.PVE_TOKEN_SECRET,
    }
    // The post-processor's CF_BUILT_VMID is the slot-derived id (base*100+slot)
    // for parallel builds; export the recipe BASE so downstream consumers
    // (e.g. cf-cluster-templates.sh) get it directly instead of reverse-
    // engineering it. Inherited by the shell-local post-processor and any
    // CF_UPLOAD_CMD it spawns.
    if (baseVmid !== undefined) pairs.CF_RECIPE_BASE_VMID = String(baseVmid)
    // Opt-in: when set, the post-processor shrinks the OS disk to this size
    // before the export (see recipes/_shared/post/shrink-disk.sh).
    if (finalDiskSize) pairs.CF_FINAL_DISK_SIZE = finalDiskSize
    // Runtime floor for the sidecar's `minimum` block. Hand-authored in the
    // recipe header rather than captured from the build VM, whose cores/memory
    // are servicing headroom (see RecipeInfo.minCores in src/config.ts).
    if (minimum?.cores !== undefined) pairs.CF_MIN_CORES = String(minimum.cores)
    if (minimum?.memoryMb !== undefined)
        pairs.CF_MIN_MEMORY = String(minimum.memoryMb)
    // Deliberately outside the `skipUpload` guard below: this is the address
    // the artifact WILL be served from, not an instruction to upload it. CI
    // builds with --skip-upload and uploads later (`cf upload --remote`) once
    // verify passes, and the sidecar written here is the one that ships — so
    // gating the template on skipUpload published a registry whose every disk
    // carried `"url": ""` and which coport could not download from at all.
    if (env.CF_PUBLIC_URL_TMPL)
        pairs.CF_PUBLIC_URL_TMPL = env.CF_PUBLIC_URL_TMPL
    if (!skipUpload) {
        if (env.CF_UPLOAD_CMD) pairs.CF_UPLOAD_CMD = env.CF_UPLOAD_CMD
        if (env.CF_SIDECAR_UPLOAD_CMD)
            pairs.CF_SIDECAR_UPLOAD_CMD = env.CF_SIDECAR_UPLOAD_CMD
        if (env.R2_ENDPOINT) pairs.R2_ENDPOINT = env.R2_ENDPOINT
        if (env.R2_BUCKET) pairs.R2_BUCKET = env.R2_BUCKET
        if (env.R2_PREFIX) pairs.R2_PREFIX = env.R2_PREFIX
        // Forward S3-compatible creds + endpoint/bucket so a CF_UPLOAD_CMD
        // using `aws s3 cp ... $R2_ENDPOINT ... s3://$R2_BUCKET/...` can
        // authenticate and resolve those shell vars on the node.
        for (const k of [
            'AWS_ACCESS_KEY_ID',
            'AWS_SECRET_ACCESS_KEY',
            'AWS_SESSION_TOKEN',
            'AWS_DEFAULT_REGION',
        ]) {
            const v = process.env[k]
            if (v) pairs[k] = v
        }
        // R2 rejects the default CRC32 integrity checksum AWS CLI v2.23+ adds
        // to single-part PutObject ("SignatureDoesNotMatch" on small objects
        // like sidecar JSONs). Multipart uploads (large disk images) take a
        // different code path and aren't affected. Caller can override these.
        pairs.AWS_REQUEST_CHECKSUM_CALCULATION =
            process.env.AWS_REQUEST_CHECKSUM_CALCULATION ?? 'when_required'
        pairs.AWS_RESPONSE_CHECKSUM_VALIDATION =
            process.env.AWS_RESPONSE_CHECKSUM_VALIDATION ?? 'when_required'
    }
    return Object.entries(pairs)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(' ')
}

export const selectBridge = (
    env: Env,
    recipeName: string,
    hasPreseed: boolean,
    hasAutoinstall: boolean,
    hasKickstart: boolean
): string => {
    // ISO installers + Windows can't use guest-agent IP discovery, so they run
    // on the NAT bridge with a per-build dnsmasq reservation (see netslot.ts).
    if (
        recipeName.startsWith('windows-') ||
        hasPreseed ||
        hasAutoinstall ||
        hasKickstart
    ) {
        return env.CF_BUILD_BRIDGE
    }
    return env.CF_BRIDGE
}
