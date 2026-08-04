import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
    describeGuestOutage,
    elideEncodedPayload,
    encodeGuestScript,
    guestExec,
    guestExecCommand,
    parseGuestExecResult,
    runCheck,
    transportBackoffMs,
    waitNote,
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

describe('waiting is reported as waiting, not as failure', () => {
    // The two lines below are verbatim `qm` output. They are what a rebooting
    // guest looks like from the node, and they used to reach the terminal raw —
    // a CI log where the only visible lines during a 15-minute Cloudbase-Init
    // wait read "failed" and "is not running", none of which meant anything was
    // wrong.
    const QM_TIMEOUT =
        "VM 9500 qga command 'guest-exec-status' failed - got timeout"
    const QM_NOT_RUNNING = 'QEMU guest agent is not running'

    test('qm outage wording is restated as an expected wait', () => {
        expect(describeGuestOutage(QM_NOT_RUNNING)).toEqual({
            phrase: 'guest agent down',
            expected: true,
        })
        expect(describeGuestOutage(QM_TIMEOUT)).toEqual({
            phrase: 'guest agent not answering yet',
            expected: true,
        })
        for (const raw of [QM_TIMEOUT, QM_NOT_RUNNING])
            expect(describeGuestOutage(raw).phrase).not.toMatch(
                /fail|not running/i
            )
    })

    test('a dead node is not dressed up as a guest that is coming back', () => {
        // Two ways to get this wrong at once. The transport error carries the
        // whole failed command line, which always contains `--timeout <n>`, so
        // a loose match on "timeout" calls an unreachable node a busy agent;
        // and marking it expected would attach the loop's reassurance
        // ("Cloudbase-Init reboots the guest once") to an outage that no amount
        // of waiting on the guest will fix.
        const unreachable =
            "Command failed with exit code 255: ssh host 'qm guest exec 9500 --timeout 30 -- /bin/sh'\n" +
            'ssh: Could not resolve hostname host: No address associated with hostname'
        expect(describeGuestOutage(unreachable)).toEqual({
            phrase: 'node unreachable over ssh',
            expected: false,
        })
    })

    test('every note carries elapsed time against the budget', () => {
        const note = waitNote('guest agent down', Date.now() - 80_000, 900)
        expect(note).toBe('guest agent down (1m20s of 15m00s)')
    })

    test('guest-exec stderr lands in the result, not on the terminal', async () => {
        // Unroutable target: ssh writes its diagnosis to stderr and exits 255.
        // Capturing it is what keeps the node's chatter out of the renderer's
        // output, and it is also the only way the failure explains itself —
        // with stderr inherited the error read "Command failed with exit
        // code 255" and nothing more.
        const res = await guestExec('cf-invalid.invalid', 9999, 'sh', 'true', 5)
        expect(res.transportError).toContain('Could not resolve hostname')
    }, 60_000)

    test('the guest-exec path asks for captured stderr', () => {
        // Static guard: captureRemote inherits stderr by default, so a future
        // edit that drops this option silently restores the raw noise.
        const src = readFileSync(
            fileURLToPath(new URL('../src/verify/guest.ts', import.meta.url)),
            'utf8'
        )
        expect(src).toMatch(/captureStderr:\s*true/)
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
