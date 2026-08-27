import { mkdir, readdir, rm } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const TEMP_ROOT = '/var/lib/vz/dump/coport-tmp'
const MAX_RETRIES = 3
let tempDir: string | undefined

export interface DownloadProgress {
    pct: number
    received: number
    total: number
}

/**
 * Where a downloaded image lands. `qm create --import-from` takes an absolute
 * path as readily as a storage volid (PVE::API2::Qemu falls through to
 * check_volume_access for non-volids), so images can stay in this temp dir and
 * never need an `import`-content storage configured on the node.
 *
 * The name is the artifact's published, content-addressed filename, so two
 * templates downloading concurrently cannot collide.
 */
export const tempPath = (filename: string): string =>
    join(tempDir ?? TEMP_ROOT, filename)

export const ensureTempDir = async (): Promise<void> => {
    tempDir = join(TEMP_ROOT, `${process.pid}-${Date.now()}`)
    await mkdir(tempDir, { recursive: true })
}

export const cleanupTempDir = async (): Promise<void> => {
    if (!tempDir) return
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
}

export const removeTempFile = async (filePath: string): Promise<void> => {
    await rm(filePath, { force: true })
}

export const sweepStaleTempDirs = async (): Promise<void> => {
    let entries: string[]
    try {
        entries = await readdir(TEMP_ROOT)
    } catch {
        return
    }
    await Promise.all(
        entries.map(async name => {
            const match = name.match(/^(\d+)-\d+$/)
            if (!match) return
            const pid = Number(match[1])
            if (pidAlive(pid)) return
            await rm(join(TEMP_ROOT, name), {
                recursive: true,
                force: true,
            }).catch(() => {})
        })
    )
}

const pidAlive = (pid: number): boolean => {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

export const cleanupTempDirSync = (): void => {
    if (!tempDir) return
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined
}

const sleep = (ms: number): Promise<void> =>
    new Promise(resolve => setTimeout(resolve, ms))

export const downloadWithRetry = async (
    url: string,
    destPath: string,
    onProgress?: (progress: DownloadProgress) => void,
    signal?: AbortSignal
): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await download(url, destPath, onProgress, signal)
            return
        } catch (err) {
            if (signal?.aborted) throw err
            if (attempt === MAX_RETRIES) throw err
            await sleep(1000 * 2 ** (attempt - 1))
        }
    }
}

const download = async (
    url: string,
    destPath: string,
    onProgress?: (progress: DownloadProgress) => void,
    signal?: AbortSignal
): Promise<void> => {
    const res = await fetch(url, { signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)

    const total = Number(res.headers.get('content-length') ?? 0)
    const file = Bun.file(destPath)
    const writer = file.writer()

    let received = 0
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        if (signal?.aborted) throw new Error('Aborted')
        writer.write(chunk)
        received += chunk.byteLength
        if (onProgress) {
            onProgress({
                pct: total > 0 ? Math.round((received / total) * 100) : 0,
                received,
                total,
            })
        }
    }
    await writer.end()
}

export const verifySha256 = async (
    filePath: string,
    expected: string
): Promise<void> => {
    const hash = createHash('sha256')
    const stream = Bun.file(filePath).stream()
    for await (const chunk of stream) {
        hash.update(chunk)
    }
    const actual = hash.digest('hex')
    if (actual !== expected) {
        throw new Error(`SHA-256 mismatch: expected ${expected}, got ${actual}`)
    }
}
