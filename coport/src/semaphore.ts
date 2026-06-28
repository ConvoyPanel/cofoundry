// A minimal counting semaphore used to bound concurrent downloads and restores
// independently (a `coport <all>` run otherwise launches one fetch + one
// qmrestore per template all at once against a single node).
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
