import { describe, expect, test } from 'bun:test'
import {
    elideEncodedPayload,
    encodeGuestScript,
    guestExecCommand,
    parseGuestExecResult,
    runCheck,
    transportBackoffMs,
} from '@/verify/guest.ts'

describe('guest script encoding', () => {
    test('sh scripts round-trip through base64 unchanged', () => {
        const script = `printf '%s\\n' "quotes ' and \\" and | pipes"\nexit 0`
        const encoded = encodeGuestScript('sh', script)
        expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(script)
    })

    test('powershell scripts are utf16le and wrapped to force a real exit code', () => {
        const encoded = encodeGuestScript('powershell', 'Write-Output 1')
        const decoded = Buffer.from(encoded, 'base64').toString('utf16le')
        expect(decoded).toContain('Write-Output 1')
        // Without this, a non-terminating error would still exit 0 and the
        // check would report as a pass.
        expect(decoded).toContain("$ErrorActionPreference = 'Stop'")
        expect(decoded).toContain('catch {')
        expect(decoded).toContain('exit 1')
    })

    test('the encoded payload is free of characters any layer would need to quote', () => {
        const nasty = `a'b"c\\d|e;f$(g)\nh`
        for (const shell of ['sh', 'powershell'] as const) {
            expect(encodeGuestScript(shell, nasty)).toMatch(/^[A-Za-z0-9+/=]+$/)
        }
    })
})

describe('guestExecCommand', () => {
    test('sh runs the decoded payload and carries the timeout', () => {
        const cmd = guestExecCommand(9501, 'sh', 'true', 45)
        expect(cmd).toStartWith('qm guest exec 9501 --timeout 45 -- /bin/sh -c')
        expect(cmd).toContain('base64 -d | /bin/sh')
    })

    test('powershell is invoked non-interactively with no profile', () => {
        const cmd = guestExecCommand(9501, 'powershell', 'true', 60)
        expect(cmd).toContain('-NonInteractive')
        expect(cmd).toContain('-NoProfile')
        expect(cmd).toContain('-EncodedCommand')
    })
})

describe('parseGuestExecResult', () => {
    test('reads exit code and both streams', () => {
        const res = parseGuestExecResult(
            JSON.stringify({
                'exitcode': 3,
                'exited': 1,
                'out-data': 'hello\n',
                'err-data': 'oops\n',
            })
        )
        expect(res).toMatchObject({
            exitCode: 3,
            stdout: 'hello',
            stderr: 'oops',
        })
        expect(res.transportError).toBeUndefined()
    })

    test('missing streams are empty, not undefined', () => {
        const res = parseGuestExecResult(JSON.stringify({ exitcode: 0 }))
        expect(res.stdout).toBe('')
        expect(res.stderr).toBe('')
    })

    test('a missing exit code is not silently treated as success', () => {
        // An agent reply without exitcode means the command never completed;
        // reporting 0 here would turn every such case into a passing check.
        expect(
            parseGuestExecResult(JSON.stringify({ exited: 0 })).exitCode
        ).toBeNull()
    })

    test('non-JSON output is surfaced as a transport error', () => {
        const res = parseGuestExecResult('QEMU guest agent is not running')
        expect(res.exitCode).toBeNull()
        expect(res.transportError).toBeTruthy()
        expect(res.stderr).toContain('not running')
    })
})

describe('elideEncodedPayload', () => {
    test('drops the base64 script from a failed powershell command line', () => {
        const raw =
            "Command failed with exit code 255: ssh 'node' 'qm guest exec 101 " +
            "-- powershell.exe -NoProfile -EncodedCommand JABFAHIAcgBvAHIAQQBjAHQAaQBvAG4='\n" +
            "VM 101 qga command 'guest-exec' failed - got timeout"
        const out = elideEncodedPayload(raw)
        expect(out).toContain('-EncodedCommand <elided>')
        expect(out).not.toContain('JABFAHIAcgBvAHIAQQBjAHQAaQBvAG4')
        // The line that actually explains the failure must survive.
        expect(out).toContain('got timeout')
    })

    test('drops the base64 script from the sh form too', () => {
        const b64 = 'QQ'.repeat(40)
        const out = elideEncodedPayload(
            `/bin/sh -c "echo ${b64} | base64 -d | /bin/sh"`
        )
        expect(out).toContain('echo <elided> |')
        expect(out).not.toContain(b64)
    })

    test('leaves an ordinary message untouched', () => {
        const plain = 'QEMU guest agent is not running'
        expect(elideEncodedPayload(plain)).toBe(plain)
    })
})

describe('transport-error retry', () => {
    const suite = {
        shell: 'sh' as const,
        checks: [],
        screenUniformThreshold: 0.999,
        screenSeverity: 'warn' as const,
    }
    const check = {
        id: 'probe',
        description: 'probe',
        script: 'true',
        severity: 'fail' as const,
        phase: 'first-boot' as const,
    }
    const ctx = {
        hostname: 'h',
        ciUser: 'u',
        ciPassword: 'p',
        sshPublicKey: 'ssh-ed25519 AAAA c',
        minRootBytes: 1,
    }

    test('a check that never reaches the agent is retried, not failed outright', async () => {
        // Unroutable target: every attempt is a transport error.
        const started = Date.now()
        const result = await runCheck(
            'cf-invalid.invalid',
            9999,
            suite,
            check,
            ctx
        )
        expect(result.status).toBe('fail')
        expect(result.detail).toContain('guest agent')
        // Every attempt separated by its backoff, rather than one and done.
        // Asserting the full sum (not just the first gap) is what makes this a
        // regression guard: run 30868276107 lost a 3h windows-server-2025 build
        // to a retry budget that expired inside a single ~30s agent outage.
        expect(Date.now() - started).toBeGreaterThanOrEqual(
            transportBackoffMs(1) +
                transportBackoffMs(2) +
                transportBackoffMs(3)
        )
    }, 120_000)

    test('backoff grows so the budget outlasts a typical agent outage', () => {
        expect([1, 2, 3].map(transportBackoffMs)).toEqual([
            5_000, 10_000, 20_000,
        ])
        // Agent outages on a loaded node ran ~30-35s in run 30868276107.
        const total = [1, 2, 3].reduce(
            (sum, n) => sum + transportBackoffMs(n),
            0
        )
        expect(total).toBeGreaterThanOrEqual(35_000)
    })
})
