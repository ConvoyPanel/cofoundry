import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { reserveScratchVmidScript, withFirmware } from '@/verify.ts'
import type { Template } from '@/registry/schema.ts'

describe('verify VMID reservation', () => {
    test('selects and records a VMID while holding the node lock', () => {
        const script = reserveScratchVmidScript('owner-id')
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(script).toContain('flock -x 9')
        expect(script).toContain('/verify-reservations/owner-id')
        expect(script).toContain('qm destroy "$stale_vmid"')
        expect(script).toContain('seq 9500 9999')
    })
})

describe('verify firmware', () => {
    const template = (bios: string): Template => ({
        schema_version: '2',
        name: 'debian-13-amd64',
        display: 'Debian 13',
        group: 'debian',
        arch: 'amd64',
        built_at: '2026-11-16T00:00:00Z',
        suggested_vmid: 4002,
        disks: [],
        hardware: { ostype: 'l26', bios, machine: 'q35' },
    })

    test('runs under the profile firmware unless asked otherwise', () => {
        const shipped = template('seabios')
        for (const asked of [undefined, 'seabios'] as const) {
            const run = withFirmware(shipped, asked, 'local')
            expect(run.template).toBe(shipped)
            expect(run.firmware).toBe('seabios')
            expect(run.extraArgs).toEqual([])
        }
    })

    test('moves a SeaBIOS template to OVMF with a fresh Secure Boot store', () => {
        const shipped = template('seabios')
        const run = withFirmware(shipped, 'ovmf', 'local-lvm')
        expect(run.firmware).toBe('ovmf')
        expect(run.template.hardware.bios).toBe('ovmf')
        expect(run.template.hardware.ostype).toBe('l26')
        // The sidecar itself is left as it shipped.
        expect(shipped.hardware.bios).toBe('seabios')
        expect(run.extraArgs).toEqual([
            '--efidisk0',
            'local-lvm:1,efitype=4m,pre-enrolled-keys=1',
        ])
    })

    test('refuses to move an OVMF template to SeaBIOS', () => {
        expect(() =>
            withFirmware(template('ovmf'), 'seabios', 'local')
        ).toThrow(/ships for OVMF/)
        expect(
            withFirmware(template('ovmf'), 'ovmf', 'local').extraArgs
        ).toEqual([])
    })
})
