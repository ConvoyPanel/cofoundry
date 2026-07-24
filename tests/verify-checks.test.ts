import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckContext, GuestCheck } from '@/verify/checks/types.ts'
import { checksForPhase, renderScript } from '@/verify/checks/types.ts'
import { linuxSuite, sshKeyBody } from '@/verify/checks/linux.ts'
import { windowsSuite } from '@/verify/checks/windows.ts'
import {
    isWindowsRecipe,
    mergeChecks,
    suiteFor,
} from '@/verify/checks/index.ts'
import type { RecipeInfo } from '@/config.ts'

const ctx: CheckContext = {
    hostname: 'cfv-abc123',
    ciUser: 'cfverify',
    ciPassword: 'p\'w"d$x',
    sshPublicKey:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBody test@host',
    minRootBytes: 34_359_738_368,
    buildPassword: "bu'ild-pw",
}

const recipe = (name: string): RecipeInfo => ({
    name,
    path: `recipes/${name}.pkr.hcl`,
    display: name,
    arch: 'amd64',
})

const pwsh = spawnSync('sh', ['-c', 'command -v pwsh']).status === 0

describe('suite selection', () => {
    test('routes windows recipes to the windows suite', () => {
        expect(isWindowsRecipe('windows-server-2025')).toBe(true)
        expect(isWindowsRecipe('ubuntu-24.04')).toBe(false)
        expect(suiteFor(recipe('windows-server-2019')).shell).toBe('powershell')
        expect(suiteFor(recipe('almalinux-9')).shell).toBe('sh')
    })

    test('an override replaces the base check sharing its id', () => {
        const base: GuestCheck[] = [
            {
                id: 'a',
                description: 'a',
                script: 'true',
                severity: 'fail',
                phase: 'first-boot',
            },
            {
                id: 'b',
                description: 'b',
                script: 'true',
                severity: 'fail',
                phase: 'first-boot',
            },
        ]
        const overrides: GuestCheck[] = [
            {
                id: 'b',
                description: 'relaxed b',
                script: 'true',
                severity: 'warn',
                phase: 'first-boot',
            },
            {
                id: 'c',
                description: 'extra c',
                script: 'true',
                severity: 'fail',
                phase: 'first-boot',
            },
        ]
        const merged = mergeChecks(base, overrides)
        expect(merged.map(c => c.id)).toEqual(['a', 'b', 'c'])
        expect(merged[1]!.severity).toBe('warn')
        expect(merged[1]!.description).toBe('relaxed b')
    })
})

