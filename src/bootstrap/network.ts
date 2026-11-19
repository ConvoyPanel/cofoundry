import { execa } from 'execa'
import { remoteStreaming } from '@/build/remote.ts'
import {
    BUILD_NET_GATEWAY,
    buildNetworkFromGateway,
    type BuildNetwork,
} from '@/build/buildnet.ts'
import { shellQuote } from '@/util.ts'
import type { BootstrapStep } from '@/bootstrap/model.ts'
import { sshCapture, sshOk, writeRemoteFile } from '@/bootstrap/remote.ts'

const APT_INSTALL = 'DEBIAN_FRONTEND=noninteractive apt-get install -y'
const DNSMASQ_CONF_PATH = '/etc/dnsmasq.d/vmbr1-nat.conf'
const DNSMASQ_HOSTS_DIR = '/etc/dnsmasq.d/cofoundry-hosts.d'

const activeDirectives = (activeConfig: string): string[] =>
    activeConfig
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => line.replace(/^.*?:\d+:/, '').replaceAll(/\s/g, ''))

const rangeAddresses = (directive: string): string[] =>
    directive
        .slice('dhcp-range='.length)
        .split(',')
        .filter(part => /^\d+\.\d+\.\d+\.\d+$/.test(part))

const buildRangeState = (
    directive: string,
    network: BuildNetwork
): 'outside' | 'present' => {
    if (!directive.startsWith('dhcp-range=')) return 'outside'
    const addresses = rangeAddresses(directive)
    if (
        addresses.length < 2 ||
        !addresses[0]?.startsWith(`${network.prefix}.`) ||
        !addresses[1]?.startsWith(`${network.prefix}.`)
    ) {
        return 'outside'
    }
    return 'present'
}

export const findBuildSlotBase = (
    activeConfig: string,
    network: BuildNetwork
): number | undefined => {
    const occupied = new Set<number>()
    occupied.add(Number.parseInt(network.gateway.split('.').at(-1) ?? '', 10))
    for (const directive of activeDirectives(activeConfig)) {
        if (buildRangeState(directive, network) === 'present') {
            const addresses = rangeAddresses(directive)
            const start = Number.parseInt(addresses[0]!.split('.').at(-1)!, 10)
            const end = Number.parseInt(addresses[1]!.split('.').at(-1)!, 10)
            for (let address = start; address <= end; address++) {
                occupied.add(address)
            }
        }
        if (directive.startsWith('dhcp-host=')) {
            const address = directive
                .split(',')
                .find(part => part.startsWith(`${network.prefix}.`))
            if (address) {
                occupied.add(
                    Number.parseInt(address.split('.').at(-1) ?? '', 10)
                )
            }
        }
    }
    const candidates = [100, ...Array.from({ length: 204 }, (_, i) => i + 2)]
    return candidates.find(base =>
        Array.from({ length: 50 }, (_, i) => base + i).every(
            address => address <= 254 && !occupied.has(address)
        )
    )
}

export const dnsmasqConf = (
    buildDns: string,
    activeConfig = '',
    buildGateway = BUILD_NET_GATEWAY,
    buildBridge = 'vmbr1'
): string => {
    const network = buildNetworkFromGateway(buildGateway)
    const directives = activeDirectives(activeConfig)
    const lines = ['# Managed by Cofoundry.']
    if (!directives.includes(`interface=${buildBridge}`)) {
        lines.push(`interface=${buildBridge}`)
    }
    if (
        !directives.includes('bind-interfaces') &&
        !directives.includes('bind-dynamic')
    ) {
        lines.push('bind-interfaces')
    }
    if (
        !directives.some(
            directive => buildRangeState(directive, network) === 'present'
        )
    ) {
        lines.push(
            `dhcp-range=${network.dhcpRangeStart},${network.dhcpRangeEnd},12h`
        )
    }
    if (
        !directives.includes(`dhcp-option=3,${network.gateway}`) &&
        !directives.includes(`dhcp-option=option:router,${network.gateway}`)
    ) {
        lines.push(`dhcp-option=option:router,${network.gateway}`)
    }
    const hasDnsOption = directives.some(
        directive =>
            /^dhcp-option=(?:6|option:dns-server),/.test(directive) &&
            directive.split(',').at(-1) !== ''
    )
    if (!hasDnsOption) lines.push(`dhcp-option=6,${buildDns}`)
    if (!directives.includes(`dhcp-hostsfile=${DNSMASQ_HOSTS_DIR}`)) {
        lines.push(`dhcp-hostsfile=${DNSMASQ_HOSTS_DIR}`)
    }
    return `${lines.join('\n')}\n`
}

