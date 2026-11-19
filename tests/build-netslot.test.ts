import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSlotAllocationScript } from '@/build/netslot.ts'
import { RUN_LEASE_STALE_SECS } from '@/build/lease.ts'

const script = (): string =>
    buildSlotAllocationScript({ CF_BUILD_BRIDGE: 'vmbr1' })

const roots: string[] = []
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true })
})

/**
 * Run the generated script's `vmid_leased` helper against a throwaway lease
 * directory.
 *
 * The guard is lifted out of the real script text rather than reimplemented, so
 * this exercises the shell that actually ships. Only the hardcoded lease
 * directory is redirected — everything else, including the staleness
 * arithmetic, is the production code.
 */
const vmidLeased = (
    vmid: string,
    leases: { name: string; fields: string[]; ageSecs: number }[]
): boolean => {
    const root = mkdtempSync(join(tmpdir(), 'cofoundry-netslot-'))
    roots.push(root)
    for (const lease of leases) {
        const path = join(root, lease.name)
        writeFileSync(path, lease.fields.join('\t') + '\n')
        const when = new Date(Date.now() - lease.ageSecs * 1000)
        utimesSync(path, when, when)
    }

    const body = script()
    const start = body.indexOf('vmid_leased() {')
    const end = body.indexOf('# Succeed if any VM carrying MAC $1 is owned by')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const fn = body
        .slice(start, end)
        .replaceAll("'/var/lib/cofoundry/run-leases'", `'${root}'`)

    const result = spawnSync(
        'bash',
        ['-c', `set -e\nnow=$(date +%s)\n${fn}\nvmid_leased '${vmid}'`],
        { encoding: 'utf8' }
    )
    return result.status === 0
}

// Field order matches reapLeaseBody in src/build/lease.ts:
// kind, recipe, vmid, memory, cores, tmpdir, preserve_vm, storage, packer_tmpdir
const lease = (vmid: string, ageSecs: number, name = 'run-1') => ({
    name,
    fields: ['build', 'windows-server-2025', vmid, '8192', '4', '/tmp/x', '0'],
    ageSecs,
})