describe.each([
    ['linux', linuxSuite],
    ['windows', windowsSuite],
])('%s suite integrity', (_name, suite) => {
    test('check ids are unique', () => {
        const ids = suite.checks.map(c => c.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    test('every check is reachable from a phase the runner executes', () => {
        const phases = ['first-boot', 'post-reboot', 'post-logon'] as const
        const reachable = phases.flatMap(p => checksForPhase(suite, p))
        expect(reachable.length).toBe(suite.checks.length)
    })

    test('the uniformity threshold leaves room for a real screen', () => {
        expect(suite.screenUniformThreshold).toBeGreaterThan(0.9)
        expect(suite.screenUniformThreshold).toBeLessThan(1)
    })
})

describe('linux checks', () => {
    test('every script is valid POSIX shell', () => {
        for (const check of linuxSuite.checks) {
            const result = spawnSync('sh', ['-n'], {
                input: renderScript(check, ctx),
                encoding: 'utf8',
            })
            expect(result.status, `${check.id}: ${result.stderr}`).toBe(0)
        }
    })

    test('sentinel values reach the scripts that assert them', () => {
        const byId = (id: string): string =>
            renderScript(linuxSuite.checks.find(c => c.id === id)!, ctx)
        expect(byId('hostname-applied')).toContain(ctx.hostname)
        expect(byId('ci-user-exists')).toContain(ctx.ciUser)
        // disk-fully-partitioned measures the partition table, not a sentinel.
        expect(byId('disk-fully-partitioned')).toContain('lsblk')
    })

    test('key matching uses the key body, so a differing comment still matches', () => {
        const body = sshKeyBody(ctx.sshPublicKey)
        expect(body).toBe('AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyBody')
        const script = renderScript(
            linuxSuite.checks.find(c => c.id === 'no-foreign-authorized-keys')!,
            ctx
        )
        expect(script).toContain(body)
        expect(script).not.toContain('test@host')
    })

    test('byte sums survive awk formatting and 32-bit truncation', () => {
        // %.6g turns a multi-gigabyte count into 5.36556e+09, which the shell
        // then rejects with "Illegal number" — observed against a real guest.
        const script = renderScript(
            linuxSuite.checks.find(c => c.id === 'disk-fully-partitioned')!,
            ctx
        )
        // Bare print gives %.6g (5.36556e+09); mawk's %d saturates at
        // 2147483647 past 2GiB. Both observed against a real guest.
        expect(script).toContain('printf "%.0f')
        expect(script).not.toMatch(/printf "%d/)
        expect(script).not.toMatch(/END\{print s/)
    })

    test('first-boot-only checks are not repeated post-reboot', () => {
        // Host-key and machine-id regeneration are observable on the first boot
        // only; asserting them again after a reboot would always fail.
        const postReboot = checksForPhase(linuxSuite, 'post-reboot').map(
            c => c.id
        )
        expect(postReboot).not.toContain('ssh-host-keys-regenerated')
        expect(postReboot).not.toContain('machine-id-regenerated')
    })
})

describe('windows checks', () => {
    test('the gray-desktop regressions each have a dedicated check', () => {
        const ids = windowsSuite.checks.map(c => c.id)
        expect(ids).toContain('generalization-state')
        expect(ids).toContain('build-profile-removed')
        expect(ids).toContain('cloudbase-init-completed')
        expect(ids).toContain('winrm-not-exposed')
        expect(ids).toContain('shell-no-crashes')
    })

    test('the sysprep-wait hang is caught by requiring a completion marker', () => {
        // The stuck-at-sysprep clone loops "Waiting for sysprep completion"
        // forever and never reaches "Plugins execution done", so asserting the
        // completion marker catches it without grepping benign ERROR noise.
        const script = renderScript(
            windowsSuite.checks.find(c => c.id === 'cloudbase-init-completed')!,
            ctx
        )
        expect(script).toContain('Plugins execution done')
        // A genuine plugin failure is still a failure.
        expect(script).toContain("plugin '[^']+' failed with error")
    })

    test('shell health is judged after a logon, not before', () => {
        for (const id of ['shell-no-crashes', 'shell-session-present']) {
            expect(windowsSuite.checks.find(c => c.id === id)!.phase).toBe(
                'post-logon'
            )
        }
        // The build profile must be checked before a logon recreates it.
        expect(
            windowsSuite.checks.find(c => c.id === 'build-profile-removed')!
                .phase
        ).toBe('first-boot')
    })

    test('event-log queries seek by id rather than scanning by provider', () => {
        // A ProviderName filter made Get-WinEvent scan: >180s and a timeout on
        // a live Server 2025 clone, versus under 7s for the id form.
        const script = renderScript(
            windowsSuite.checks.find(c => c.id === 'shell-no-crashes')!,
            ctx
        )
        expect(script).toContain('Id = 1000,1001,1002')
        expect(script).toContain('-MaxEvents')
        expect(script).not.toContain('ProviderName')
    })

    test('disk size is read via WMI, not the wedge-prone Storage module', () => {
        // Get-Volume hung indefinitely on a live clone while every other
        // cmdlet answered in seconds.
        const script = renderScript(
            windowsSuite.checks.find(c => c.id === 'system-volume-extended')!,
            ctx
        )
        expect(script).toContain('Win32_LogicalDisk')
        expect(script).not.toContain('Get-Volume')
    })

    test('the password-leak check greps the exact value when it is known', () => {
        const check = windowsSuite.checks.find(
            c => c.id === 'no-plaintext-build-password'
        )!
        expect(renderScript(check, ctx)).toContain("bu''ild-pw")
        // Without a recovered password it falls back to a structural assertion.
        const structural = renderScript(check, {
            ...ctx,
            buildPassword: undefined,
        })
        expect(structural).toContain('AdministratorPassword')
        expect(structural).not.toContain('ild-pw')
    })

    // 30s timeout: even a single pwsh cold-start can exceed bun's 5s default on
    // a loaded CI runner (observed ~7s), which failed this step at random. One
    // invocation for the whole suite keeps the wall time well under this cap.
    test.skipIf(!pwsh)(
        'every script parses as PowerShell',
        () => {
            // One pwsh invocation for the whole suite, not one per check: pwsh
            // cold-start is ~hundreds of ms, and N of them serially blew bun's 5s
            // per-test timeout on slower CI runners, failing the step at random.
            // Each script travels as base64 so no quoting choices are needed, and
            // the parser id is echoed back on any failure so the offender is named.
            const items = windowsSuite.checks
                .map(check => {
                    const b64 = Buffer.from(
                        renderScript(check, ctx),
                        'utf8'
                    ).toString('base64')
                    return `@{id='${check.id}';b64='${b64}'}`
                })
                .join(',')
            const program = `$fail=0
foreach($it in @(${items})){
  $s=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($it.b64))
  $e=$null
  [void][System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$null,[ref]$e)
  if($e.Count){$fail=1;Write-Output ("{0}: {1}" -f $it.id, (($e | ForEach-Object { $_.Message }) -join '; '))}
}
exit $fail`
            const scriptFile = join(
                tmpdir(),
                `cf-pwsh-parse-${process.pid}.ps1`
            )
            writeFileSync(scriptFile, program)
            try {
                const result = spawnSync(
                    'pwsh',
                    ['-NoProfile', '-File', scriptFile],
                    {
                        encoding: 'utf8',
                    }
                )
                expect(result.status, result.stdout).toBe(0)
            } finally {
                rmSync(scriptFile, { force: true })
            }
        },
        30000
    )
})
