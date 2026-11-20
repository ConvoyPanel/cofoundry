import { describe, expect, test } from 'bun:test'
import {
    buildAttemptCount,
    isTransportFailure,
    runWithRetries,
} from '@/build/retry.ts'
import { attemptGate, type TimeBudget } from '@/build/budget.ts'

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
            { onRetry: message => messages.push(message) }
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
            { cancelSignal: abort.signal }
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
                { cancelSignal: abort.signal }
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
            { cancelSignal: abort.signal }
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
            { sleep: async () => {} }
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
            { onRetry: m => messages.push(m), sleep: async () => {} }
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
                { sleep: async () => {} }
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
                { sleep: async () => {} }
            )
        ).rejects.toThrow('non-zero exit status')
        expect(seen).toEqual([1, 2])
    })
    test('tells the re-run of an attempt that its transport dropped', async () => {
        // The re-run must follow the packer the dropped session left running,
        // not launch a second one; it can only do that if it is told.
        const seen: [number, boolean][] = []
        await runWithRetries(
            3,
            async (attempt, { afterTransportFailure }) => {
                seen.push([attempt, afterTransportFailure])
                if (seen.length === 1)
                    throw new Error('Command failed with exit code 255')
                if (seen.length === 2) throw new Error('packer exited 1')
            },
            { sleep: async () => {} }
        )
        expect(seen).toEqual([
            [1, false],
            [1, true],
            [2, false],
        ])
    })
})

describe('build time budget', () => {
    const MIN = 60_000
    const fakeBudget = (limitMinutes: number) => {
        const clock = { now: 0 }
        const budget: TimeBudget = {
            limitMs: limitMinutes * MIN,
            startedAtMs: 0,
            now: () => clock.now,
        }
        return { clock, budget }
    }

    test('refuses a retry the time left cannot cover, and says why', async () => {
        // windows-server-2022 on 2026-11-19: attempt 1 took 4h20m on a shared
        // node and failed, then GitHub cancelled attempt 2 at the job's 6h
        // limit, leaving only "The operation was canceled." in the log.
        const { clock, budget } = fakeBudget(300)
        const messages: string[] = []
        const failure = new Error(
            'Script exited with non-zero exit status: 1\nfull packer output'
        )
        let calls = 0
        const error = await runWithRetries(
            3,
            async () => {
                calls++
                clock.now += 260 * MIN
                throw failure
            },
            {
                onRetry: m => messages.push(m),
                gate: attemptGate(budget, 210 * MIN),
            }
        ).catch((e: Error) => e)
        expect(calls).toBe(1)
        expect(error.message).toBe(
            'not starting build attempt 2/3: 4h20m of the 5h00m build time budget (CF_BUILD_TIME_BUDGET_MINUTES) used, 40m left, ' +
                'and an attempt needs at least 4h20m (the longest attempt so far took that long). ' +
                "The CI job's time limit would cancel it partway, with no word of why. " +
                'Attempt 1/3 failed: Script exited with non-zero exit status: 1'
        )
        expect(error.cause).toBe(failure)
        expect(messages).not.toContain('[retry] build attempt 2/3')
    })

    test('admits retries the time left still covers', async () => {
        // windows-server-2019 in the same run: attempts of 1h41m, 1h27m and
        // 1h30m, every one of them started with time to finish.
        const { clock, budget } = fakeBudget(300)
        const minutes = [101, 87, 90]
        const seen: number[] = []
        await expect(
            runWithRetries(
                3,
                async attempt => {
                    seen.push(attempt)
                    clock.now += minutes[attempt - 1]! * MIN
                    throw new Error(`failure ${attempt}`)
                },
                { gate: attemptGate(budget, 85 * MIN) }
            )
        ).rejects.toThrow('failure 3')
        expect(seen).toEqual([1, 2, 3])
    })

    test('refuses even a first attempt when the floor no longer fits', async () => {
        const { clock, budget } = fakeBudget(300)
        clock.now = 211 * MIN
        let calls = 0
        const error = await runWithRetries(
            3,
            async () => {
                calls++
            },
            { gate: attemptGate(budget, 90 * MIN) }
        ).catch((e: Error) => e)
        expect(calls).toBe(0)
        expect(error.message).toContain('not starting build attempt 1/3')
        expect(error.message).toContain(
            "an attempt needs at least 1h30m (the recipe's attempt floor)"
        )
        expect(error.message).not.toContain('failed:')
    })

    test('the longest attempt so far sets the estimate, not the latest', async () => {
        // An attempt that fails five minutes in says nothing about how long
        // one that gets further takes.
        const { clock, budget } = fakeBudget(300)
        const minutes = [150, 5]
        let calls = 0
        const error = await runWithRetries(
            3,
            async attempt => {
                calls++
                clock.now += minutes[attempt - 1]! * MIN
                throw new Error(`failure ${attempt}`)
            },
            { gate: attemptGate(budget, 90 * MIN) }
        ).catch((e: Error) => e)
        // 2h25m left covers the floor and the latest attempt, not the longest.
        expect(calls).toBe(2)
        expect(error.message).toContain('not starting build attempt 3/3')
        expect(error.message).toContain('needs at least 2h30m')
        expect(error.message).toContain('Attempt 2/3 failed: failure 2')
    })

    test('never gates a transport re-run, which counts toward its attempt', async () => {
        const { clock, budget } = fakeBudget(300)
        const seen: [number, boolean][] = []
        const error = await runWithRetries(
            3,
            async (attempt, { afterTransportFailure }) => {
                seen.push([attempt, afterTransportFailure])
                if (!afterTransportFailure) {
                    clock.now += 250 * MIN
                    throw new Error('Command failed with exit code 255')
                }
                clock.now += 20 * MIN
                throw new Error('packer exited 1')
            },
            { gate: attemptGate(budget, 90 * MIN), sleep: async () => {} }
        ).catch((e: Error) => e)
        // Only 50m were left when the tunnel dropped, under the floor, but
        // the re-run follows a packer that is already running on the node.
        expect(seen).toEqual([
            [1, false],
            [1, true],
        ])
        // Attempt 1 ran 4h30m across both calls.
        expect(error.message).toContain('not starting build attempt 2/3')
        expect(error.message).toContain('needs at least 4h30m')
    })

    test('reports what each admitted attempt was weighed against', async () => {
        const { budget } = fakeBudget(300)
        const messages: string[] = []
        await runWithRetries(3, async () => {}, {
            onRetry: m => messages.push(m),
            gate: attemptGate(budget, 90 * MIN),
        })
        expect(messages).toEqual([
            "[budget] attempt 1/3: 0m of the 5h00m build time budget (CF_BUILD_TIME_BUDGET_MINUTES) used, 5h00m left; an attempt needs at least 1h30m (the recipe's attempt floor)",
        ])
    })
})
