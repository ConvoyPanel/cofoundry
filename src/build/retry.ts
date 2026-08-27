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
 * watch it.
 */
export const isTransportFailure = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error)
    return /exit code 255|Connection closed by|Connection (?:timed out|reset)|not responding|Broken pipe|kex_exchange_identification/i.test(
        message
    )
}

/** Reconnection waits, in ms. Long enough to outlast a DERP relay hiccup. */
const TRANSPORT_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 240_000]

export const runWithRetries = async (
    attempts: number,
    run: (attempt: number) => Promise<void>,
    onRetry?: (message: string) => void,
    cancelSignal?: AbortSignal,
    sleep: (ms: number) => Promise<void> = ms =>
        new Promise(resolve => setTimeout(resolve, ms))
): Promise<void> => {
    if (!Number.isInteger(attempts) || attempts < 1)
        throw new Error('attempts must be a positive integer')
    let lastError: unknown
    let transportRetries = 0
    for (let attempt = 1; attempt <= attempts; attempt++) {
        // An abort (the run lease was lost) throws the signal's reason — the
        // explanatory lease-lost error — so no further attempts start.
        cancelSignal?.throwIfAborted()
        try {
            if (attempt > 1)
                onRetry?.(`[retry] build attempt ${attempt}/${attempts}`)
            await run(attempt)
            return
        } catch (error) {
            // A failure caused by the abort itself (the cancelled SSH child
            // exiting) is not a build failure: surface the abort reason
            // instead and never retry an aborted run.
            cancelSignal?.throwIfAborted()
            lastError = error
            const message =
                error instanceof Error
                    ? error.message.split('\n')[0]
                    : String(error)

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
                attempt--
                continue
            }

            if (attempt < attempts) {
                onRetry?.(
                    `[retry] attempt ${attempt}/${attempts} failed: ${message}`
                )
            }
        }
    }
    throw lastError
}
