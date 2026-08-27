// `cf doctor` — preflight diagnostics for the configured build node.
//
// Catches the environment problems that otherwise surface hours into a build:
// missing env vars, unreachable node, absent node tooling, misconfigured
// storage/bridges, a rejected API token, and full disks.
//
// The check logic here is pure data-in/data-out: every remote interaction is
// injected through DoctorDeps and every parser takes captured command output as
// a plain string, so the whole flow is unit-testable without a Proxmox node.
// Presentation (glyphs, colors, --json) lives in src/commands/doctor.ts.

import { bridgeGateway } from '@/bootstrap/network.ts'
import { buildNetworkFromGateway } from '@/build/buildnet.ts'
import { remotePaths } from '@/build/paths.ts'
import { missingRequiredEnv, parseEnv, type Env } from '@/env.ts'
import { shellQuote } from '@/util.ts'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

export type DoctorCheck = {
    id: string
    name: string
    status: CheckStatus
    detail: string
    hint?: string
}

export type DoctorReport = {
    checks: DoctorCheck[]
    /** True when no check failed. Warnings and skips do not affect it. */
    ok: boolean
}

export type DoctorDeps = {
    /** Locate a binary on the local PATH (Bun.which in production). */
    whichLocal: (bin: string) => string | null
    /** Cheap `ssh <target> true` with a short connect timeout; throws on failure. */
    probeSsh: (target: string) => Promise<void>
    /** Run a Bash script on the node via stdin and capture its stdout. */
    captureScript: (target: string, script: string) => Promise<string>
    /** `aws s3api head-bucket` against the R2 endpoint; throws on failure. */
    probeR2: (endpoint: string, bucket: string) => Promise<void>
}

// ── node tooling ──────────────────────────────────────────────────────────────

/**
 * Commands the build path actually invokes on the node. A missing entry fails
 * preflight; each `why` names the code that depends on the tool so the failure
 * hint explains itself.
 */
export const NODE_TOOLS: ReadonlyArray<{ bin: string; why: string }> = [
    // Packer runs ON the node (src/build/executor.ts: `packer init` + `packer
    // build` over SSH); installed by `cf bootstrap`.
    { bin: 'packer', why: 'runs the template build on the node' },
    // VM lifecycle: stop/unlock/destroy build VMs, watchdog status polling
    // (src/build/vm.ts, lease.ts, watchdog.ts, verify.ts, prune/node.ts).
    { bin: 'qm', why: 'build-VM lifecycle (create/stop/destroy, watchdog)' },
    // Storage plumbing: list/free orphaned build disks, resolve volume paths
    // (src/build/vm.ts, lease.ts, prune/node.ts, verify.ts).
    { bin: 'pvesm', why: 'lists and frees build-VM disks on the storage pool' },
    // Resolves the built VM's disks to node-side paths for the export
    // (recipes/_shared/post/export-disks.sh).
    { bin: 'cp', why: 'copies the EFI varstore out for OVMF recipes' },
    // Resumable ISO/asset prefetch with progress (src/build/prefetch.ts,
    // src/build/remote.ts remoteWgetCapture).
    { bin: 'wget', why: 'resumable ISO and asset prefetch' },
    // Checksum-file fetch and the GitHub API call that locates the latest
    // Cloudbase-Init MSI (src/build/prefetch.ts).
    { bin: 'curl', why: 'checksum fetch + GitHub API lookup during prefetch' },
    // Serializes netslot allocation, run leases, prefetch and `packer init`
    // (src/build/netslot.ts, lease.ts, prefetch.ts, executor.ts).
    { bin: 'flock', why: 'serializes slots, leases, prefetch and packer init' },
    // ISO checksum validation and artifact sidecar hashes
    // (src/build/prefetch.ts, recipes/_shared/post/export-and-cleanup.sh).
    { bin: 'sha256sum', why: 'ISO and artifact checksum validation' },
    // Extracts the expected SHA-256 from distro checksum files and parses the
    // GitHub release JSON during prefetch (src/build/prefetch.ts).
    { bin: 'python3', why: 'checksum extraction in the prefetch pipeline' },
    // Host-side disk shrink for Windows recipes with CF_FINAL_DISK_SIZE
    // (shrink-disk.sh) and the compressed-qcow2 export itself
    // (export-disks.sh). Compression lives inside the image because Proxmox
    // refuses to decompress on the import path — see docs/disk-images.md.
    { bin: 'qemu-img', why: 'compressed-qcow2 export and Windows disk shrink' },
    // Ephemeral per-build SSH keypair generation on the node
    // (scripts/inject-placeholders.sh, invoked remotely by executor.ts).
    { bin: 'ssh-keygen', why: 'generates the ephemeral build SSH keypair' },
    // Random Windows Administrator password generation on the node
    // (scripts/inject-placeholders.sh).
    { bin: 'openssl', why: 'generates the ephemeral Windows build password' },
]

