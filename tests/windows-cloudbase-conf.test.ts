import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Guards the cloudbase-init config that Finalize.ps1 writes for the CLONE.
//
// Three separate 2026-08-01/02 failures were the same class of mistake: that
// config is overwritten *wholesale*, so any stock setting not carried forward is
// silently dropped and only shows up ~3.5h later as a clone that cannot boot.
//
//   allow_reboot            missing -> cloudbase-init self-terminates during
//                                      specialize, ControlService 1062, exit 2
//   reset_service_password  missing -> OpenSCManager 1115 on the next call, exit 2
//   SetHostNamePlugin       present -> renames during specialize, and the pending
//                                      reboot fires mid-OOBE, leaving
//                                      SetupType=2 + OOBEInProgress=1 forever
//
// Each cost a full build to find. These assertions cost milliseconds.

const finalize = readFileSync(
    fileURLToPath(
        new URL('../recipes/_shared/windows/Finalize.ps1', import.meta.url)
    ),
    'utf8'
)

/**
 * The specialize-pass config — the one the RunSynchronous command runs with.
 *
 * Finalize writes two cloudbase-init configs from here-strings (the service one
 * and this one), so the block is selected by a field only this config carries
 * rather than by proximity to a filename. An earlier version of this helper
 * searched backwards from the filename and silently matched the wrong region,
 * which made every assertion below vacuous — a deleted key still "passed".
 */
const unattendConf = (): string => {
    const blocks = [...finalize.matchAll(/@"\r?\n([\s\S]*?)\r?\n"@/g)].map(
        m => m[1] as string
    )
    const conf = blocks.filter(b =>
        /^logfile=cloudbase-init-unattend\.log$/m.test(b)
    )
    // Exactly one block must be the unattend config; ambiguity means this guard
    // is no longer pointing where it thinks it is.
    expect(conf).toHaveLength(1)
    return conf[0] as string
}

describe('cloudbase-init specialize-pass config', () => {
    test('disables self-reboot (else it crashes stopping its own service)', () => {
        // Anchored: the config also *mentions* this key in a comment, and a
        // substring check matched that comment even with the setting deleted.
        expect(unattendConf()).toMatch(/^allow_reboot=false$/m)
    })

    test('disables the service-password reset (console run has no service)', () => {
        expect(unattendConf()).toMatch(/^reset_service_password=false$/m)
    })

    test('runs no plugin that requests a reboot during specialize', () => {
        const conf = unattendConf()
        const plugins =
            conf
                .match(/^plugins=(.*)$/m)?.[1]
                .split(',')
                .filter(Boolean) ?? []
        expect(plugins.length).toBeGreaterThan(0)

        // A reboot requested during specialize lands mid-OOBE and bricks the
        // clone. Anything that changes machine identity or storage layout wants
        // one; the post-OOBE service run is where they belong.
        const rebootRequesting = [
            'sethostname',
            'extendvolumes',
            'licensing',
            'createuser',
            'networkconfig',
        ]
        const offenders = plugins.filter(p =>
            rebootRequesting.some(bad => p.toLowerCase().includes(bad))
        )
        expect(offenders).toEqual([])
    })
})

describe('Finalize.ps1 ordering invariants', () => {
    const sysprepAt = finalize.indexOf('Write-Step "sysprep and shutdown"')

    test('nothing that can sever WinRM runs before sysprep', () => {
        expect(sysprepAt).toBeGreaterThan(-1)
        const beforeSysprep = finalize.slice(0, sysprepAt)
        // Comments are fine; executable lines are not. Both truncation bugs were
        // exactly this: a teardown step above sysprep killed packer's session and
        // the rest of the script vanished with no error.
        const dangerous = beforeSysprep
            .split('\n')
            .filter(line => !line.trimStart().startsWith('#'))
            .filter(line =>
                /Remove-NetFirewallRule|Disable-NetFirewallRule|winrm\s+set|Policies\\Microsoft\\Windows\\WinRM/i.test(
                    line
                )
            )
        expect(dangerous).toEqual([])
    })

    test('writes the completion sentinel the export gate requires', () => {
        expect(finalize).toContain('cf-finalize-complete.tag')
        // Must come after sysprep, or it proves nothing about the teardown.
        expect(finalize.indexOf('cf-finalize-complete.tag')).toBeGreaterThan(
            sysprepAt
        )
    })

    test('dumps sysprep diagnostics on a failed generalize attempt', () => {
        // 2026-08-03: two consecutive 3h04m windows-server-2025 attempts failed
        // to arm, and the error told the reader to check setuperr.log on a VM
        // packer had already deleted. Nothing survives the VM except packer's
        // stdout, so the logs have to go there.
        const loopAt = finalize.indexOf('for ($attempt = 1;')
        const gateThrowAt = finalize.indexOf('sysprep did not arm the image')
        expect(loopAt).toBeGreaterThan(-1)
        expect(gateThrowAt).toBeGreaterThan(loopAt)

        expect(finalize).toContain('function Show-SysprepDiagnostics')
        // Called from inside the retry loop, not merely after it: attempt 2
        // overwrites Panther, so a single trailing dump loses attempt 1.
        const callAt = finalize.indexOf('Show-SysprepDiagnostics $attempt')
        expect(callAt).toBeGreaterThan(loopAt)
        expect(callAt).toBeLessThan(gateThrowAt)
        expect(finalize).toContain('Sysprep\\Panther\\setuperr.log')
    })
})

/**
 * The zero pass used to run the volume to 0 bytes free and hand the space back
 * with a `-ErrorAction SilentlyContinue` delete. On 2026-08-03 finalize then
 * died with "PROVISIONER ERROR: There is not enough space on the disk", raised
 * by the *next* step and naming neither drive nor cause.
 */
describe('Zero-FreeSpace leaves the volume usable', () => {
    const body = (): string => {
        const at = finalize.indexOf('function Zero-FreeSpace')
        expect(at).toBeGreaterThan(-1)
        // Up to the next top-level function, which is enough to cover it.
        const end = finalize.indexOf('\nWrite-Step', at)
        return finalize.slice(at, end > at ? end : undefined)
    }

    test('stops on a free-space reserve rather than on disk-full', () => {
        const fn = body()
        expect(fn).toMatch(/\$reserveBytes\s*=/)
        // The write loop must have a free-space exit. Without one the only way
        // out is the IOException at 0 bytes free, which is the old behaviour.
        expect(fn).toMatch(/-le \$reserveBytes\s*\)\s*\{\s*break/)
    })

    test('fails loudly if the fill file survives', () => {
        const fn = body()
        // A silenced delete failure is indistinguishable from success, and the
        // build marches on to sysprep over a full disk.
        expect(fn).toMatch(/if \(Test-Path \$target\) \{[\s\S]*?throw/)
    })

    test('asserts free space before generalize', () => {
        const sysprepAt = finalize.indexOf('Write-Step "sysprep and shutdown"')
        const runAt = finalize.indexOf('Sysprep.exe')
        expect(runAt).toBeGreaterThan(sysprepAt)
        const preamble = finalize.slice(sysprepAt, runAt)
        expect(preamble).toMatch(/Get-PSDrive C/)
        expect(preamble).toMatch(/throw \(?"?only \{0:N1\} GB free/)
    })
})
