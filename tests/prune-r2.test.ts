import { describe, expect, test } from 'bun:test'
import { planR2Prune, type R2Generation, type R2Object } from '@/prune/r2.ts'

const object = (Key: string, LastModified: string): R2Object => ({
    Key,
    LastModified,
    Size: 1,
})

const generation = (
    key: string,
    lastModified: string,
    template: string,
    hashes: string[]
): R2Generation => ({ key, lastModified, template, hashes })

const PREFIX = 'templates/debian/debian-12-amd64'

describe('planR2Prune', () => {
    test('keeps the newest generations and deletes the images they drop', () => {
        const plan = planR2Prune(
            [
                object(`${PREFIX}/newsys.qcow2`, '2026-02-01'),
                object(`${PREFIX}/newsys.json`, '2026-02-01'),
                object(`${PREFIX}/oldsys.qcow2`, '2026-01-01'),
                object(`${PREFIX}/oldsys.json`, '2026-01-01'),
            ],
            [
                generation(
                    `${PREFIX}/newsys.json`,
                    '2026-02-01',
                    'debian-12-amd64',
                    ['newsys']
                ),
                generation(
                    `${PREFIX}/oldsys.json`,
                    '2026-01-01',
                    'debian-12-amd64',
                    ['oldsys']
                ),
            ],
            1
        )
        expect(plan.deletions.sort()).toEqual(
            [`${PREFIX}/oldsys.json`, `${PREFIX}/oldsys.qcow2`].sort()
        )
    })

    test('deletes every image a stale generation owned, not just one', () => {
        // The regression the old string-substitution pairing could not express:
        // a Windows template is a system disk AND a varstore, with different
        // hashes, so `key.replace(/\.vma\.zst$/, '.json')` could never find both.
        const win = 'templates/windows-server/windows-server-2025-amd64'
        const plan = planR2Prune(
            [
                object(`${win}/sysNEW.qcow2`, '2026-02-01'),
                object(`${win}/efiNEW.efivars.raw`, '2026-02-01'),
                object(`${win}/sysNEW.json`, '2026-02-01'),
                object(`${win}/sysOLD.qcow2`, '2026-01-01'),
                object(`${win}/efiOLD.efivars.raw`, '2026-01-01'),
                object(`${win}/sysOLD.json`, '2026-01-01'),
            ],
            [
                generation(
                    `${win}/sysNEW.json`,
                    '2026-02-01',
                    'windows-server-2025-amd64',
                    ['sysNEW', 'efiNEW']
                ),
                generation(
                    `${win}/sysOLD.json`,
                    '2026-01-01',
                    'windows-server-2025-amd64',
                    ['sysOLD', 'efiOLD']
                ),
            ],
            1
        )
        expect(plan.deletions.sort()).toEqual(
            [
                `${win}/sysOLD.json`,
                `${win}/sysOLD.qcow2`,
                `${win}/efiOLD.efivars.raw`,
            ].sort()
        )
    })

    test('keeps an image a live generation still shares with a stale one', () => {
        // A rebuild that produced an identical varstore: the old generation is
        // dropped, but its varstore is still referenced and must survive.
        const win = 'templates/windows-server/windows-server-2025-amd64'
        const plan = planR2Prune(
            [
                object(`${win}/sysNEW.qcow2`, '2026-02-01'),
                object(`${win}/efiSHARED.efivars.raw`, '2026-01-01'),
                object(`${win}/sysOLD.qcow2`, '2026-01-01'),
            ],
            [
                generation(
                    `${win}/sysNEW.json`,
                    '2026-02-01',
                    'windows-server-2025-amd64',
                    ['sysNEW', 'efiSHARED']
                ),
                generation(
                    `${win}/sysOLD.json`,
                    '2026-01-01',
                    'windows-server-2025-amd64',
                    ['sysOLD', 'efiSHARED']
                ),
            ],
            1
        )
        expect(plan.deletions).toContain(`${win}/sysOLD.qcow2`)
        expect(plan.deletions).not.toContain(`${win}/efiSHARED.efivars.raw`)
    })

    test('keeps templates independent of one another', () => {
        const plan = planR2Prune(
            [
                object('a/aaa.qcow2', '2026-01-01'),
                object('b/bbb.qcow2', '2026-01-01'),
            ],
            [
                generation('a/aaa.json', '2026-01-01', 'debian-12-amd64', [
                    'aaa',
                ]),
                generation('b/bbb.json', '2026-01-01', 'debian-13-amd64', [
                    'bbb',
                ]),
            ],
            1
        )
        expect(plan.deletions).toEqual([])
        expect(plan.groups).toHaveLength(2)
    })

    test('deletes images no surviving generation references', () => {
        const plan = planR2Prune(
            [object(`${PREFIX}/orphan.qcow2`, '2026-01-01')],
            [],
            1
        )
        expect(plan.orphanObjects).toEqual([`${PREFIX}/orphan.qcow2`])
    })

    test('never touches objects that are not template images', () => {
        // The prefix may hold things prune did not put there — including the
        // mirrored registry.json.
        const plan = planR2Prune(
            [
                object('templates/registry.json', '2026-01-01'),
                object('templates/notes.txt', '2026-01-01'),
            ],
            [],
            1
        )
        expect(plan.deletions).toEqual([])
    })

    test('rejects invalid keep values', () => {
        expect(() => planR2Prune([], [], -1)).toThrow('non-negative integer')
    })
})