/**
 * Windows answer-file ISOs (`cd_files` in recipes/windows-*.pkr.hcl) need an
 * ISO mastering tool on the node; Packer's SDK probes for these in order.
 * Linux recipes build fine without one, so absence is a warning, not a failure.
 */
export const ISO_MASTERING_TOOLS: ReadonlyArray<string> = ['xorriso', 'mkisofs']

// ── free-space thresholds ─────────────────────────────────────────────────────

/** Below this, a pool/directory gets a low-space warning: a single Windows ISO
 *  plus virtio media runs ~10 GiB, and an exported disk image the same. */
export const LOW_FREE_GIB = 20
const LOW_FREE_KIB = LOW_FREE_GIB * 1024 * 1024

const gib = (kib: number): string => `${(kib / 1024 / 1024).toFixed(1)} GiB`

// ── bundled node sweep ────────────────────────────────────────────────────────

const MARKER = '### cf-doctor:'

/** Where netslot allocation writes per-build DHCP reservations (SNIPPET_DIR in
 *  src/build/netslot.ts); created and wired to dnsmasq by `cf bootstrap`. */
const DNSMASQ_HOSTS_DIR = '/etc/dnsmasq.d/cofoundry-hosts.d'

export type SweepTargets = {
    bridge: string
    buildBridge: string
    isoCacheDir: string
    dumpDir: string
}

/**
 * One SSH round trip for every non-API remote check: tool sweep, `pvesm
 * status`, bridge presence/address, and free space. Sections are delimited
 * with MARKER lines so each parser reads exactly its own command output.
 * Every probe is `|| true`-guarded — an absent bridge or directory must yield
 * an empty section, not abort the sweep.
 */
