import { describe, expect, test } from 'bun:test'
import { buildNetworkFromGateway } from '@/build/buildnet.ts'
import { spawnSync } from 'node:child_process'
import {
    bridgeGateway,
    bridgeStanza,
    DEFAULT_ROUTE_DEV_CMD,
    buildNetworkRouteConflict,
    dnsmasqConflict,
    dnsmasqConf,
    findBuildSlotBase,
    hasBuildBridgeAddress,
} from '@/bootstrap/network.ts'

describe('buildNetworkRouteConflict', () => {
    test('detects exact and broader overlapping routes', () => {
        expect(
            buildNetworkRouteConflict(
                '10.0.0.0/24 dev vmbr0 proto kernel scope link'
            )
        ).toContain('10.0.0.0/24')
        expect(
            buildNetworkRouteConflict('10.0.0.0/8 via 192.168.1.1 dev vmbr0')
        ).toContain('10.0.0.0/8')
    })

    test('allows default, unrelated, and Cofoundry bridge routes', () => {
        const routes = [
            'default via 192.168.1.1 dev vmbr0',
            '192.168.1.0/24 dev vmbr0 proto kernel scope link',
            '10.0.0.0/24 dev vmbr1 proto kernel scope link',
        ].join('\n')
        expect(buildNetworkRouteConflict(routes)).toBeUndefined()
    })

    test('uses an adopted build subnet and bridge', () => {
        const routes = [
            '10.0.0.0/24 dev vmbr0 proto kernel scope link',
            '10.10.10.0/24 dev vmbr1 proto kernel scope link',
        ].join('\n')
        expect(
            buildNetworkRouteConflict(routes, '10.10.10.1', 'vmbr1')
        ).toBeUndefined()
    })
})

describe('hasBuildBridgeAddress', () => {
    test('accepts CIDR notation from ifquery or the live interface', () => {
        expect(
            hasBuildBridgeAddress('    address 10.0.0.1/24\n', '')
        ).toBeTrue()
        expect(
            hasBuildBridgeAddress(
                '',
                '7: vmbr1 inet 10.0.0.1/24 scope global vmbr1'
            )
        ).toBeTrue()
    })

    test('accepts address plus dotted or prefix-length netmask', () => {
        expect(
            hasBuildBridgeAddress(
                '    address 10.0.0.1\n    netmask 255.255.255.0\n',
                ''
            )
        ).toBeTrue()
        expect(
            hasBuildBridgeAddress('    address 10.0.0.1\n    netmask 24\n', '')
        ).toBeTrue()
    })

    test('rejects a different address or prefix', () => {
        expect(
            hasBuildBridgeAddress('    address 10.0.1.1/24\n', '')
        ).toBeFalse()
        expect(
            hasBuildBridgeAddress('    address 10.0.0.1/16\n', '')
        ).toBeFalse()
    })
})

describe('bridgeGateway', () => {
    test('discovers an existing /24 gateway from runtime or configuration', () => {
        expect(
            bridgeGateway('', '7: vmbr1 inet 10.10.10.1/24 scope global vmbr1')
        ).toBe('10.10.10.1')
        expect(
            bridgeGateway(
                '    address 172.20.30.1\n    netmask 255.255.255.0\n',
                ''
            )
        ).toBe('172.20.30.1')
    })
})

describe('dnsmasqConflict', () => {
    test('allows one systemd-managed instance scoped to another interface', () => {
        const config = '/etc/dnsmasq.d/lan.conf:1:interface=vmbr0'
        const listeners =
            'udp UNCONN 0 0 0.0.0.0:53 0.0.0.0:* users:(("dnsmasq",pid=1,fd=4))'
        expect(dnsmasqConflict('1|active', config, listeners)).toBeUndefined()
    })

    test('rejects multiple or unmanaged instances', () => {
        expect(dnsmasqConflict('2|active', '', '')).toContain(
            '2 dnsmasq processes'
        )
        expect(dnsmasqConflict('1|inactive', '', '')).toContain(
            'outside the system'
        )
    })

    test('rejects ranges consuming every possible build-slot block', () => {
        expect(
            dnsmasqConflict(
                '1|active',
                '/etc/dnsmasq.d/lan.conf:3:dhcp-range=10.0.0.2,10.0.0.254,12h',
                ''
            )
        ).toContain('no contiguous 50-address')
    })

    test('allows compatible vmbr1 and build-range directives', () => {
        const config = [
            '/etc/dnsmasq.d/vmbr1.conf:1:interface=vmbr1',
            '/etc/dnsmasq.d/vmbr1.conf:2:dhcp-range=10.0.0.200,10.0.0.250,12h',
        ].join('\n')
        expect(dnsmasqConflict('1|active', config, '')).toBeUndefined()
    })

    test('allows another non-overlapping range on the build subnet', () => {
        const config = [
            '/etc/dnsmasq.d/vmbr1.conf:1:interface=vmbr1',
            '/etc/dnsmasq.d/vmbr1.conf:2:dhcp-range=10.0.0.20,10.0.0.80,12h',
        ].join('\n')
        expect(dnsmasqConflict('1|active', config, '')).toBeUndefined()
    })

    test('rejects an unscoped existing configuration', () => {
        expect(
            dnsmasqConflict(
                '1|active',
                '/etc/dnsmasq.d/lan.conf:1:server=1.1.1.1',
                ''
            )
        ).toContain('not scoped')
    })

    test('rejects an existing default daemon listening on all interfaces', () => {
        const listeners =
            'udp UNCONN 0 0 0.0.0.0:53 0.0.0.0:* users:(("dnsmasq",pid=1,fd=4))'
        expect(dnsmasqConflict('1|active', '', listeners)).toContain(
            'listens on all interfaces'
        )
    })

    test('rejects another wildcard DNS or DHCP listener', () => {
        const listeners =
            'tcp LISTEN 0 4096 0.0.0.0:53 0.0.0.0:* users:(("named",pid=2,fd=5))'
        expect(dnsmasqConflict('0|inactive', '', listeners)).toContain(
            'another service'
        )
    })
})

