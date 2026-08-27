import { captureRemote, registerCleanup } from '@/build/remote.ts'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Env } from '@/env.ts'
import { shellQuote } from '@/util.ts'
import { BUILD_SLOT_BASE, BUILD_SLOT_COUNT } from '@/build/buildnet.ts'
import { RUN_LEASE_DIR, RUN_LEASE_STALE_SECS } from '@/build/lease.ts'

// Per-build network slot allocated on the node's configured NAT build bridge.
// Each slot owns one IP + a deterministic MAC, registered with dnsmasq as a
// static DHCP reservation so Packer can address the build VM up-front (no IP
// discovery, no race with the qemu-guest-agent). Multiple slots are independent,
// so builds can run in parallel on a single node.
//
// Layout:
//   IP  = <live bridge /24>.<100 + slotIndex> for slotIndex in [0, BUILD_SLOT_COUNT)
//   MAC = 02:50:4B:00:00:<slot byte>
//   Reservation file: /etc/dnsmasq.d/cofoundry-hosts.d/slot-<NN>
//
// Reservations live in a dhcp-hostsfile= directory (configured by bootstrap)
// because `dhcp-host=` lines in regular /etc/dnsmasq.d/*.conf files are only
// parsed at dnsmasq startup — SIGHUP does not re-read them, so adding a
// reservation at build time would silently fall through to the dynamic pool.
// Files in a dhcp-hostsfile dir are re-read on SIGHUP.
//
// Free-slot discovery is `flock`-serialised on the node so concurrent
// `cf build` invocations can't pick the same slot.
//
// Orphan reclaim: a build killed by anything other than a clean exit or SIGINT
// (SIGTERM/SIGKILL, OOM, host reboot, power loss) leaves its snippet behind,
// silently leaking a slot forever. So allocation first reconciles: any snippet
// with no live DHCP lease for its IP, whose file is older than
// STALE_RECLAIM_SECS, whose slot VM is not still running, AND whose slot VM is
// not held by a live run lease, belongs to a build that's long gone and is
// swept. A DHCP build holds a non-expired lease (12h lease time, far longer
// than any build); a static-IP build (Debian/Ubuntu preseed) never leases at
// all, so the running-VM check — not the DHCP probe — is what proves it live.
// The age guard keeps us from racing a just-allocated slot whose VM hasn't
// booted yet.
//
// The run-lease check exists because power state is not liveness. Packer stops
// the build VM and templates it before the export post-processor runs, so a
// healthy build sits stopped for the whole export — long enough, on 2026-08-25,
// for a concurrent build to reclaim netslot 05 and destroy a windows-server-2025
// build VM 3h26m in. The run lease is heartbeated by the owning `cf` process and
// records its VMID, so it answers "is this build alive" correctly regardless of
// whether the VM happens to be powered on.
//
// Eviction is separately guarded: it destroys VMs, and it must never touch one
// a live lease owns, nor anything that is not a `packer-*` build VM. Installed
// templates restored by older coport releases carry their build VM's MAC (no
// --unique on qmrestore), and build MACs are deterministic per slot, so an
// unguarded eviction deletes a user's templates — eleven of them, once.

const LOCK_DIR = '/var/lib/cofoundry'
const LOCK_FILE = `${LOCK_DIR}/netslot.lock`
const SNIPPET_DIR = '/etc/dnsmasq.d/cofoundry-hosts.d'
const SNIPPET_PREFIX = 'slot-'
const LEASES_FILE = '/var/lib/misc/dnsmasq.leases'
const OWNER_DIR = `${LOCK_DIR}/netslots`

// A snippet with no active lease is only reclaimed once it's older than this —
// comfortably longer than the worst-case gap between allocating a slot and the
// build VM acquiring its DHCP lease (slow Windows PE boot is still minutes).
const STALE_RECLAIM_SECS = 1800

export type BuildSlot = {
    ip: string
    gw: string
    mac: string
    slotIndex: number
    release: () => Promise<void>
}