// The MASQUERADE rule is checked (-C) before it is appended: post-up runs on
// every `ifreload -a` -- which is what the Proxmox GUI's "Apply Configuration"
// does -- and a bare -A stacks one more duplicate rule each time.
export const bridgeStanza = (
    bridge: string,
    network: BuildNetwork,
    uplink: string
): string => {
    const rule = `POSTROUTING -s ${network.cidr} -o ${uplink} -j MASQUERADE`
    return `
auto ${bridge}
iface ${bridge} inet static
    address ${network.bridgeAddress}
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up   iptables -t nat -C ${rule} 2>/dev/null || iptables -t nat -A ${rule}
    post-down iptables -t nat -D ${rule} 2>/dev/null || true
`
}

// The interface carrying the default route: NAT has to leave through it.
// Not assumed to be vmbr0 -- a node whose uplink bridge is named otherwise
// would otherwise get a MASQUERADE rule that matches nothing, and every build
// VM would hang on its first download.
export const DEFAULT_ROUTE_DEV_CMD = `ip -4 route show default | awk '{for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit }}'`

const activeDnsmasqConfigCmd = `{
    [ ! -f /etc/dnsmasq.conf ] || printf '%s\\0' /etc/dnsmasq.conf
    find /etc/dnsmasq.d -maxdepth 1 -type f -name '*.conf' ! -path ${shellQuote(DNSMASQ_CONF_PATH)} -print0 2>/dev/null
} | xargs -0 -r awk '
    /^[[:space:]]*($|#)/ { next }
    /^[[:space:]]*conf-dir=/ { next }
    { print FILENAME ":" FNR ":" $0 }
'`

export const dnsmasqConflict = (
    processState: string,
    activeConfig: string,
    listeners: string,
    buildGateway = BUILD_NET_GATEWAY
): string | undefined => {
    const network = buildNetworkFromGateway(buildGateway)
    const [countRaw, serviceState = ''] = processState.trim().split('|')
    const processCount = Number.parseInt(countRaw ?? '0', 10) || 0
    if (processCount > 1) {
        return `${processCount} dnsmasq processes are running; Cofoundry requires the single system dnsmasq service`
    }
    if (processCount === 1 && serviceState !== 'active') {
        return 'dnsmasq is running outside the system dnsmasq service; Cofoundry cannot safely reload it'
    }

    const configLines = activeConfig
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
    if (findBuildSlotBase(activeConfig, network) === undefined) {
        return `the existing dnsmasq ranges leave no contiguous 50-address build-slot block in ${network.cidr}`
    }

    const explicitlyScoped = configLines.some(line =>
        /:\d+:\s*(interface|listen-address)\s*=/.test(line)
    )
    if (configLines.length > 0 && !explicitlyScoped) {
        return 'the existing dnsmasq configuration is not scoped with interface= or listen-address=; adding Cofoundry would change which interfaces it serves'
    }

    const wildcardSocket = listeners
        .split('\n')
        .map(line => line.trim())
        .find(
            line =>
                /dnsmasq/i.test(line) &&
                /(?:^|\s)(?:\*|0\.0\.0\.0|\[::\]|:::):(53|67)(?:\s|$)/.test(
                    line
                )
        )
    if (processCount === 1 && configLines.length === 0 && wildcardSocket) {
        return 'the existing dnsmasq service listens on all interfaces without an explicit interface= or listen-address= scope'
    }

    const conflictingListener = listeners
        .split('\n')
        .map(line => line.trim())
        .find(
            line =>
                line !== '' &&
                !/dnsmasq/i.test(line) &&
                (/(?:^|\s)(?:\*|0\.0\.0\.0|\[::\]|:::):(53|67)(?:\s|$)/.test(
                    line
                ) ||
                    line.includes(`${network.gateway}:53`) ||
                    line.includes(`${network.gateway}:67`))
        )
    if (conflictingListener) {
        return `another service is listening on a DNS/DHCP wildcard or build-network socket: ${conflictingListener}`
    }
    return undefined
}