export const doctorSweepScript = (targets: SweepTargets): string => {
    const tools = [...NODE_TOOLS.map(tool => tool.bin), ...ISO_MASTERING_TOOLS]
    return [
        `echo ${shellQuote(`${MARKER}tools`)}`,
        `for t in ${tools.map(shellQuote).join(' ')}; do`,
        `    if command -v "$t" >/dev/null 2>&1; then echo "$t=ok"; else echo "$t=missing"; fi`,
        `done`,
        `echo ${shellQuote(`${MARKER}pvesm`)}`,
        `pvesm status 2>/dev/null || true`,
        `echo ${shellQuote(`${MARKER}link:bridge`)}`,
        `ip -o link show dev ${shellQuote(targets.bridge)} 2>/dev/null || true`,
        `echo ${shellQuote(`${MARKER}link:build-bridge`)}`,
        `ip -o link show dev ${shellQuote(targets.buildBridge)} 2>/dev/null || true`,
        // ifquery + `ip -4 -o addr` feed bridgeGateway() — the same detection
        // bootstrap and the netslot allocator use for the build subnet.
        `echo ${shellQuote(`${MARKER}ifquery:build-bridge`)}`,
        `ifquery ${shellQuote(targets.buildBridge)} 2>/dev/null || true`,
        `echo ${shellQuote(`${MARKER}addr:build-bridge`)}`,
        `ip -4 -o addr show dev ${shellQuote(targets.buildBridge)} 2>/dev/null || true`,
        // Netslot allocation registers per-build DHCP reservations with the
        // system dnsmasq (src/build/netslot.ts) — the service must be active
        // and the hostsfile directory must exist for slot writes to land.
        `echo ${shellQuote(`${MARKER}dnsmasq`)}`,
        `systemctl is-active dnsmasq 2>/dev/null || true`,
        `echo ${shellQuote(`${MARKER}dnsmasq-hostsdir`)}`,
        `test -d ${shellQuote(DNSMASQ_HOSTS_DIR)} && echo present || true`,
        `echo ${shellQuote(`${MARKER}df:iso`)}`,
        `df -Pk ${shellQuote(targets.isoCacheDir)} 2>/dev/null | tail -n +2 || true`,
        `echo ${shellQuote(`${MARKER}df:dump`)}`,
        `df -Pk ${shellQuote(targets.dumpDir)} 2>/dev/null | tail -n +2 || true`,
    ].join('\n')
}

export const splitSections = (output: string): Map<string, string> => {
    const sections = new Map<string, string>()
    let key: string | null = null
    let lines: string[] = []
    const flush = (): void => {
        if (key !== null) sections.set(key, lines.join('\n').trim())
    }
    for (const line of output.split('\n')) {
        if (line.startsWith(MARKER)) {
            flush()
            key = line.slice(MARKER.length).trim()
            lines = []
        } else if (key !== null) {
            lines.push(line)
        }
    }
    flush()
    return sections
}

// ── individual checks ─────────────────────────────────────────────────────────

export const parseToolSweep = (section: string): Set<string> => {
    const missing = new Set<string>()
    for (const line of section.split('\n')) {
        const match = line.trim().match(/^([\w.+-]+)=missing$/)
        if (match?.[1]) missing.add(match[1])
    }
    return missing
}

export const toolsCheck = (missing: Set<string>): DoctorCheck => {
    const base = { id: 'node-tools', name: 'Node tools' }
    const absent = NODE_TOOLS.filter(tool => missing.has(tool.bin))
    if (absent.length > 0) {
        return {
            ...base,
            status: 'fail',
            detail: `missing on the node: ${absent.map(tool => tool.bin).join(', ')}`,
            hint:
                `${absent.map(tool => `${tool.bin} — ${tool.why}`).join('; ')}. ` +
                'Install packer via `cf bootstrap`; the rest via apt-get on the node.',
        }
    }
    if (ISO_MASTERING_TOOLS.every(bin => missing.has(bin))) {
        return {
            ...base,
            status: 'warn',
            detail: `no ISO mastering tool (${ISO_MASTERING_TOOLS.join(' or ')}) — windows-* recipes cannot build their answer-file ISO`,
            hint: 'apt-get install xorriso on the node before building Windows recipes',
        }
    }
    return {
        ...base,
        status: 'ok',
        detail: `all ${NODE_TOOLS.length} required tools present`,
    }
}

export type StoragePool = {
    name: string
    type: string
    status: string
    availKib: number
}

/** Parse `pvesm status` (Name Type Status Total Used Available %; KiB units). */
export const parsePvesmStatus = (section: string): StoragePool[] =>
    section
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '' && !/^Name\s/.test(line))
        .map(line => line.split(/\s+/))
        .filter(fields => fields.length >= 6)
        .map(fields => ({
            name: fields[0]!,
            type: fields[1]!,
            status: fields[2]!,
            availKib: Number.parseInt(fields[5]!, 10) || 0,
        }))

