import { describe, expect, test } from 'bun:test'
import {
    applyEnvUpdates,
    CLUSTER_SIDECAR_CMD,
    formatSummaryTable,
    LEGACY_CLUSTER_UPLOAD_CMD,
} from '@/bootstrap/flow.ts'

describe('formatSummaryTable', () => {
    test('renders aligned terminal rows and borders', () => {
        const lines = formatSummaryTable([
            ['Build bridge', 'vmbr1'],
            ['Build subnet', '10.10.10.0/24'],
        ])
        expect(lines[0]).toStartWith('  ┌')
        expect(lines.at(-1)).toStartWith('  └')
        expect(lines).toContain('  │ Build bridge │ vmbr1         │')
        expect(lines).toContain('  │ Build subnet │ 10.10.10.0/24 │')
    })
})

describe('applyEnvUpdates', () => {
    test('replaces in place, appends new keys, and keeps everything else', () => {
        expect(
            applyEnvUpdates('# comment\nA=1\nB=2\n', { B: '3', C: '4' })
        ).toBe('# comment\nA=1\nB=3\nC=4\n')
    })

    test('drops a key set to null', () => {
        expect(
            applyEnvUpdates(
                `A=1\nCF_UPLOAD_CMD=${LEGACY_CLUSTER_UPLOAD_CMD}\n`,
                {
                    CF_UPLOAD_CMD: null,
                }
            )
        ).toBe('A=1\n')
    })

    test('starts an empty file cleanly', () => {
        expect(applyEnvUpdates('', { A: '1', B: null })).toBe('A=1\n')
    })
})

describe('cluster template hook', () => {
    test('hands the cluster script the sidecar, not a per-image hash', () => {
        // The script takes one argument: the sidecar, which names every image.
        expect(CLUSTER_SIDECAR_CMD).toEndWith(
            'cf-cluster-templates.sh" {{file}}'
        )
        expect(CLUSTER_SIDECAR_CMD).not.toContain('{{sha256}}')
    })
})
