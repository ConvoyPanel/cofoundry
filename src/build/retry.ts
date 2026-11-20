import type { AttemptGate } from '@/build/budget.ts'

export const buildAttemptCount = (
    isWindows: boolean,
    keepVm: boolean,
    configured?: string | number
): number => {
    if (keepVm) return 1
    const parsed = Number.parseInt(
        String(configured ?? (isWindows ? '3' : '1')),
        10
    )
    return Math.max(1, parsed || 1)
}

/**
 * A failure of the SSH transport rather than of the build.
 *
 * These are not equivalent and must not consume the same budget. A Windows
 * build attempt costs 1-3 hours; the tunnel to the node can drop in
 * milliseconds and, while it is down, every retry fails instantly with the same
 * error. Observed twice on 2026-08-25/26: a windows-server-2025 run lost its
 * session 3h22m in and burned attempts 2 and 3 in seconds against a dead
 * connection, and a windows-server-2022 attempt went the same way.
 *
 * The build itself is unaffected — packer runs ON the node, so the work
 * survives the launcher losing its terminal. What is lost is cf's ability to
 * watch it, which is why the re-run is told it follows a transport failure
 * (`AttemptContext.afterTransportFailure`): it must pick the surviving packer
 * back up, not start a second one against the same VM.
 */
export const isTransportFailure = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error)
    return /exit code 255|Connection closed by|Connection (?:timed out|reset)|not responding|Broken pipe|kex_exchange_identification/i.test(
        message
    )
}

/** Reconnection waits, in ms. Long enough to outlast a DERP relay hiccup. */
const TRANSPORT_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 240_000]

export type AttemptContext = {
    /**
     * True when this call re-runs the same attempt because the previous call
     * lost its SSH transport. Whatever that call started on the node may still
     * be running.
     */
    afterTransportFailure: boolean
}

export type RetryOptions = {
    /** Progress lines: retries, transport waits, budget decisions. */
    onRetry?: (message: string) => void
    /** Aborts the run; its reason is rethrown instead of the attempt's error. */
    cancelSignal?: AbortSignal
    sleep?: (ms: number) => Promise<void>
    /**
     * Consulted before each new attempt, never before re-running one after a
     * transport failure: that work is already running on the node. A refusal
     * ends the run with the gate's reason and the last attempt's failure.
     */
    gate?: AttemptGate
}

const firstLine = (error: unknown): string =>
    error instanceof Error
        ? (error.message.split('\n')[0] ?? '')
        : String(error)

export const runWithRetries = async (
    attempts: number,
    run: (attempt: number, context: AttemptContext) => Promise<void>,
    {
        onRetry,
        cancelSignal,
        sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
        gate,
    }: RetryOptions = {}
): Promise<void> => {
    if (!Number.isInteger(attempts) || attempts < 1)
        throw new Error('attempts must be a positive integer')
    let lastError: unknown
    let transportRetries = 0
    let afterTransportFailure = false
    for (let attempt = 1; attempt <= attempts; attempt++) {
        // An abort (the run lease was lost) throws the signal's reason — the
        // explanatory lease-lost error — so no further attempts start.
        cancelSignal?.throwIfAborted()
        if (gate && !afterTransportFailure) {
            const verdict = gate.check(attempt, attempts)
            if (!verdict.ok) {
                // Thrown outside the try below, so it is never retried.
                throw new Error(
                    attempt > 1
                        ? `${verdict.reason} Attempt ${attempt - 1}/${attempts} failed: ${firstLine(lastError)}`
                        : verdict.reason,
                    { cause: lastError }
                )
            }
            onRetry?.(verdict.status)
        }
        try {
            if (attempt > 1 && !afterTransportFailure)
                onRetry?.(`[retry] build attempt ${attempt}/${attempts}`)
            await run(attempt, { afterTransportFailure })
            return
        } catch (error) {
            // A failure caused by the abort itself (the cancelled SSH child
            // exiting) is not a build failure: surface the abort reason
            // instead and never retry an aborted run.
            cancelSignal?.throwIfAborted()
            lastError = error
            const message = firstLine(error)

            // A dropped tunnel says nothing about the build, so it must not
            // spend an attempt. Back off to let the link return, then re-run
            // the SAME attempt number. Bounded, so a node that is genuinely
            // gone still terminates instead of retrying forever.
            if (
                isTransportFailure(error) &&
                transportRetries < TRANSPORT_BACKOFF_MS.length
            ) {
                const waitMs = TRANSPORT_BACKOFF_MS[transportRetries]!
                transportRetries++
                onRetry?.(
                    `[retry] transport failure (${message}) — waiting ${Math.round(waitMs / 1000)}s for the connection, attempt ${attempt}/${attempts} not consumed`
                )
                await sleep(waitMs)
                cancelSignal?.throwIfAborted()
                afterTransportFailure = true
                attempt--
                continue
            }
            afterTransportFailure = false
            gate?.failed()

            if (attempt < attempts) {
                onRetry?.(
                    `[retry] attempt ${attempt}/${attempts} failed: ${message}`
                )
            }
        }
    }
    throw lastError
}