/** Storage types whose volumes are plain files on the node. Anything else
 *  (zfspool, lvmthin, rbd, …) cannot be shrunk host-side by
 *  recipes/_shared/post/shrink-disk.sh, which requires a regular qcow2 file. */
export const FILE_BACKED_STORAGE_TYPES: ReadonlySet<string> = new Set([
    'dir',
    'nfs',
    'cifs',
    'glusterfs',
    'btrfs',
])

export const storageCheck = (
    pools: StoragePool[],
    poolName: string,
    role: 'disks' | 'isos'
): DoctorCheck => {
    const base =
        role === 'disks'
            ? { id: 'storage', name: 'Storage (CF_STORAGE)' }
            : { id: 'iso-storage', name: 'ISO storage (CF_ISO_STORAGE)' }
    const configKey = role === 'disks' ? 'CF_STORAGE' : 'CF_ISO_STORAGE'
    const pool = pools.find(candidate => candidate.name === poolName)
    if (!pool) {
        const known = pools.map(candidate => candidate.name).join(', ')
        return {
            ...base,
            status: 'fail',
            detail: `pool "${poolName}" not present in pvesm status`,
            hint: `pools on the node: ${known || '(none reported)'} — fix ${configKey} (storage.${role} in cofoundry.toml)`,
        }
    }
    if (pool.status !== 'active') {
        return {
            ...base,
            status: 'fail',
            detail: `pool "${poolName}" is ${pool.status}, not active`,
            hint: `enable it on the node or point ${configKey} at an active pool`,
        }
    }
    const warnings: string[] = []
    let hint: string | undefined
    if (!FILE_BACKED_STORAGE_TYPES.has(pool.type)) {
        if (role === 'disks') {
            warnings.push(
                `type ${pool.type} is not file-backed — host-side disk shrink for Windows recipes (CF_FINAL_DISK_SIZE) is unsupported, exports stay full-size`
            )
            hint =
                'use a dir/NFS pool for Windows template builds if you need shrunk exports'
        } else {
            warnings.push(
                `type ${pool.type} is not file-backed — ISO content needs a file-based pool`
            )
            hint = `point ${configKey} at a dir/NFS pool that allows ISO content`
        }
    }
    if (pool.availKib < LOW_FREE_KIB) {
        warnings.push(`only ${gib(pool.availKib)} free (< ${LOW_FREE_GIB} GiB)`)
        hint ??= 'reclaim space with `cf prune`'
    }
    if (warnings.length > 0) {
        return { ...base, status: 'warn', detail: warnings.join('; '), hint }
    }
    return {
        ...base,
        status: 'ok',
        detail: `${pool.type}, ${gib(pool.availKib)} free`,
    }
}

/** CF_BRIDGE only needs to exist — direct-network builds attach to it and use
 *  guest-agent IP discovery, so no address requirement applies. */
export const bridgeCheck = (
    linkSection: string,
    bridgeName: string
): DoctorCheck => {
    const base = { id: 'bridge', name: 'Bridge (CF_BRIDGE)' }
    if (linkSection.trim() === '') {
        return {
            ...base,
            status: 'fail',
            detail: `${bridgeName} not found on the node`,
            hint: 'CF_BRIDGE (network.bridge) must name an existing bridge; direct-network builds attach to it',
        }
    }
    return { ...base, status: 'ok', detail: `${bridgeName} present` }
}

/** CF_BUILD_BRIDGE must exist AND carry a /24 gateway address: the netslot
 *  allocator derives per-build IPs from the bridge address at build time. */