describe('buildSlotAllocationScript', () => {
    test('is valid Bash and derives addresses from the configured bridge', () => {
        const body = script()
        const result = spawnSync('bash', ['-n'], {
            input: body,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(body).toContain("bridge='vmbr1'")
        expect(body).toContain('bridge_cidr=$(ip -4')
        expect(body).toContain('if fits_block 100')
        expect(body).toContain("'test-owner'")
        expect(body).toContain('/var/lib/cofoundry/netslots')
    })

    test('scans the cluster-wide config tree, not just the local node', () => {
        const body = script()
        // Orphan discovery must see peers' VMs, reachable only under
        // /etc/pve/nodes/<node>/qemu-server (the bare /etc/pve/qemu-server
        // symlink covers the local node alone).
        expect(body).toContain('/etc/pve/nodes/*/qemu-server/*.conf')
        expect(body).not.toContain('for cf in /etc/pve/qemu-server/*.conf')
    })

    test('reclaims a stale slot only when nothing still holds its MAC', () => {
        const body = script()
        // A static-IP build (Debian/Ubuntu preseed) never takes a DHCP lease, so
        // the running-VM guard is what keeps its slot from being reclaimed and
        // its VM evicted mid-build.
        expect(body).toContain('! slot_mac_running "$smac"')
        // ...and a build in its export phase is legitimately STOPPED, so the
        // run lease is what proves it alive.
        expect(body).toContain('! slot_mac_leased "$smac"')
    })

    test('evicts orphans on the node that owns them', () => {
        const body = script()
        expect(body).toContain('qm_on_node "$node" "$vid" stop')
        expect(body).toContain('qm_on_node "$node" "$vid" destroy')
    })

    test('eviction refuses a leased VM and anything not a packer build VM', () => {
        const body = script()
        const evict = body.slice(
            body.indexOf('slot_vms_for_mac "$mac" | while')
        )
        // Both guards must `continue` BEFORE the destroy, not merely log.
        expect(evict).toContain('if vmid_leased "$vid"; then')
        expect(evict).toContain('packer-*) ;;')
        const leaseGuard = evict.indexOf('vmid_leased "$vid"')
        const nameGuard = evict.indexOf('packer-*)')
        const destroy = evict.indexOf('destroy --purge')
        expect(leaseGuard).toBeLessThan(destroy)
        expect(nameGuard).toBeLessThan(destroy)
    })
})

describe('vmid_leased', () => {
    test('reports a build alive while its lease is fresh', () => {
        // The case that motivated the guard: the VM is stopped for its export,
        // but its `cf` process is heartbeating the lease every 60s.
        expect(vmidLeased('200205', [lease('200205', 30)])).toBe(true)
    })

    test('holds a slot for the whole stale window, then lets it go', () => {
        // Derived from the constant, not a copy of it. This test previously
        // hardcoded the old 600s window and started failing the moment the
        // window was widened — the guard was right and the test was stale.
        const window = RUN_LEASE_STALE_SECS
        expect(vmidLeased('200205', [lease('200205', window - 60)])).toBe(true)
        expect(vmidLeased('200205', [lease('200205', window + 60)])).toBe(false)
    })

    test('does not match a different VMID', () => {
        expect(vmidLeased('200205', [lease('400105', 30)])).toBe(false)
    })

    test('finds the match among several leases', () => {
        expect(
            vmidLeased('200205', [
                lease('400105', 30, 'run-a'),
                lease('600108', 30, 'run-b'),
                lease('200205', 30, 'run-c'),
            ])
        ).toBe(true)
    })

    test('never matches an unset VMID', () => {
        // A lease is created before its VM exists, recording vmid 0 until
        // setVmid runs. That must not make every slot look occupied.
        expect(vmidLeased('0', [lease('0', 30)])).toBe(false)
        expect(vmidLeased('', [lease('0', 30)])).toBe(false)
    })

    test('is false with no leases at all', () => {
        expect(vmidLeased('200205', [])).toBe(false)
    })
})

/**
 * Run the shipped `slot_mac_running` / `slot_mac_leased` against stubbed
 * cluster state. The helpers are lifted from the real script text; only their
 * collaborators (the MAC lookup, `qm status`, the lease probe) are stubbed.
 */
const slotProbe = (
    probe: 'slot_mac_running' | 'slot_mac_leased',
    vms: { vmid: string; status: string; leased: boolean }[]
): boolean => {
    const body = script()
    const start = body.indexOf(`${probe}() {`)
    expect(start).toBeGreaterThan(-1)
    const end = body.indexOf('\n}\n', start)
    const fn = body.slice(start, end + 2)
    const stubs = [
        vms.length === 0
            ? 'slot_vms_for_mac() { :; }'
            : `slot_vms_for_mac() { printf '%s\\n' ${vms.map(v => `'node1 ${v.vmid}'`).join(' ')}; }`,
        `qm_on_node() { case "$2" in ${vms.map(v => `${v.vmid}) echo "status: ${v.status}" ;;`).join(' ')} *) return 2 ;; esac; }`,
        `vmid_leased() { case "$1" in ${vms
            .filter(v => v.leased)
            .map(v => `${v.vmid}) return 0 ;;`)
            .join(' ')} *) return 1 ;; esac; }`,
    ].join('\n')
    const result = spawnSync(
        'bash',
        ['-c', `${stubs}\n${fn}\n${probe} 02:50:4b:00:00:69`],
        { encoding: 'utf8' }
    )
    return result.status === 0
}

describe('slot reclaim probes', () => {
    test('report a slot free when no VM carries its MAC', () => {
        // The leak: a zero-iteration `while` exits 0, so a slot whose VM was
        // already gone looked running and leased, and was never reclaimed.
        expect(slotProbe('slot_mac_running', [])).toBe(false)
        expect(slotProbe('slot_mac_leased', [])).toBe(false)
    })

    test('report a stopped, unleased VM as neither running nor leased', () => {
        const vms = [{ vmid: '200205', status: 'stopped', leased: false }]
        expect(slotProbe('slot_mac_running', vms)).toBe(false)
        expect(slotProbe('slot_mac_leased', vms)).toBe(false)
    })

    test('find a running or leased VM among several', () => {
        const vms = [
            { vmid: '400105', status: 'stopped', leased: false },
            { vmid: '200205', status: 'running', leased: true },
            { vmid: '600108', status: 'stopped', leased: false },
        ]
        expect(slotProbe('slot_mac_running', vms)).toBe(true)
        expect(slotProbe('slot_mac_leased', vms)).toBe(true)
    })
})