describe('findBuildSlotBase', () => {
    const network = buildNetworkFromGateway('10.10.10.1')

    test('prefers .100 when the existing pool does not overlap it', () => {
        const config =
            '/etc/dnsmasq.d/vmbr1.conf:2:dhcp-range=10.10.10.200,10.10.10.250,12h'
        expect(findBuildSlotBase(config, network)).toBe(100)
    })

    test('moves the slot block around an existing DHCP pool', () => {
        const config =
            '/etc/dnsmasq.d/vmbr1.conf:2:dhcp-range=10.10.10.100,10.10.10.200,12h'
        expect(findBuildSlotBase(config, network)).toBe(2)
    })
})

describe('dnsmasqConf', () => {
    test('writes only directives missing from a compatible alternate file', () => {
        const config = [
            '/etc/dnsmasq.d/vmbr1.conf:1:interface=vmbr1',
            '/etc/dnsmasq.d/vmbr1.conf:2:bind-interfaces',
            '/etc/dnsmasq.d/vmbr1.conf:3:dhcp-range=10.0.0.200,10.0.0.250,12h',
            '/etc/dnsmasq.d/vmbr1.conf:4:dhcp-option=3,10.0.0.1',
            '/etc/dnsmasq.d/vmbr1.conf:5:dhcp-option=6,8.8.8.8',
        ].join('\n')
        expect(dnsmasqConf('1.1.1.1', config)).toBe(
            '# Managed by Cofoundry.\n' +
                'dhcp-hostsfile=/etc/dnsmasq.d/cofoundry-hosts.d\n'
        )
    })

    test('fills in the build network when only vmbr1 already exists', () => {
        const config = '/etc/dnsmasq.d/vmbr1.conf:1:interface=vmbr1'
        const generated = dnsmasqConf('1.1.1.1', config)
        expect(generated).not.toContain('\ninterface=vmbr1\n')
        expect(generated).toContain('dhcp-range=10.0.0.200,10.0.0.250,12h')
        expect(generated).toContain('dhcp-option=6,1.1.1.1')
        expect(generated).toContain(
            'dhcp-hostsfile=/etc/dnsmasq.d/cofoundry-hosts.d'
        )
    })

    test('derives DHCP settings from an adopted bridge gateway', () => {
        const generated = dnsmasqConf(
            '1.1.1.1',
            '/etc/dnsmasq.d/vmbr1.conf:1:interface=vmbr1',
            '10.10.10.1',
            'vmbr1'
        )
        expect(generated).toContain('dhcp-range=10.10.10.200,10.10.10.250,12h')
        expect(generated).toContain('dhcp-option=option:router,10.10.10.1')
    })
})

describe('bridgeStanza', () => {
    const network = buildNetworkFromGateway('10.0.0.1')

    test('NATs out of the detected uplink, not a hard-coded vmbr0', () => {
        const stanza = bridgeStanza('vmbr1', network, 'vmbr2')
        expect(stanza).toContain('-o vmbr2 -j MASQUERADE')
        expect(stanza).not.toContain('vmbr0')
    })

    test('checks for the NAT rule before appending it', () => {
        // post-up re-runs on every `ifreload -a`; a bare -A stacks duplicates.
        const postUp = bridgeStanza('vmbr1', network, 'vmbr0')
            .split('\n')
            .find(
                line => line.includes('MASQUERADE') && line.includes('post-up')
            )
        expect(postUp).toMatch(/iptables -t nat -C .* \|\| iptables -t nat -A /)
    })
})

describe('DEFAULT_ROUTE_DEV_CMD', () => {
    const uplinkOf = (routes: string): string =>
        spawnSync(
            'bash',
            [
                '-c',
                DEFAULT_ROUTE_DEV_CMD.replace(
                    'ip -4 route show default',
                    'cat'
                ),
            ],
            { input: routes, encoding: 'utf8' }
        ).stdout.trim()

    test('reads the device off the default route', () => {
        expect(
            uplinkOf('default via 192.168.1.1 dev vmbr2 proto kernel onlink\n')
        ).toBe('vmbr2')
    })

    test('takes the first default route when there are several', () => {
        expect(
            uplinkOf(
                'default via 192.168.1.1 dev bond0 metric 100\ndefault via 10.1.1.1 dev vmbr9 metric 200\n'
            )
        ).toBe('bond0')
    })

    test('prints nothing when there is no default route', () => {
        expect(uplinkOf('')).toBe('')
    })
})