const ipv4ToInt = (address: string): number | undefined => {
    const octets = address.split('.').map(part => Number.parseInt(part, 10))
    if (
        octets.length !== 4 ||
        octets.some(
            octet => !Number.isInteger(octet) || octet < 0 || octet > 255
        )
    ) {
        return undefined
    }
    return octets.reduce((value, octet) => value * 256 + octet, 0)
}

const cidrRange = (cidr: string): [number, number] | undefined => {
    const [address, prefixRaw = '32'] = cidr.split('/')
    const ip = ipv4ToInt(address ?? '')
    const prefix = Number.parseInt(prefixRaw, 10)
    if (ip === undefined || prefix < 0 || prefix > 32) return undefined
    const size = 2 ** (32 - prefix)
    const start = Math.floor(ip / size) * size
    return [start, start + size - 1]
}

export const buildNetworkRouteConflict = (
    routes: string,
    buildGateway = BUILD_NET_GATEWAY,
    buildBridge = 'vmbr1'
): string | undefined => {
    const network = buildNetworkFromGateway(buildGateway)
    const wanted = cidrRange(network.cidr)!
    const escapedBridge = buildBridge.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return routes
        .split('\n')
        .map(line => line.trim())
        .filter(
            line =>
                line !== '' &&
                !new RegExp(`(?:^|\\s)dev ${escapedBridge}(?:\\s|$)`).test(line)
        )
        .find(line => {
            const destination = line.split(/\s+/, 1)[0]
            if (!destination || destination === 'default') return false
            const range = cidrRange(destination)
            return range
                ? range[0] <= wanted[1] && wanted[0] <= range[1]
                : false
        })
}

export const hasBuildBridgeAddress = (
    configured: string,
    runtime: string,
    buildGateway = BUILD_NET_GATEWAY
): boolean => {
    const escapedAddress = buildGateway.replaceAll('.', '\\.')
    if (new RegExp(`\\binet\\s+${escapedAddress}/24\\b`).test(runtime)) {
        return true
    }
    if (
        new RegExp(`^\\s*address\\s+${escapedAddress}/24\\s*$`, 'm').test(
            configured
        )
    ) {
        return true
    }
    const hasAddressWithoutPrefix = new RegExp(
        `^\\s*address\\s+${escapedAddress}\\s*$`,
        'm'
    ).test(configured)
    const hasSlashNetmask = /^\s*netmask\s+24\s*$/m.test(configured)
    const hasDottedNetmask = /^\s*netmask\s+255\.255\.255\.0\s*$/m.test(
        configured
    )
    return hasAddressWithoutPrefix && (hasSlashNetmask || hasDottedNetmask)
}

export const bridgeGateway = (
    configured: string,
    runtime: string
): string | undefined => {
    const runtimeMatch = runtime.match(/\binet\s+(\d+\.\d+\.\d+\.\d+)\/24\b/)
    if (runtimeMatch?.[1]) return runtimeMatch[1]
    const cidrMatch = configured.match(
        /^\s*address\s+(\d+\.\d+\.\d+\.\d+)\/24\s*$/m
    )
    if (cidrMatch?.[1]) return cidrMatch[1]
    const address = configured.match(
        /^\s*address\s+(\d+\.\d+\.\d+\.\d+)\s*$/m
    )?.[1]
    const is24 = /^\s*netmask\s+(?:24|255\.255\.255\.0)\s*$/m.test(configured)
    return address && is24 ? address : undefined
}

export const detectBuildGateway = async (
    target: string,
    bridge: string
): Promise<string | undefined> => {
    const quotedBridge = shellQuote(bridge)
    const [configured, runtime] = await Promise.all([
        sshCapture(target, `ifquery ${quotedBridge} 2>/dev/null`),
        sshCapture(
            target,
            `ip -4 -o addr show dev ${quotedBridge} 2>/dev/null`
        ),
    ])
    return bridgeGateway(configured.stdout, runtime.stdout)
}

const detectedBridgeAddress = (configured: string, runtime: string): string => {
    const runtimeAddress = runtime.match(/\binet\s+(\S+)/)?.[1]
    if (runtimeAddress) return runtimeAddress
    const configuredAddress = configured.match(/^\s*address\s+(\S+)/m)?.[1]
    const configuredNetmask = configured.match(/^\s*netmask\s+(\S+)/m)?.[1]
    if (!configuredAddress) return 'no IPv4 address found'
    return configuredNetmask
        ? `${configuredAddress} netmask ${configuredNetmask}`
        : configuredAddress
}

