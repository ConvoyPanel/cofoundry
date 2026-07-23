import { afterEach, describe, expect, test } from 'bun:test'
import { parseProxyCommand, resolveProxyCommand } from '@/build/sftp/proxy.ts'

// A realistic `ssh -G <host>` dump: lowercased keys, one directive per line.
const dump = (proxycommand?: string): string =>
    [
        'user root',
        'hostname 100.109.160.64',
        'port 22',
        ...(proxycommand ? [`proxycommand ${proxycommand}`] : []),
        'userknownhostsfile /home/u/.ssh/known_hosts',
    ].join('\n')

describe('parseProxyCommand', () => {
    test('returns null when the host has no ProxyCommand (the CI case)', () => {
        expect(parseProxyCommand(dump(), '10.0.0.5', 22)).toBeNull()
    })

    test('substitutes %h and %p with the connect host and port', () => {
        const out = parseProxyCommand(
            dump('nc -X 5 -x 127.0.0.1:1055 %h %p'),
            '100.109.160.64',
            22
        )
        expect(out).toBe('nc -X 5 -x 127.0.0.1:1055 100.109.160.64 22')
    })

    test('an explicit `none` clears an inherited ProxyCommand', () => {
        expect(parseProxyCommand(dump('none'), '10.0.0.5', 2222)).toBeNull()
    })

    test('%% is a literal percent, not a token', () => {
        expect(parseProxyCommand(dump('run --tag=a%%b %h'), 'node', 22)).toBe(
            'run --tag=a%b node'
        )
    })
})

describe('resolveProxyCommand override', () => {
    const original = process.env.CF_SSH_PROXYCOMMAND
    afterEach(() => {
        if (original === undefined) delete process.env.CF_SSH_PROXYCOMMAND
        else process.env.CF_SSH_PROXYCOMMAND = original
    })

    test('CF_SSH_PROXYCOMMAND overrides detection with token substitution', async () => {
        process.env.CF_SSH_PROXYCOMMAND = 'connect -S proxy:1080 %h %p'
        // A distinct host keeps this out of the module's resolution cache.
        expect(await resolveProxyCommand('override-host-a', 2200)).toBe(
            'connect -S proxy:1080 override-host-a 2200'
        )
    })

    test('CF_SSH_PROXYCOMMAND=none forces a direct connect', async () => {
        process.env.CF_SSH_PROXYCOMMAND = 'none'
        expect(await resolveProxyCommand('override-host-b', 22)).toBeNull()
    })
})
