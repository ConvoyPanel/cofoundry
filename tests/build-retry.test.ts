import { describe, expect, test } from 'bun:test'
import {
    buildAttemptCount,
    isTransportFailure,
    runWithRetries,
} from '@/build/retry.ts'

describe('build retry policy', () => {
    test('defaults Windows to three attempts and Linux to one', () => {
        expect(buildAttemptCount(true, false)).toBe(3)
        expect(buildAttemptCount(false, false)).toBe(1)
    })

    test('keep-vm always disables retries', () => {
        expect(buildAttemptCount(true, true, '9')).toBe(1)
    })

    test('retries failures and stops after success', async () => {
        let calls = 0
        const messages: string[] = []
        await runWithRetries(
            3,
            async () => {
                calls++
                if (calls < 3) throw new Error(`failure ${calls}`)
            },
            message => messages.push(message)
        )
        expect(calls).toBe(3)
        expect(messages).toHaveLength(4)
        expect(messages.at(-1)).toContain('attempt 3/3')
    })

    test('throws the final error', async () => {
        expect(
            runWithRetries(2, async attempt => {
                throw new Error(`failure ${attempt}`)
            })
        ).rejects.toThrow('failure 2')
    })

    test('an abort mid-attempt stops retries and surfaces the abort reason', async () => {
        const abort = new AbortController()
        const reason = new Error('build run lease for debian-12 was lost')
        let calls = 0
        const promise = runWithRetries(
            3,
            async () => {
                calls++
                // Simulate the SSH child dying because the signal fired: the
                // attempt's own error must NOT win over the abort reason, and
                // no further attempts may start.
                abort.abort(reason)
                throw new Error('ssh child killed')
            },
            undefined,
            abort.signal
        )
        await expect(promise).rejects.toBe(reason)
        expect(calls).toBe(1)
    })

    test('an already-aborted signal prevents any attempt from starting', async () => {
        const abort = new AbortController()
        const reason = new Error('lease lost before the packer run started')
        abort.abort(reason)
        let calls = 0
        await expect(
            runWithRetries(
                2,
                async () => {
                    calls++
                },
                undefined,
                abort.signal
            )
        ).rejects.toBe(reason)
        expect(calls).toBe(0)
    })

    test('a signal that never aborts leaves the retry flow unchanged', async () => {
        const abort = new AbortController()
        let calls = 0
        await runWithRetries(
            2,
            async () => {
                calls++
                if (calls < 2) throw new Error('transient')
            },
            undefined,
            abort.signal
        )
        expect(calls).toBe(2)
    })
})

describe('transport failures', () => {
    const sshDrop = () =>
        new Error(
            "Command failed with exit code 255: ssh -o 'ServerAliveInterval=15' 'root@node' 'bash -s'"
        )

    test('recognizes the shapes a dropped tunnel actually produces', () => {
        // Every one of these was seen in a real build log on 2026-08-25/26.
        for (const m of [
            'Command failed with exit code 255: ssh …',
            'Connection closed by 100.109.160.64 port 22',
            'Timeout, server us-southwest-2 not responding.',
            'Connection timed out during banner exchange',
        ])
            expect(isTransportFailure(new Error(m))).toBe(true)

        // A build failure must never be mistaken for one, or a genuinely
        // broken recipe would retry until the bounded transport budget ran out.
        for (const m of [
            'Script exited with non-zero exit status: 1. Allowed exit codes are: [0]',
            'PROVISIONER ERROR: servicing still pending before sysprep',
        ])
            expect(isTransportFailure(new Error(m))).toBe(false)
    })

    test('a dropped tunnel does not consume a build attempt', async () => {
        // The bug this guards: a Windows attempt costs 1-3h, but while the
        // link is down each retry fails in milliseconds. A 2025 run burned
        // attempts 2 and 3 in seconds that way and reported a build failure.
        const seen: number[] = []
        let drops = 2
        await runWithRetries(
            2,
            async attempt => {
                seen.push(attempt)
                if (drops-- > 0) throw sshDrop()
            },
            undefined,
            undefined,
            async () => {}
        )
        // Three runs, all of attempt 1 — the budget was never touched.
        expect(seen).toEqual([1, 1, 1])
    })

    test('says the attempt was not consumed', async () => {
        const messages: string[] = []
        let first = true
        await runWithRetries(
            2,
            async () => {
                if (first) {
                    first = false
                    throw sshDrop()
                }
            },
            m => messages.push(m),
            undefined,
            async () => {}
        )
        expect(messages[0]).toContain('transport failure')
        expect(messages[0]).toContain('not consumed')
    })

    test('gives up once the transport budget is spent', async () => {
        // A node that is genuinely gone must still terminate.
        let runs = 0
        await expect(
            runWithRetries(
                1,
                async () => {
                    runs++
                    throw sshDrop()
                },
                undefined,
                undefined,
                async () => {}
            )
        ).rejects.toThrow('exit code 255')
        // 5 backoff steps + the final run that exhausts them.
        expect(runs).toBe(6)
    })

    test('a build failure still consumes attempts as before', async () => {
        const seen: number[] = []
        await expect(
            runWithRetries(
                2,
                async attempt => {
                    seen.push(attempt)
                    throw new Error(
                        'Script exited with non-zero exit status: 1'
                    )
                },
                undefined,
                undefined,
                async () => {}
            )
        ).rejects.toThrow('non-zero exit status')
        expect(seen).toEqual([1, 2])
    })
})
