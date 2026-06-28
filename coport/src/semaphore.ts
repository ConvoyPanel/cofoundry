// A minimal counting semaphore used to bound concurrent downloads and restores
// independently (a `coport <all>` run otherwise launches one fetch + one
// qmrestore per template all at once against a single node).
//
// Race-free because JS is single-threaded with no preemption: the
// check-and-decrement below runs to completion before any other `run` call can
// observe `available`, so the count can never be double-spent. On release we
// hand the slot *directly* to the next waiter (resume without incrementing)
// rather than bumping the count and racing a fresh caller for it — so the number
// of in-flight `fn`s never exceeds the initial permit count.
export class Semaphore {
    private readonly waiters: Array<() => void> = []
    constructor(private available: number) {}
    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.available > 0) {
            this.available--
        } else {
            await new Promise<void>(r => this.waiters.push(r))
        }
        try {
            return await fn()
        } finally {
            const next = this.waiters.shift()
            if (next) next()
            else this.available++
        }
    }
}
