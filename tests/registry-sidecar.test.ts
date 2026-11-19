import { describe, expect, test } from 'bun:test'
import { parseSidecar } from '@/registry/schema.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const sidecar = (overrides: Record<string, unknown> = {}) => ({
    schema_version: '2',
    name: 'debian-12-amd64',
    display: 'Debian 12',
    arch: 'amd64',
    group: 'debian',
    built_at: '2026-11-16T05:00:00Z',
    disks: [{ slot: 'scsi0', role: 'system', sha256: HASH_A, size: 1 }],
    hardware: { ostype: 'l26', bios: 'seabios', machine: 'q35' },
    ...overrides,
})

const reason = (body: string): string => {
    const result = parseSidecar(body)
    expect(result.ok).toBe(false)
    return result.ok ? '' : result.reason
}

describe('parseSidecar', () => {
    test('accepts a sidecar as the export post-processor writes it', () => {
        const result = parseSidecar(JSON.stringify(sidecar()))
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.sidecar.disks[0]!.sha256).toBe(HASH_A)
    })

    test('keeps fields it does not know, so a newer cf is never "broken"', () => {
        const result = parseSidecar(
            JSON.stringify(sidecar({ added_later: { x: 1 } }))
        )
        expect(result.ok).toBe(true)
        if (result.ok)
            expect(
                (result.sidecar as unknown as Record<string, unknown>)
                    .added_later
            ).toEqual({ x: 1 })
    })

    test('accepts a system disk plus an EFI varstore', () => {
        const disks = [
            { role: 'system', sha256: HASH_A },
            { role: 'efivars', sha256: HASH_B },
        ]
        expect(parseSidecar(JSON.stringify(sidecar({ disks }))).ok).toBe(true)
    })

    test('rejects what was not generated properly, and says why', () => {
        expect(reason('{"name": "debian-12-amd64",')).toBe('not valid JSON')
        // The pre-disk-image schema had no `disks` and no schema_version 2.
        expect(
            reason(JSON.stringify(sidecar({ schema_version: undefined })))
        ).toContain('schema_version')
        expect(reason(JSON.stringify(sidecar({ name: '' })))).toContain('name')
        expect(reason(JSON.stringify(sidecar({ disks: [] })))).toContain(
            'disks'
        )
        expect(
            reason(
                JSON.stringify(
                    sidecar({ disks: [{ role: 'system', sha256: 'abc' }] })
                )
            )
        ).toContain('disks.0.sha256')
        expect(
            reason(
                JSON.stringify(
                    sidecar({ disks: [{ role: 'efivars', sha256: HASH_A }] })
                )
            )
        ).toContain('exactly one system disk')
        expect(reason('[]')).not.toBe('')
    })
})