export const stepBuildNetworkPreflight: BootstrapStep = {
    id: 'build-network-preflight',
    label: 'check build-network conflicts',
    probe: async plan => {
        const network = buildNetworkFromGateway(plan.buildGateway)
        const [route, configTest, processState, activeConfig, listeners] =
            await Promise.all([
                sshCapture(
                    plan.target,
                    'ip -4 route show type unicast table all 2>/dev/null'
                ),
                sshCapture(
                    plan.target,
                    'command -v dnsmasq >/dev/null 2>&1 && dnsmasq --test'
                ),
                sshCapture(
                    plan.target,
                    `printf '%s|%s\\n' "$(pgrep -xc dnsmasq 2>/dev/null || true)" "$(systemctl is-active dnsmasq 2>/dev/null || true)"`
                ),
                sshCapture(plan.target, activeDnsmasqConfigCmd),
                sshCapture(
                    plan.target,
                    `{ ss -H -lntup 'sport = :53' 2>/dev/null; ss -H -lunp 'sport = :67' 2>/dev/null; } || true`
                ),
            ])

        const routeConflict = buildNetworkRouteConflict(
            route.stdout,
            plan.buildGateway,
            plan.buildBridge
        )
        if (routeConflict) {
            throw new Error(
                `${network.cidr} overlaps an existing route outside ${plan.buildBridge}: ${routeConflict}`
            )
        }
        // Exit 1 means dnsmasq is installed but its current merged config is
        // invalid. Exit 127/command-not-found is expected on a fresh node.
        if (!configTest.ok && !/not found/i.test(configTest.stderr)) {
            const installed = await sshOk(
                plan.target,
                'command -v dnsmasq >/dev/null 2>&1'
            )
            if (installed) {
                throw new Error(
                    `existing dnsmasq configuration is invalid: ${configTest.stderr.trim() || 'dnsmasq --test failed'}`
                )
            }
        }
        const conflict = dnsmasqConflict(
            processState.stdout,
            activeConfig.stdout,
            listeners.stdout,
            plan.buildGateway
        )
        if (conflict) throw new Error(`dnsmasq conflict: ${conflict}`)
        const slotBase = findBuildSlotBase(activeConfig.stdout, network)!
        return {
            done: true,
            note: `${plan.buildBridge} ${network.cidr}; slots ${network.prefix}.${slotBase}-${network.prefix}.${slotBase + 49}`,
            summary: [
                ['SSH target', plan.target],
                [
                    'Build bridge',
                    `${plan.buildBridge} (network.build_bridge / CF_BUILD_BRIDGE)`,
                ],
                ['Build subnet', `${network.cidr} (derived from bridge)`],
                ['Gateway', network.gateway],
                [
                    'Build slots',
                    `${network.prefix}.${slotBase}–${network.prefix}.${slotBase + 49}`,
                ],
                ['DNS resolver', plan.buildDns],
            ],
        }
    },
    apply: async () => ({ note: 'no changes needed' }),
}