// Reload the system dnsmasq service atomically so it re-reads the hostsfile
// directory without disturbing in-flight leases. Bootstrap rejects unmanaged
// or multiple dnsmasq instances, so builds must target this specific service
// rather than signalling every process named dnsmasq on the node.
const reloadDnsmasqCmd = `(systemctl reload dnsmasq 2>/dev/null || systemctl restart dnsmasq) && sleep 0.2`

const releaseSlotOwnerScript = (owner: string): string =>
    `exec 9>${shellQuote(LOCK_FILE)}; flock 9; changed=0; ` +
    `for owner_file in ${shellQuote(OWNER_DIR)}/${SNIPPET_PREFIX}*; do ` +
    `[ -f "$owner_file" ] || continue; ` +
    `if [ "$(cat "$owner_file" 2>/dev/null || true)" = ${shellQuote(owner)} ]; then ` +
    `slot=\${owner_file##*/}; rm -f ${shellQuote(SNIPPET_DIR)}/"$slot" "$owner_file"; changed=1; fi; done; ` +
    `[ "$changed" -eq 0 ] || ${reloadDnsmasqCmd}`

export const buildSlotAllocationScript = (
    env: Pick<Env, 'CF_BUILD_BRIDGE'>,
    owner = 'test-owner'
): string => `
set -e
bridge=${shellQuote(env.CF_BUILD_BRIDGE)}
bridge_cidr=$(ip -4 -o addr show dev "$bridge" | awk '$3=="inet" {print $4; exit}')
case "$bridge_cidr" in
    */24) ;;
    *) echo "build bridge $bridge must have one IPv4 /24 address (found: \${bridge_cidr:-none})" >&2; exit 1 ;;
esac
gateway=\${bridge_cidr%/24}
prefix=\${gateway%.*}

# Pick a stable 50-address block outside every existing dnsmasq dynamic range
# and direct static reservation. Prefer the historical .100-.149 block, then
# scan upward from .2. Cofoundry's own hostsfile directory is intentionally not
# part of this scan, so concurrent slots don't make the chosen block move.
occupied=" \${gateway##*.} "
while IFS= read -r spec; do
    spec=\${spec//[[:space:]]/}
    first=""; second=""
    IFS=',' read -ra parts <<< "$spec"
    for part in "\${parts[@]}"; do
        [[ "$part" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
        [ "\${part%.*}" = "$prefix" ] || continue
        if [ -z "$first" ]; then first=\${part##*.}; elif [ -z "$second" ]; then second=\${part##*.}; break; fi
    done
    [ -n "$first" ] && [ -n "$second" ] || continue
    n=$first
    while [ "$n" -le "$second" ]; do occupied="$occupied$n "; n=$((n + 1)); done
done < <(grep -hE '^[[:space:]]*dhcp-range=' /etc/dnsmasq.conf /etc/dnsmasq.d/*.conf 2>/dev/null | sed -E 's/^[[:space:]]*dhcp-range=//')
while IFS= read -r host_ip; do
    [ "\${host_ip%.*}" = "$prefix" ] || continue
    occupied="$occupied\${host_ip##*.} "
done < <(grep -hE '^[[:space:]]*dhcp-host=' /etc/dnsmasq.conf /etc/dnsmasq.d/*.conf 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' || true)
fits_block() {
    candidate=$1
    n=$candidate
    end=$((candidate + ${BUILD_SLOT_COUNT} - 1))
    [ "$end" -le 254 ] || return 1
    while [ "$n" -le "$end" ]; do
        case "$occupied" in *" $n "*) return 1 ;; esac
        n=$((n + 1))
    done
}
slot_base=""
if fits_block ${BUILD_SLOT_BASE}; then
    slot_base=${BUILD_SLOT_BASE}
else
    candidate=2
    while [ "$candidate" -le 205 ]; do
        if fits_block "$candidate"; then slot_base=$candidate; break; fi
        candidate=$((candidate + 1))
    done
fi
if [ -z "$slot_base" ]; then
    echo "no contiguous ${BUILD_SLOT_COUNT}-address build-slot block is free on $bridge ($prefix.0/24)" >&2
    exit 1
fi

mkdir -p ${shellQuote(LOCK_DIR)} ${shellQuote(SNIPPET_DIR)} ${shellQuote(OWNER_DIR)}
exec 9>${shellQuote(LOCK_FILE)}
flock 9

# Canonical local node name (pmxcfs symlinks /etc/pve/local -> nodes/<self>).
local_node=$(basename "$(readlink /etc/pve/local 2>/dev/null || true)" 2>/dev/null)
[ -n "$local_node" ] || local_node=$(hostname)

# Run a qm subcommand on the node that owns the VM. \`qm\` only manages the
# local node, so an orphan on a peer must be reached over the root SSH trust
# every PVE cluster shares between its nodes.
qm_on_node() { # node vmid subcommand [flags...]
    _n=$1; _v=$2; _sub=$3; shift 3
    if [ "$_n" = "$local_node" ]; then
        qm "$_sub" "$_v" "$@"
    else
        ssh -o BatchMode=yes -o ConnectTimeout=5 "$_n" "qm $_sub $_v $*"
    fi
}

# Emit "node vmid" for every VM config across the cluster carrying MAC $1.
# Cluster configs live under /etc/pve/nodes/<node>/qemu-server; the bare
# /etc/pve/qemu-server symlink only ever covers the local node, so a peer's
# orphan is invisible through it. qm config stores MACs upper-cased, so the
# grep is case-insensitive.
slot_vms_for_mac() {
    for _cf in /etc/pve/nodes/*/qemu-server/*.conf; do
        [ -e "$_cf" ] || continue
        grep -iqF "$1" "$_cf" || continue
        _v=\${_cf##*/}; _v=\${_v%.conf}
        _node=\${_cf#/etc/pve/nodes/}; _node=\${_node%%/*}
        printf '%s %s\\n' "$_node" "$_v"
    done
}

# Succeed if any VM carrying MAC $1 is currently running anywhere in the cluster.
slot_mac_running() {
    slot_vms_for_mac "$1" | while read -r _n _v; do
        _st=$(qm_on_node "$_n" "$_v" status 2>/dev/null | awk '{print $2}')
        [ "$_st" = "running" ] && exit 0
    done
}

# Succeed if a live run lease owns VMID $1.
#
# Power state cannot answer "is this build still going". Packer stops the build
# VM and converts it to a template BEFORE the export post-processor runs, so a
# perfectly healthy build sits stopped for the whole export — minutes, for a
# 32 G qcow2 conversion. On 2026-08-25 that window was long enough for a
# concurrent build to reclaim netslot 05 and destroy VM 200205 mid-export,
# losing its EFI varstore.
#
# The run lease is the authority instead: it is heartbeated every 60s by the
# owning \`cf\` process and records its VMID, so a fresh lease means the build is
# alive whatever the VM's power state. A lease older than the stale window
# belongs to a process that is gone.
vmid_leased() {
    _want=$1
    [ -n "$_want" ] && [ "$_want" != 0 ] || return 1
    for _lease in ${shellQuote(RUN_LEASE_DIR)}/*; do
        [ -f "$_lease" ] || continue
        _age=$(( now - $(stat -c %Y "$_lease" 2>/dev/null || echo 0) ))
        [ "$_age" -le ${RUN_LEASE_STALE_SECS} ] || continue
        IFS=$'\\t' read -r _k _r _lv _rest < "$_lease" || continue
        [ "$_lv" = "$_want" ] && return 0
    done
    return 1
}

# Succeed if any VM carrying MAC $1 is owned by a live run lease.
slot_mac_leased() {
    slot_vms_for_mac "$1" | while read -r _n _v; do
        vmid_leased "$_v" && exit 0
    done
}

now=$(date +%s)
# Reclaim orphaned snippets: no live (non-expired) lease for the reserved IP,
# the file is older than the boot/DHCP grace window, and no running VM still
# holds the slot MAC — so the owning build is gone (see header note on why a
# static-IP build needs the running-VM check, not just the lease probe).
for f in ${shellQuote(SNIPPET_DIR)}/${SNIPPET_PREFIX}*; do
    [ -e "$f" ] || continue
    smac=$(cut -d, -f1 "$f")
    sip=$(cut -d, -f2 "$f")
    active=0
    if [ -f ${shellQuote(LEASES_FILE)} ] && awk -v ip="$sip" -v now="$now" \\
        '$3==ip && ($1+0==0 || $1+0>now){f=1} END{exit !f}' ${shellQuote(LEASES_FILE)}; then
        active=1
    fi
    mt=$(stat -c %Y "$f" 2>/dev/null || echo "$now")
    if [ "$active" -eq 0 ] && [ "$(( now - mt ))" -gt ${STALE_RECLAIM_SECS} ] \\
        && ! slot_mac_running "$smac" && ! slot_mac_leased "$smac"; then
        echo "reclaiming stale netslot \${f##*/} ($sip): no lease, no running VM, age $(( now - mt ))s" >&2
        rm -f "$f"
        rm -f ${shellQuote(OWNER_DIR)}/"\${f##*/}"
    fi
done
used=" "
for f in ${shellQuote(SNIPPET_DIR)}/${SNIPPET_PREFIX}*; do
    [ -e "$f" ] || continue
    base=\${f##*/}
    n=\${base#${SNIPPET_PREFIX}}
    used="$used$n "
done
pick=""
i=0
while [ "$i" -lt ${BUILD_SLOT_COUNT} ]; do
    pad=$(printf '%02d' "$i")
    case "$used" in
        *" $pad "*) ;;
        *) pick="$i"; break ;;
    esac
    i=$((i + 1))
done
if [ -z "$pick" ]; then
    echo "no free slot (all ${BUILD_SLOT_COUNT} reservations in use)" >&2
    exit 1
fi
pad=$(printf '%02d' "$pick")
ip="$prefix.$(( slot_base + pick ))"
byte=$(printf '%02x' "$(( slot_base + pick ))")
mac="02:50:4b:00:00:$byte"
# Evict VMs squatting this slot's MAC, anywhere in the cluster. Left alive, such
# a VM answers ARP for the slot IP and the new build VM's traffic blackholes —
# Packer then waits out its full SSH/WinRM timeout.
#
# Two guards, because this destroys data and the original had neither. The
# premise used to be "a slot is exclusive, so the only VM carrying this MAC is a
# build orphan". Both halves were false:
#
#   1. A LIVE build's VM carries it. Packer stops the VM for the whole export,
#      so it is invisible to a power-state check. Skipping VMIDs held by a fresh
#      run lease is what keeps a concurrent build from deleting it (2026-08-25:
#      "evicting orphan VM 200205 ... squatting netslot 05" killed a
#      windows-server-2025 build 3h26m in).
#
#   2. INSTALLED TEMPLATES carry it. coport used to restore with \`qmrestore\` and
#      no --unique, so every template it installed kept its build VM's MAC —
#      and build MACs are deterministic per slot. One \`cf build\` drawing that
#      slot wiped eleven of them. Build VMs are named \`packer-*\` (packer sets
#      vm_name, and the export never renames it), so a VM that is not \`packer-*\`
#      is not ours to destroy no matter whose MAC it wears.
#
# A VM that trips a guard is reported, not silently skipped: if it really is
# squatting the slot, the build that follows will fail on a network timeout and
# this line is the only thing that explains why.
slot_vms_for_mac "$mac" | while read -r node vid; do
    vname=$(qm_on_node "$node" "$vid" config 2>/dev/null | sed -nE 's/^name: (.*)$/\\1/p')
    if vmid_leased "$vid"; then
        echo "netslot $pad ($ip): VM $vid on $node carries this MAC but a live run lease owns it — not evicting" >&2
        continue
    fi
    case "$vname" in
        packer-*) ;;
        *)
            echo "netslot $pad ($ip): VM $vid on $node ('\${vname:-unnamed}') carries this MAC but is not a packer build VM — not evicting" >&2
            continue
            ;;
    esac
    echo "evicting orphan VM $vid on node $node squatting netslot $pad ($ip)" >&2
    qm_on_node "$node" "$vid" stop --skiplock 1 >/dev/null 2>&1 || true
    qm_on_node "$node" "$vid" destroy --purge 1 --destroy-unreferenced-disks 1 --skiplock 1 >/dev/null 2>&1 || true
done
printf '%s,%s\\n' "$mac" "$ip" > ${shellQuote(SNIPPET_DIR)}/${SNIPPET_PREFIX}"$pad"
printf '%s\\n' ${shellQuote(owner)} > ${shellQuote(OWNER_DIR)}/${SNIPPET_PREFIX}"$pad"
# Purge any stale lease holding the reserved IP or matching the reserved MAC,
# so a previous build's lease can't squat on the slot. dnsmasq re-reads the
# leases file on SIGHUP.
if [ -f ${shellQuote(LEASES_FILE)} ]; then
    awk -v ip="$ip" -v mac="$mac" '$2 != mac && $3 != ip' ${shellQuote(LEASES_FILE)} > ${shellQuote(LEASES_FILE)}.tmp && mv ${shellQuote(LEASES_FILE)}.tmp ${shellQuote(LEASES_FILE)}
fi
${reloadDnsmasqCmd}
echo "$pick,$ip,$gateway,$mac"
`
export const allocateBuildSlot = async (env: Env): Promise<BuildSlot> => {
    // One atomic shell pass: take the lock, scan existing snippets, pick the
    // first free index, write the new snippet, reload dnsmasq, print the slot.
    const owner = randomUUID()
    const script = buildSlotAllocationScript(env, owner)
    let out: string
    try {
        out = await captureRemote(
            env.SSH_TARGET,
            `bash -s <<'__CF_NETSLOT__'\n${script}\n__CF_NETSLOT__`
        )
    } catch (error) {
        await captureRemote(
            env.SSH_TARGET,
            releaseSlotOwnerScript(owner)
        ).catch(() => {})
        throw error
    }
    const [slotRaw, ip = '', gw = '', mac = ''] = out.trim().split(',')
    const slotIndex = Number.parseInt(slotRaw ?? '', 10)
    if (
        !Number.isFinite(slotIndex) ||
        slotIndex < 0 ||
        slotIndex >= BUILD_SLOT_COUNT ||
        !/^\d+\.\d+\.\d+\.\d+$/.test(ip) ||
        !/^\d+\.\d+\.\d+\.\d+$/.test(gw) ||
        !/^02:50:4b:00:00:[0-9a-f]{2}$/i.test(mac)
    ) {
        await captureRemote(
            env.SSH_TARGET,
            releaseSlotOwnerScript(owner)
        ).catch(() => {})
        throw new Error(`netslot allocator returned invalid index: ${out}`)
    }

    let released = false
    const releaseScript = releaseSlotOwnerScript(owner)

    // Synchronous SIGINT cleanup: best-effort delete the snippet over ssh.
    const unregister = registerCleanup(() => {
        if (released) return
        process.stderr.write(
            `\ncancelled — releasing netslot ${slotIndex} (${ip})\n`
        )
        spawnSync('ssh', [env.SSH_TARGET, releaseScript], { stdio: 'ignore' })
    })

    const release = async (): Promise<void> => {
        if (released) return
        released = true
        unregister()
        await captureRemote(env.SSH_TARGET, releaseScript).catch(() => {})
    }

    return { ip, gw, mac, slotIndex, release }
}