export const buildBridgeCheck = (
    linkSection: string,
    ifquerySection: string,
    addrSection: string,
    bridgeName: string
): DoctorCheck => {
    const base = { id: 'build-bridge', name: 'Build bridge (CF_BUILD_BRIDGE)' }
    if (linkSection.trim() === '') {
        return {
            ...base,
            status: 'fail',
            detail: `${bridgeName} not found on the node`,
            hint: 'run `cf bootstrap` to create the NAT bridge used by ISO-installer and Windows builds',
        }
    }
    const gateway = bridgeGateway(ifquerySection, addrSection)
    if (!gateway) {
        return {
            ...base,
            status: 'fail',
            detail: `${bridgeName} has no /24 IPv4 address — build-slot IPs cannot be derived`,
            hint: 'run `cf bootstrap` to (re)configure the build bridge address',
        }
    }
    try {
        const network = buildNetworkFromGateway(gateway)
        return {
            ...base,
            status: 'ok',
            detail: `${bridgeName} gateway ${gateway}, build subnet ${network.cidr}`,
        }
    } catch (err) {
        return {
            ...base,
            status: 'fail',
            detail: err instanceof Error ? err.message : String(err),
            hint: 'run `cf bootstrap` to (re)configure the build bridge address',
        }
    }
}

/** The netslot allocator (src/build/netslot.ts) registers each build VM's IP
 *  as a static DHCP reservation with the system dnsmasq and reloads the
 *  service — every ISO-installer and Windows build depends on it. */
export const dnsmasqCheck = (
    activeSection: string,
    hostsdirSection: string
): DoctorCheck => {
    const base = { id: 'dnsmasq', name: 'dnsmasq (build DHCP)' }
    const state = activeSection.trim()
    if (state !== 'active') {
        return {
            ...base,
            status: 'fail',
            detail:
                state === '' || state === 'unknown'
                    ? 'dnsmasq service not found on the node'
                    : `dnsmasq service is ${state}`,
            hint: 'build VMs get their IPs from per-build dnsmasq reservations — run `cf bootstrap` to install and configure it',
        }
    }
    if (hostsdirSection.trim() !== 'present') {
        return {
            ...base,
            status: 'fail',
            detail: `${DNSMASQ_HOSTS_DIR} missing — per-build DHCP reservations cannot be written`,
            hint: 'run `cf bootstrap` to (re)create the dnsmasq hostsfile directory',
        }
    }
    return {
        ...base,
        status: 'ok',
        detail: 'service active, hostsfile directory present',
    }
}

/** Available KiB from a header-stripped one-path `df -Pk` section. */
export const parseDfAvailKib = (section: string): number | undefined => {
    const fields = section.trim().split('\n')[0]?.trim().split(/\s+/)
    if (!fields || fields.length < 4) return undefined
    const avail = Number.parseInt(fields[3]!, 10)
    return Number.isFinite(avail) ? avail : undefined
}

export const diskSpaceCheck = (
    section: string,
    base: { id: string; name: string },
    dir: string,
    missingHint: string
): DoctorCheck => {
    const availKib = parseDfAvailKib(section)
    if (availKib === undefined) {
        return {
            ...base,
            status: 'fail',
            detail: `cannot stat ${dir} on the node`,
            hint: missingHint,
        }
    }
    if (availKib < LOW_FREE_KIB) {
        return {
            ...base,
            status: 'warn',
            detail: `only ${gib(availKib)} free in ${dir} (< ${LOW_FREE_GIB} GiB)`,
            hint: 'reclaim space with `cf prune`',
        }
    }
    return { ...base, status: 'ok', detail: `${gib(availKib)} free in ${dir}` }
}

// ── Proxmox API check ─────────────────────────────────────────────────────────

/**
 * Probe the API exactly the way Packer does: from the node, against
 * https://PVE_HOST:PVE_PORT/api2/json (see buildPackerVars), with the token
 * header and TLS verification off (PVE ships a self-signed cert by default).
 * The token travels inside this script over SSH stdin (`bash -s`) and reaches
 * curl through a quoted heredoc via `-H @-`, so the secret never appears in a
 * process command line, locally or on the node.
 */