export const stepVmbr1: BootstrapStep = {
    id: 'vmbr1',
    label: 'configure build NAT bridge',
    probe: async plan => {
        const network = buildNetworkFromGateway(plan.buildGateway)
        const quotedBridge = shellQuote(plan.buildBridge)
        const [configured, runtime] = await Promise.all([
            sshCapture(plan.target, `ifquery ${quotedBridge} 2>/dev/null`),
            sshCapture(
                plan.target,
                `ip -4 -o addr show dev ${quotedBridge} 2>/dev/null`
            ),
        ])
        if (configured.ok) {
            if (
                hasBuildBridgeAddress(
                    configured.stdout,
                    runtime.stdout,
                    plan.buildGateway
                )
            ) {
                return {
                    done: true,
                    note: `${plan.buildBridge} provides ${network.cidr}`,
                }
            }
            throw new Error(
                `${plan.buildBridge} changed while probing: detected ${detectedBridgeAddress(configured.stdout, runtime.stdout)}, expected ${network.bridgeAddress}`
            )
        }
        if (runtime.ok && runtime.stdout.trim() !== '') {
            throw new Error(
                `${plan.buildBridge} exists at runtime but is not managed by the node network configuration`
            )
        }
        return { done: false }
    },
    apply: async plan => {
        const network = buildNetworkFromGateway(plan.buildGateway)
        const uplink = (
            await sshCapture(plan.target, DEFAULT_ROUTE_DEV_CMD)
        ).stdout.trim()
        if (!uplink) {
            throw new Error(
                'could not find the interface carrying the default route; the build NAT needs one to leave through'
            )
        }
        // Back up before touching the file that decides whether the node comes
        // back on the network, and put it back if the bridge will not come up.
        const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14)
        const backup = `/etc/network/interfaces.cofoundry-${stamp}.bak`
        await remoteStreaming(
            plan.target,
            `cp -p /etc/network/interfaces ${shellQuote(backup)}`
        )
        await execa('ssh', [plan.target, `cat >> /etc/network/interfaces`], {
            input: bridgeStanza(plan.buildBridge, network, uplink),
            stderr: 'inherit',
        })
        try {
            await remoteStreaming(
                plan.target,
                `ifup ${shellQuote(plan.buildBridge)}`
            )
        } catch (error) {
            const restored = await remoteStreaming(
                plan.target,
                `ifdown ${shellQuote(plan.buildBridge)} >/dev/null 2>&1 || true; cp -p ${shellQuote(backup)} /etc/network/interfaces`
            ).then(
                () => true,
                () => false
            )
            const reason =
                error instanceof Error ? error.message : String(error)
            throw new Error(
                restored
                    ? `ifup ${plan.buildBridge} failed, so /etc/network/interfaces was restored from ${backup}: ${reason}`
                    : `ifup ${plan.buildBridge} failed, and restoring /etc/network/interfaces from ${backup} failed too — restore it by hand before rebooting the node: ${reason}`
            )
        }
        return {
            note: `created ${plan.buildBridge} (NAT via ${uplink}) + ifup; previous config in ${backup}`,
        }
    },
}

const BUILD_NET_FW_COMMENT = 'cofoundry build network (packer HTTP)'

// When the Proxmox firewall is enabled, the host's PVEFW-INPUT chain drops the
// build VM's connection to packer's HTTP server (preseed/kickstart fetch) on
// vmbr1 — the build then hangs at "Waiting for SSH". A pve-firewall host rule is
// the correct fix: it survives reboots AND firewall reloads, unlike a post-up
// iptables rule which pve-firewall flushes whenever it recompiles. No-op when the
// firewall is disabled (nothing to open).
export const stepBuildNetFirewall: BootstrapStep = {
    id: 'build-net-firewall',
    label: 'allow build network through Proxmox firewall',
    probe: async plan => {
        const network = buildNetworkFromGateway(plan.buildGateway)
        const status = await sshCapture(
            plan.target,
            'pve-firewall status 2>/dev/null'
        )
        if (!/enabled/i.test(status.stdout)) {
            return {
                done: true,
                note: 'Proxmox firewall disabled — no rule needed',
            }
        }
        const rules = await sshCapture(
            plan.target,
            `pvesh get /nodes/$(hostname)/firewall/rules --output-format json 2>/dev/null`
        )
        return rules.stdout.includes('cofoundry build network') &&
            rules.stdout.includes(network.cidr)
            ? { done: true, note: 'host firewall rule already present' }
            : { done: false, note: 'Proxmox firewall on — opening build net' }
    },
    apply: async plan => {
        const network = buildNetworkFromGateway(plan.buildGateway)
        await remoteStreaming(
            plan.target,
            `pvesh create /nodes/$(hostname)/firewall/rules --action ACCEPT --type in --source ${network.cidr} --enable 1 --comment ${shellQuote(BUILD_NET_FW_COMMENT)}`
        )
        return { note: `allowed ${network.cidr} in (host firewall rule)` }
    },
}

export const stepDnsmasq: BootstrapStep = {
    id: 'dnsmasq',
    label: 'install dnsmasq',
    probe: async plan =>
        (await sshOk(plan.target, 'dpkg -s dnsmasq >/dev/null 2>&1'))
            ? { done: true, note: 'dnsmasq already installed' }
            : { done: false },
    apply: async plan => {
        await remoteStreaming(plan.target, `${APT_INSTALL} dnsmasq`)
        return { note: 'installed' }
    },
}

