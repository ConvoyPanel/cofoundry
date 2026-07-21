import { describe, expect, test } from 'bun:test'
import {
    autologonScript,
    cloudInitSetCommand,
    parseDiskSize,
    sentinelHostname,
    sentinelPassword,
} from '@/verify/clone.ts'
import { summarize, formatFailures } from '@/verify/report.ts'
import type { CheckResult } from '@/verify/guest.ts'

describe('parseDiskSize', () => {
    test('reads the Proxmox size suffix', () => {
        expect(
            parseDiskSize('scsi0: local:9501/vm-9501-disk-0.qcow2,size=32G')
        ).toBe(32 * 1024 ** 3)
        expect(parseDiskSize('size=512M')).toBe(512 * 1024 ** 2)
        expect(parseDiskSize('size=1T')).toBe(1024 ** 4)
        expect(parseDiskSize('size=2048')).toBe(2048)
    })

    test('returns null rather than guessing when there is no size', () => {
        expect(
            parseDiskSize('scsi0: local:9501/vm-9501-disk-0.qcow2')
        ).toBeNull()
        expect(parseDiskSize('')).toBeNull()
    })
})

describe('sentinel values', () => {
    test('the hostname survives the Windows 15-character NetBIOS limit', () => {
        for (let i = 0; i < 50; i++) {
            const name = sentinelHostname()
            expect(name.length).toBeLessThanOrEqual(15)
            // Must also be a legal DNS label for the Linux side.
            expect(name).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/)
        }
    })

    test('the password satisfies Windows complexity every time', () => {
        // A password that fails complexity leaves the account unusable with no
        // visible error, so this must hold for every generated value.
        for (let i = 0; i < 50; i++) {
            const pw = sentinelPassword()
            expect(pw.length).toBeGreaterThanOrEqual(14)
            expect(pw).toMatch(/[A-Z]/)
            expect(pw).toMatch(/[a-z]/)
            expect(pw).toMatch(/[0-9]/)
            expect(pw).toMatch(/[!@#%^*\-_=+]/)
        }
    })

    test('values differ between runs', () => {
        expect(sentinelHostname()).not.toBe(sentinelHostname())
        expect(sentinelPassword()).not.toBe(sentinelPassword())
    })
})

describe('cloudInitSetCommand', () => {
    test('attaches every value with = so a leading-dash password stays a value', () => {
        // The sentinel password samples '-'; with `--cipassword <value>`,
        // Proxmox's Getopt CLI parses a leading-dash value as an option name
        // and rejects the command ("Unknown option: <password minus dash>").
        const cmd = cloudInitSetCommand(
            9500,
            'cfv-ab12',
            'cfverify',
            '-ci8q=#t5u7pb4qvkjl=',
            '/tmp/verify.pub'
        )
        expect(cmd).toContain("--cipassword='-ci8q=#t5u7pb4qvkjl='")
        expect(cmd).toContain("--name='cfv-ab12'")
        expect(cmd).toContain("--ciuser='cfverify'")
        expect(cmd).toContain("--sshkeys='/tmp/verify.pub'")
        expect(cmd).not.toMatch(/--(name|ciuser|cipassword|sshkeys) /)
    })
})

describe('autologonScript', () => {
    test('arms a single logon so the session is not left open', () => {
        const script = autologonScript('Administrator', 'pw')
        expect(script).toContain('AutoAdminLogon')
        expect(script).toContain('AutoLogonCount')
        expect(script).toContain('-Value 1 -Type DWord')
    })

    test('escapes quotes in the password', () => {
        expect(autologonScript('Administrator', "a'b")).toContain("'a''b'")
    })
})

describe('report', () => {
    const result = (
        id: string,
        status: CheckResult['status'],
        output = ''
    ): CheckResult => ({
        id,
        description: id,
        status,
        detail: status === 'pass' ? '' : 'exit 1',
        output,
        durationMs: 1,
    })

    test('counts each status independently', () => {
        expect(
            summarize([
                result('a', 'pass'),
                result('b', 'warn'),
                result('c', 'fail'),
                result('d', 'fail'),
            ])
        ).toEqual({ passed: 1, warned: 1, failed: 2 })
    })

    test('failures carry the guest output that explains them', () => {
        const text = formatFailures([
            result('a', 'pass', 'ignored'),
            result(
                'shell-no-crashes',
                'fail',
                'ShellHost.exe faulted\n0xc0000409'
            ),
        ])
        expect(text).toContain('shell-no-crashes')
        expect(text).toContain('0xc0000409')
        expect(text).not.toContain('ignored')
    })

    test('output is truncated so one noisy check cannot bury the rest', () => {
        const noisy = Array.from({ length: 40 }, (_, i) => `line ${i}`).join(
            '\n'
        )
        const lines = formatFailures([result('x', 'fail', noisy)]).split('\n')
        expect(lines.length).toBeLessThanOrEqual(9)
    })
})