export const apiCheckScript = (
    env: Pick<
        Env,
        'PVE_HOST' | 'PVE_PORT' | 'PVE_TOKEN_ID' | 'PVE_TOKEN_SECRET'
    >
): string => {
    const url = `https://${env.PVE_HOST}:${env.PVE_PORT}/api2/json/version`
    return [
        `curl -ksS -m 10 -w '\\n%{http_code}' -H @- ${shellQuote(url)} <<'CF_DOCTOR_TOKEN'`,
        `Authorization: PVEAPIToken=${env.PVE_TOKEN_ID}=${env.PVE_TOKEN_SECRET}`,
        `CF_DOCTOR_TOKEN`,
    ].join('\n')
}

/** Parse the `<body>\n<http_code>` output of apiCheckScript. */
export const apiCheck = (raw: string): DoctorCheck => {
    const base = { id: 'pve-api', name: 'Proxmox API' }
    const lines = raw.trim().split('\n')
    const code = Number.parseInt(lines.at(-1) ?? '', 10)
    const body = lines.slice(0, -1).join('\n')
    if (!Number.isFinite(code)) {
        return {
            ...base,
            status: 'fail',
            detail: 'unexpected response from the API probe',
            hint: 'check that PVE_HOST and PVE_PORT point at the Proxmox web API',
        }
    }
    if (code === 200) {
        try {
            const parsed = JSON.parse(body) as { data?: { version?: string } }
            return {
                ...base,
                status: 'ok',
                detail: `authenticated — Proxmox VE ${parsed.data?.version ?? '(unknown version)'}`,
            }
        } catch {
            return {
                ...base,
                status: 'fail',
                detail: 'HTTP 200 but the body is not JSON',
                hint: 'PVE_HOST:PVE_PORT does not look like the Proxmox API (is a proxy in the way?)',
            }
        }
    }
    if (code === 401) {
        return {
            ...base,
            status: 'fail',
            detail: 'HTTP 401 — API token rejected',
            hint: 'check PVE_TOKEN_ID (user@realm!name) and PVE_TOKEN_SECRET; recreate the token with `cf bootstrap` if it was deleted or expired',
        }
    }
    if (code === 403) {
        return {
            ...base,
            status: 'fail',
            detail: 'HTTP 403 — token authenticated but lacks privileges',
            hint: 'grant the token the PVEVMAdmin + PVEDatastoreUser roles (or rerun `cf bootstrap`)',
        }
    }
    return {
        ...base,
        status: 'fail',
        detail: `HTTP ${code} from /api2/json/version`,
        hint: 'check that PVE_HOST and PVE_PORT point at the Proxmox web API',
    }
}

// ── R2 check ──────────────────────────────────────────────────────────────────

const firstLine = (err: unknown): string =>
    (err instanceof Error ? err.message : String(err)).split('\n')[0] ??
    'failed'

/**
 * R2 is optional — only `cf upload --r2` / `cf publish --r2` / `cf prune --r2`
 * need it — so an unconfigured pair skips rather than fails. The probe is
 * local (the upload path shells out to the local `aws` CLI), so it runs even
 * when the node checks were skipped.
 */
export const r2Check = async (
    procEnv: NodeJS.ProcessEnv,
    deps: DoctorDeps
): Promise<DoctorCheck> => {
    const base = { id: 'r2', name: 'R2 credentials' }
    const endpoint = procEnv.R2_ENDPOINT
    const bucket = procEnv.R2_BUCKET
    if (!endpoint && !bucket) {
        return {
            ...base,
            status: 'skip',
            detail: 'R2 not configured — only needed for `cf upload --r2` / `cf publish --r2` / `cf prune --r2`',
        }
    }
    if (!endpoint || !bucket) {
        return {
            ...base,
            status: 'fail',
            detail: 'R2_ENDPOINT / R2_BUCKET incomplete — set both or neither',
            hint: 'compare with the [r2] section in cofoundry.toml',
        }
    }
    if (!deps.whichLocal('aws')) {
        return {
            ...base,
            status: 'fail',
            detail: 'no `aws` CLI on PATH — R2 uploads shell out to it',
            hint: 'install the AWS CLI and configure the R2 access key (`aws configure`)',
        }
    }
    try {
        await deps.probeR2(endpoint, bucket)
        return { ...base, status: 'ok', detail: `s3://${bucket} reachable` }
    } catch (err) {
        return {
            ...base,
            status: 'fail',
            detail: firstLine(err),
            hint: 'check the R2 access key/secret (`aws configure`) and that R2_ENDPOINT/R2_BUCKET match the Cloudflare dashboard',
        }
    }
}