// Per-build static reservations (.100-.149 on the build bridge's /24) are written by
// src/build/netslot.ts at build time into /etc/dnsmasq.d/cofoundry-hosts.d/.
// That directory is loaded via dhcp-hostsfile= rather than as regular config
// files, because dnsmasq only honours SIGHUP for entries loaded that way —
// `dhcp-host=` lines in /etc/dnsmasq.d/*.conf are parsed once at startup and
// never re-read, which silently breaks per-build reservations.
export const stepDnsmasqConf: BootstrapStep = {
    id: 'dnsmasq-conf',
    label: 'write /etc/dnsmasq.d/vmbr1-nat.conf',
    probe: async plan => {
        const network = buildNetworkFromGateway(plan.buildGateway)
        const [existing, otherConfig] = await Promise.all([
            sshCapture(
                plan.target,
                `cat ${shellQuote(DNSMASQ_CONF_PATH)} 2>/dev/null`
            ),
            sshCapture(plan.target, activeDnsmasqConfigCmd),
        ])
        const wanted = dnsmasqConf(
            plan.buildDns,
            otherConfig.stdout,
            plan.buildGateway,
            plan.buildBridge
        )
        if (existing.ok && existing.stdout.trim() === wanted.trim()) {
            return (await sshOk(
                plan.target,
                'systemctl is-active --quiet dnsmasq && dnsmasq --test >/dev/null 2>&1'
            ))
                ? { done: true, note: 'managed config is active and valid' }
                : { done: false, note: 'managed config needs activation' }
        }
        if (
            existing.ok &&
            !(
                existing.stdout.includes('# Managed by Cofoundry.') ||
                (existing.stdout.includes(`interface=${plan.buildBridge}`) &&
                    existing.stdout.includes(
                        `dhcp-range=${network.dhcpRangeStart},${network.dhcpRangeEnd}`
                    ))
            )
        ) {
            throw new Error(
                `${DNSMASQ_CONF_PATH} exists but is not recognizable as a Cofoundry build-network config`
            )
        }
        return {
            done: false,
            note: existing.ok ? 'managed config needs update' : undefined,
        }
    },
    apply: async plan => {
        // Hosts dir must exist before dnsmasq starts or it errors out.
        // Also sweep any legacy /etc/dnsmasq.d/cofoundry-slot-*.conf snippets
        // from the pre-dhcp-hostsfile layout so they don't linger as stale
        // static reservations.
        await remoteStreaming(
            plan.target,
            `mkdir -p ${DNSMASQ_HOSTS_DIR} && rm -f /etc/dnsmasq.d/cofoundry-slot-*.conf`
        )
        const otherConfig = await sshCapture(
            plan.target,
            activeDnsmasqConfigCmd
        )
        const candidate = `${DNSMASQ_CONF_PATH}.cofoundry-new`
        await writeRemoteFile(
            plan.target,
            candidate,
            dnsmasqConf(
                plan.buildDns,
                otherConfig.stdout,
                plan.buildGateway,
                plan.buildBridge
            )
        )
        await remoteStreaming(
            plan.target,
            `set -e
target=${shellQuote(DNSMASQ_CONF_PATH)}
candidate=${shellQuote(candidate)}
backup="${DNSMASQ_CONF_PATH}.cofoundry-backup.$$"
had_existing=0
if [ -e "$target" ]; then
    cp -a "$target" "$backup"
    had_existing=1
fi
mv "$candidate" "$target"
rollback() {
    if [ "$had_existing" -eq 1 ]; then mv "$backup" "$target"; else rm -f "$target"; fi
}
if ! dnsmasq --test; then
    rollback
    echo 'candidate dnsmasq configuration failed validation; restored previous configuration' >&2
    exit 1
fi
if ! systemctl restart dnsmasq; then
    rollback
    systemctl restart dnsmasq >/dev/null 2>&1 || true
    echo 'dnsmasq restart failed; restored previous configuration' >&2
    exit 1
fi
rm -f "$backup"`
        )
        return { note: 'validated, written, and dnsmasq restarted' }
    },
}

export const stepNetslotDir: BootstrapStep = {
    id: 'netslot-dir',
    label: 'create /var/lib/cofoundry for netslot lock',
    probe: async plan =>
        (await sshOk(plan.target, '[ -d /var/lib/cofoundry ]'))
            ? { done: true, note: 'already exists' }
            : { done: false },
    apply: async plan => {
        await remoteStreaming(plan.target, 'mkdir -p /var/lib/cofoundry')
        return { note: 'created' }
    },
}
