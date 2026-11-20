export const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

/**
 * A wall-clock span to the minute, as `4h20m` or `39m`. For spans measured in
 * hours, where seconds are noise; negative spans read as `0m`.
 */
export const formatMinutes = (ms: number): string => {
    const minutes = Math.max(0, Math.round(ms / 60_000))
    const hours = Math.floor(minutes / 60)
    return hours > 0
        ? `${hours}h${String(minutes % 60).padStart(2, '0')}m`
        : `${minutes}m`
}

const delay = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms))

export interface FetchRetryOptions extends RequestInit {
    // Abort a single attempt after this many ms (default 30s). Without this a
    // stalled mirror hangs the process forever, since fetch has no timeout.
    timeoutMs?: number
    // Number of retries after the first attempt (default 2).
    retries?: number
    // Base backoff between attempts; grows linearly per attempt (default 500ms).
    retryDelayMs?: number
}

// fetch with a per-attempt timeout and bounded retries on transient failures
// (network errors, request timeouts, and 5xx / 429 responses). Non-transient
// responses (including 4xx) are returned to the caller as-is; only exhausting
// every attempt throws.
export const fetchWithRetry = async (
    url: string,
    options: FetchRetryOptions = {}
): Promise<Response> => {
    const {
        timeoutMs = 30_000,
        retries = 2,
        retryDelayMs = 500,
        ...init
    } = options
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                ...init,
                signal: AbortSignal.timeout(timeoutMs),
            })
            if (res.status < 500 && res.status !== 429) return res
            lastError = new Error(`HTTP ${res.status}`)
        } catch (error) {
            lastError = error
        }
        if (attempt < retries) await delay(retryDelayMs * (attempt + 1))
    }
    const reason =
        lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(
        `fetch ${url} failed after ${retries + 1} attempts: ${reason}`
    )
}

const sensitiveValues = new Set<string>()

export const addSensitiveValues = (...values: (string | undefined)[]): void => {
    for (const v of values) {
        if (v && v.length >= 4) sensitiveValues.add(v)
    }
}

export const redactSensitive = (msg: string): string => {
    let result = msg
    for (const v of sensitiveValues) result = result.replaceAll(v, '[REDACTED]')
    return result
}