// ── orchestration ─────────────────────────────────────────────────────────────

/** Ids/names of every node-side check, used to emit skip rows when the checks
 *  cannot run (local preflight failed or the node is unreachable). */
const REMOTE_CHECKS: ReadonlyArray<{ id: string; name: string }> = [
    { id: 'ssh-connect', name: 'SSH to node' },
    { id: 'node-tools', name: 'Node tools' },
    { id: 'storage', name: 'Storage (CF_STORAGE)' },
    { id: 'iso-storage', name: 'ISO storage (CF_ISO_STORAGE)' },
    { id: 'bridge', name: 'Bridge (CF_BRIDGE)' },
    { id: 'build-bridge', name: 'Build bridge (CF_BUILD_BRIDGE)' },
    { id: 'dnsmasq', name: 'dnsmasq (build DHCP)' },
    { id: 'pve-api', name: 'Proxmox API' },
    { id: 'iso-space', name: 'ISO cache space' },
    { id: 'dump-space', name: 'Dump dir space' },
]

const skipChecks = (ids: string[], reason: string): DoctorCheck[] =>
    REMOTE_CHECKS.filter(check => ids.includes(check.id)).map(check => ({
        ...check,
        status: 'skip' as const,
        detail: reason,
    }))

const finish = (checks: DoctorCheck[]): DoctorReport => ({
    checks,
    ok: checks.every(check => check.status !== 'fail'),
})

