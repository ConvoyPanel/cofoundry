import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// shrink-disk.sh refuses to cut a qcow2 below its last partition. The check
// reads the partition table from the first MiB of the disk; these build that
// MiB by hand.

const script = fileURLToPath(
    new URL('../recipes/_shared/post/partition-end.py', import.meta.url)
)

const gptHead = (lastSectors: number[]): Buffer => {
    const head = Buffer.alloc(1 << 20)
    head.write('EFI PART', 512, 'latin1')
    head.writeBigUInt64LE(2n, 512 + 72) // entries start at LBA 2
    head.writeUInt32LE(128, 512 + 80) // entry count
    head.writeUInt32LE(128, 512 + 84) // entry size
    lastSectors.forEach((last, i) => {
        const at = 2 * 512 + i * 128
        head.writeUInt32LE(0xdeadbeef, at) // any non-zero type GUID
        head.writeBigUInt64LE(2048n, at + 32)
        head.writeBigUInt64LE(BigInt(last), at + 40)
    })
    return head
}

const mbrHead = (start: number, count: number): Buffer => {
    const head = Buffer.alloc(1 << 20)
    head[446 + 4] = 0x83
    head.writeUInt32LE(start, 446 + 8)
    head.writeUInt32LE(count, 446 + 12)
    head[510] = 0x55
    head[511] = 0xaa
    return head
}

const check = (head: Buffer, target: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-partend-'))
    try {
        const file = join(dir, 'head')
        writeFileSync(file, head)
        return spawnSync('python3', [script, file, target], {
            encoding: 'utf8',
        })
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

describe('partition-end.py', () => {
    const gib = 1 << 30
    const sectorsIn = (bytes: number) => bytes / 512

    test('a GPT partition ending before the backup table fits', () => {
        // 32G leaves sectors up to (32G/512 - 34) for partitions.
        const last = sectorsIn(32 * gib) - 34
        expect(check(gptHead([2048 + 1000, last]), '32G').status).toBe(0)
    })

    test('a GPT partition overlapping the backup table does not', () => {
        const last = sectorsIn(32 * gib) - 33
        expect(check(gptHead([last]), '32G').status).toBe(1)
    })

    test('the latest-ending GPT entry decides, not the first', () => {
        expect(check(gptHead([5000, sectorsIn(40 * gib)]), '32G').status).toBe(
            1
        )
    })

    test('an MBR partition is checked against the full target', () => {
        const count = sectorsIn(5 * gib) - 2048
        expect(check(mbrHead(2048, count), '5G').status).toBe(0)
        expect(check(mbrHead(2048, count), '4G').status).toBe(1)
    })

    test('no partition table is its own failure, never a pass', () => {
        expect(check(Buffer.alloc(1 << 20), '32G').status).toBe(2)
    })
})