export const runDoctorChecks = async (
    procEnv: NodeJS.ProcessEnv,
    deps: DoctorDeps
): Promise<DoctorReport> => {
    const checks: DoctorCheck[] = []

    // 1. Required env vars — everything downstream needs them.
    const missing = missingRequiredEnv(procEnv)
    checks.push(
        missing.length === 0
            ? {
                  id: 'env',
                  name: 'Env vars',
                  status: 'ok',
                  detail: 'all required variables set',
              }
            : {
                  id: 'env',
                  name: 'Env vars',
                  status: 'fail',
                  detail: `missing or invalid: ${missing.join(', ')}`,
                  hint: 'set them in .env or cofoundry.toml — inspect the resolution with `cf config`',
              }
    )

    // 2. Local ssh client — every remote interaction shells out to it
    //    (src/build/remote.ts throws the same "not found" error mid-build).
    const sshPath = deps.whichLocal('ssh')
    checks.push(
        sshPath
            ? {
                  id: 'local-ssh',
                  name: 'Local ssh',
                  status: 'ok',
                  detail: sshPath,
              }
            : {
                  id: 'local-ssh',
                  name: 'Local ssh',
                  status: 'fail',
                  detail: 'no `ssh` binary on PATH',
                  hint: 'install an OpenSSH client (Windows: Git Bash or the OpenSSH optional feature) and make sure `ssh` resolves',
              }
    )

    if (missing.length > 0 || !sshPath) {
        checks.push(
            ...skipChecks(
                REMOTE_CHECKS.map(check => check.id),
                'skipped — fix the local checks first'
            )
        )
        checks.push(await r2Check(procEnv, deps))
        return finish(checks)
    }

    const env = parseEnv(procEnv)
    const paths = remotePaths(env)

    // 3. SSH connectivity — a cheap `true` with a short timeout.
    try {
        await deps.probeSsh(env.SSH_TARGET)
        checks.push({
            id: 'ssh-connect',
            name: 'SSH to node',
            status: 'ok',
            detail: env.SSH_TARGET,
        })
    } catch (err) {
        checks.push({
            id: 'ssh-connect',
            name: 'SSH to node',
            status: 'fail',
            detail: firstLine(err),
            hint: `check SSH_TARGET (${env.SSH_TARGET}), that the node is up, and that your public key is in its authorized_keys — the probe runs non-interactively (BatchMode), so password auth cannot satisfy it`,
        })
        checks.push(
            ...skipChecks(
                REMOTE_CHECKS.map(check => check.id).filter(
                    id => id !== 'ssh-connect'
                ),
                'skipped — node unreachable over SSH'
            )
        )
        checks.push(await r2Check(procEnv, deps))
        return finish(checks)
    }

    // 4-6 + 8. One bundled sweep: tools, pvesm, bridges, free space.
    let sections: Map<string, string> | undefined
    try {
        sections = splitSections(
            await deps.captureScript(
                env.SSH_TARGET,
                doctorSweepScript({
                    bridge: env.CF_BRIDGE,
                    buildBridge: env.CF_BUILD_BRIDGE,
                    isoCacheDir: paths.isoStore,
                    dumpDir: paths.dump,
                })
            )
        )
    } catch (err) {
        checks.push({
            id: 'node-sweep',
            name: 'Node inspection',
            status: 'fail',
            detail: firstLine(err),
            hint: 'the bundled node inspection failed to run over SSH',
        })
        checks.push(
            ...skipChecks(
                [
                    'node-tools',
                    'storage',
                    'iso-storage',
                    'bridge',
                    'build-bridge',
                    'dnsmasq',
                    'iso-space',
                    'dump-space',
                ],
                'skipped — node inspection failed'
            )
        )
    }

    if (sections) {
        const pools = parsePvesmStatus(sections.get('pvesm') ?? '')
        checks.push(
            toolsCheck(parseToolSweep(sections.get('tools') ?? '')),
            storageCheck(pools, env.CF_STORAGE, 'disks'),
            storageCheck(pools, env.CF_ISO_STORAGE, 'isos'),
            bridgeCheck(sections.get('link:bridge') ?? '', env.CF_BRIDGE),
            buildBridgeCheck(
                sections.get('link:build-bridge') ?? '',
                sections.get('ifquery:build-bridge') ?? '',
                sections.get('addr:build-bridge') ?? '',
                env.CF_BUILD_BRIDGE
            ),
            dnsmasqCheck(
                sections.get('dnsmasq') ?? '',
                sections.get('dnsmasq-hostsdir') ?? ''
            )
        )
    }

    // 7. Proxmox API reachability + token validity, probed from the node.
    try {
        const raw = await deps.captureScript(
            env.SSH_TARGET,
            apiCheckScript(env)
        )
        checks.push(apiCheck(raw))
    } catch (err) {
        checks.push({
            id: 'pve-api',
            name: 'Proxmox API',
            status: 'fail',
            detail: firstLine(err),
            hint: `could not reach https://${env.PVE_HOST}:${env.PVE_PORT} from the node — check PVE_HOST/PVE_PORT and the node-side firewall`,
        })
    }

    if (sections) {
        checks.push(
            diskSpaceCheck(
                sections.get('df:iso') ?? '',
                { id: 'iso-space', name: 'ISO cache space' },
                paths.isoStore,
                'the ISO directory lives on the storage pool — check CF_ISO_STORAGE and that the pool allows ISO content'
            ),
            diskSpaceCheck(
                sections.get('df:dump') ?? '',
                { id: 'dump-space', name: 'Dump dir space' },
                paths.dump,
                'directory missing — check PVE_DUMP_DIR and run `cf bootstrap`'
            )
        )
    }

    checks.push(await r2Check(procEnv, deps))

    return finish(checks)
}
