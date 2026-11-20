import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import {
    buildLeaseAdmissionScript,
    describeLeaseHolder,
    evaluateHeartbeat,
    HEARTBEAT_GONE_EXIT,
    HEARTBEAT_LOST_AFTER_FAILURES,
    killLeasedRunProcessesCommand,
    leaseUsageScript,
    OWNED_VMID_DIR,
    parseAdmission,
    RUN_LEASE_DIR,
    runLeaseHeartbeatCommand,
    reapLeasesByPrefixScript,
    runLeaseId,
    RUN_LEASE_STALE_SECS,
    sweepRunLeasesScript,
    updateLeaseVmidScript,
} from '@/build/lease.ts'
import { PACKER_TMP_ROOT } from '@/build/packer.ts'
import { leaseWaitExhausted, type TimeBudget } from '@/build/budget.ts'

const recipe = {
    name: 'debian-12',
    buildMemoryMb: 2048,
    buildCores: 2,
} as RecipeInfo

describe('node-wide run leases', () => {
    test('renders valid admission shell with resource and recipe gates', () => {
        const script = buildLeaseAdmissionScript(
            {
                CF_BUILD_MEMORY_BUDGET_MB: 8192,
                CF_BUILD_CPU_BUDGET: 4,
            } as Env,
            {
                id: 'run-id',
                kind: 'build',
                recipe,
                remoteTmpDir: '/dump/cofoundry-tmp/build-debian-12-run-id',
                packerTmpDir: `${PACKER_TMP_ROOT}/run-id`,
                preserveVm: false,
                storage: 'local',
            }
        )
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(script).toContain('flock -x 9')
        expect(script).toContain('same_recipe=1')
        expect(script).toContain('memory_budget=8192')
        expect(script).toContain('cpu_budget=4')
        expect(script).toContain(`${PACKER_TMP_ROOT}/run-id`)
        // A run that has to wait is told who holds its recipe's lease.
        expect(script).toContain(leaseUsageScript('debian-12'))
        expect(script).toMatch(/echo "WAIT .* \$same_recipe \$holder"/)
    })

    test('stale cleanup is scoped to resources named by a lease', () => {
        const script = sweepRunLeasesScript()
        expect(script).toContain(RUN_LEASE_DIR)
        expect(script).toContain('qm destroy "$vmid"')
        expect(script).toContain('*/cofoundry-tmp/build-*')
        expect(script).toContain(`${PACKER_TMP_ROOT}/*`)
        expect(script).toContain('rm -rf -- "$packer_tmpdir"')
        expect(script).not.toContain('qm list')
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })

    test('records VMID ownership for later telemetry cleanup', () => {
        const script = updateLeaseVmidScript(
            {
                id: 'run-id',
                kind: 'build',
                recipe,
                remoteTmpDir: '/dump/cofoundry-tmp/build-debian-12-run-id',
                packerTmpDir: `${PACKER_TMP_ROOT}/run-id`,
                preserveVm: false,
                storage: 'local',
            },
            400100
        )
        expect(script).toContain(`${OWNED_VMID_DIR}/400100`)
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })
})

const withTempDir = (fn: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'cf-lease-'))
    try {
        // Forward slashes so Git Bash accepts the path on Windows too.
        fn(dir.replaceAll('\\', '/'))
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
}

describe('run-lease heartbeat lost detection', () => {
    test('heartbeat touches an existing lease file and exits 0', () => {
        withTempDir(dir => {
            const file = `${dir}/lease`
            writeFileSync(file, 'build\tdebian-12\t0\n')
            const cmd = runLeaseHeartbeatCommand(file)
            const syntax = spawnSync('bash', ['-n'], {
                input: cmd,
                encoding: 'utf8',
            })
            expect(syntax.status, syntax.stderr).toBe(0)
            const result = spawnSync('bash', ['-c', cmd], { encoding: 'utf8' })
            expect(result.status, result.stderr).toBe(0)
        })
    })

    test('heartbeat reports a reaped lease with a distinct exit code', () => {
        withTempDir(dir => {
            const result = spawnSync(
                'bash',
                ['-c', runLeaseHeartbeatCommand(`${dir}/gone`)],
                { encoding: 'utf8' }
            )
            expect(result.status).toBe(HEARTBEAT_GONE_EXIT)
            // Must stay distinguishable from ssh's transport-failure status.
            expect(HEARTBEAT_GONE_EXIT).not.toBe(255)
        })
    })

    test('a successful heartbeat resets the consecutive-failure count', () => {
        const state = { failures: 0 }
        expect(evaluateHeartbeat(state, 255)).toBe('failing')
        expect(state.failures).toBe(1)
        expect(evaluateHeartbeat(state, 0)).toBe('alive')
        expect(state.failures).toBe(0)
    })

    test('a confirmed-missing lease file is lost immediately', () => {
        const state = { failures: 0 }
        expect(evaluateHeartbeat(state, HEARTBEAT_GONE_EXIT)).toBe('gone')
    })

    test('an unreachable node loses the lease only past the stale window', () => {
        const state = { failures: 0 }
        for (let i = 1; i < HEARTBEAT_LOST_AFTER_FAILURES; i++) {
            expect(evaluateHeartbeat(state, 255)).toBe('failing')
        }
        expect(evaluateHeartbeat(state, 255)).toBe('lost')
        expect(state.failures).toBe(HEARTBEAT_LOST_AFTER_FAILURES)
    })
})

describe('killLeasedRunProcessesCommand', () => {
    const tmpDir = '/dump/cofoundry-tmp/build-debian-12-abc'

    test('mirrors the sweep: kill by the run temp directory, force -9', () => {
        const cmd = killLeasedRunProcessesCommand(tmpDir)
        expect(cmd).toContain(
            "pkill -9 -f -- '/[d]ump/cofoundry-tmp/build-debian-12-abc'"
        )
        // The stale-lease sweep must keep using the same reap pattern, so a
        // local abort leaves the node exactly as a sweep would.
        expect(sweepRunLeasesScript()).toContain('pkill -9 -f -- "$tmpdir"')
        const syntax = spawnSync('bash', ['-n'], {
            input: cmd,
            encoding: 'utf8',
        })
        expect(syntax.status, syntax.stderr).toBe(0)
    })

    test('the pattern matches the run but never its own command line', () => {
        const cmd = killLeasedRunProcessesCommand(tmpDir)
        const quoted = /'([^']+)'/.exec(cmd)
        expect(quoted).not.toBeNull()
        const pattern = new RegExp(quoted![1]!)
        // Matches a real packer/tail argv that names the run directory...
        expect(
            pattern.test(`packer build -var-file ${tmpDir}/repo/v.json`)
        ).toBe(true)
        // ...but not the shell that carries the kill command itself, which
        // pkill -9 would otherwise terminate mid-flight.
        expect(pattern.test(`bash -c ${cmd}`)).toBe(false)
    })

    test('exits 0 when nothing matched (the sweep already killed the run)', () => {
        // pkill returns non-zero on no match — and may be missing entirely on
        // dev machines — so the command must still succeed either way.
        const result = spawnSync(
            'bash',
            ['-c', killLeasedRunProcessesCommand('/nonexistent/cf-tmp-none')],
            { encoding: 'utf8' }
        )
        expect(result.status, result.stderr).toBe(0)
    })
})

describe('run-targeted lease reap', () => {
    test('selects by prefix and, unlike the sweep, applies no age gate', () => {
        const script = reapLeasesByPrefixScript('12345-1')
        // The directory is quoted; the prefix and glob deliberately are not, so
        // the shell still expands the match.
        expect(script).toContain(`'${RUN_LEASE_DIR}'/12345-1*`)
        // The whole point: a lease seconds old must still be reaped, because
        // the run that owned it is known dead.
        expect(script).not.toContain('stat -c %Y')
        expect(script).not.toContain(String(RUN_LEASE_STALE_SECS))
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })

    test('frees exactly what the age-gated sweep frees', () => {
        // Both paths share one reap body, so a resource can never be released
        // by one and leaked by the other.
        const targeted = reapLeasesByPrefixScript('12345-1')
        for (const fragment of [
            'qm destroy "$vmid"',
            'pkill -9 -f -- "$tmpdir"',
            'rm -rf -- "$packer_tmpdir"',
            'rm -f -- "$lease"',
            '*/cofoundry-verify-*',
        ]) {
            expect(targeted).toContain(fragment)
            expect(sweepRunLeasesScript()).toContain(fragment)
        }
    })

    test('rejects a prefix that would widen the match or escape the directory', () => {
        // `*` would reap every live build on the node, age gate and all.
        for (const bad of ['*', '', '../../etc', 'run id', 'a/b', '12345*']) {
            expect(() => reapLeasesByPrefixScript(bad)).toThrow(
                /unsafe lease prefix/
            )
        }
    })
})

describe('runLeaseId', () => {
    test('is derivable from the CI run alone, without the build reporting it', () => {
        // A cancelled job is killed with no grace period, so the cleanup job can
        // only find the lease if it can compute the same id independently.
        expect(runLeaseId('12345-1', 'build', 'debian-12')).toBe(
            '12345-1-build-debian-12'
        )
        expect(runLeaseId('12345-1', 'verify', 'debian-12')).toBe(
            '12345-1-verify-debian-12'
        )
    })

    test('build and verify of one recipe share the run prefix but not the id', () => {
        const build = runLeaseId('12345-1', 'build', 'debian-12')
        const verify = runLeaseId('12345-1', 'verify', 'debian-12')
        expect(build).not.toBe(verify)
        expect(build.startsWith('12345-1')).toBe(true)
        expect(verify.startsWith('12345-1')).toBe(true)
        // One reap therefore clears both.
        expect(reapLeasesByPrefixScript('12345-1')).toContain('12345-1*')
    })

    test('falls back to a random id outside CI', () => {
        const a = runLeaseId(undefined, 'build', 'debian-12')
        expect(a).not.toBe(runLeaseId(undefined, 'build', 'debian-12'))
        expect(a).toMatch(/^[0-9a-f-]{36}$/)
    })

    test('sanitizes ids so they stay inert as a filename and a glob', () => {
        const id = runLeaseId('12345/../x *', 'build', 'ubuntu 24.04')
        expect(id).not.toMatch(/[/*\s]/)
        // Must survive the prefix validator it will later be matched by.
        expect(() => reapLeasesByPrefixScript(id)).not.toThrow()
    })
})

describe('who holds a recipe lease', () => {
    const record = (recipeName: string, vmid: string, memory: number) =>
        [
            'build',
            recipeName,
            vmid,
            memory,
            memory / 2048,
            `/dump/cofoundry-tmp/build-${recipeName}-x`,
            0,
            'local',
            `${PACKER_TMP_ROOT}/x`,
        ].join('\t') + '\n'

    // Run as the admission script runs it, so an unset variable or a failed
    // test inside it would abort here exactly as it would on the node.
    const usage = (dir: string, recipeName: string) => {
        const result = spawnSync(
            'bash',
            [
                '-c',
                `set -euo pipefail\n${leaseUsageScript(recipeName, dir)}\n` +
                    'echo "$memory_used|$cpu_used|$same_recipe|$holder"',
            ],
            { encoding: 'utf8' }
        )
        expect(result.status, result.stderr).toBe(0)
        // bash 3.2 (macOS) carries on past an arithmetic error under -e, so
        // only stderr shows that one happened.
        expect(result.stderr).toBe('')
        const [memory, cpu, same, holder] = result.stdout.trim().split('|')
        return { memory, cpu, same, holder: holder!.split(' ') }
    }

    test('totals every lease and names the one holding the recipe', () => {
        withTempDir(dir => {
            const id = '44623195255-1-build-windows-server-2025'
            writeFileSync(
                `${dir}/${id}`,
                record('windows-server-2025', '200201', 8192)
            )
            writeFileSync(
                `${dir}/0b6c9e1e-2f43-4c1d-9a51-1d2f5d8c7e10`,
                record('debian-12', '400100', 2048)
            )
            const { memory, cpu, same, holder } = usage(
                dir,
                'windows-server-2025'
            )
            expect([memory, cpu, same]).toEqual(['10240', '5', '1'])
            const [holderId, kind, vmid, held] = holder
            expect([holderId, kind, vmid]).toEqual([id, 'build', '200201'])
            // Seconds since the file was born, or -1 where the filesystem or
            // a non-GNU stat (macOS) does not report a birth time.
            expect(Number(held)).toBeGreaterThanOrEqual(-1)
            expect(Number(held)).toBeLessThan(60)
        })
    })

    test('names no holder when no lease is for the recipe', () => {
        withTempDir(dir => {
            writeFileSync(
                `${dir}/some-run-build-debian-12`,
                record('debian-12', '400100', 2048)
            )
            const { same, holder } = usage(dir, 'windows-server-2025')
            expect(same).toBe('0')
            expect(holder).toEqual(['-', '-', '0', '-1'])
        })
    })

    test('a lease that has not recorded its VMID yet holds VMID 0', () => {
        // The admission writes 0 until the run allocates its slot.
        withTempDir(dir => {
            writeFileSync(
                `${dir}/run-build-debian-12`,
                record('debian-12', '0', 2048)
            )
            const { same, holder } = usage(dir, 'debian-12')
            expect(same).toBe('1')
            expect(holder.slice(0, 3)).toEqual([
                'run-build-debian-12',
                'build',
                '0',
            ])
        })
    })
})

describe('parseAdmission', () => {
    const recipe = {
        name: 'windows-server-2025',
        buildMemoryMb: 8192,
        buildCores: 4,
    } as RecipeInfo

    test('names a CI run holding the recipe lease by its run id', () => {
        expect(
            parseAdmission(
                'WAIT 8192 16384 4 8 1 44623195255-1-build-windows-server-2025 build 200201 20880\n',
                recipe
            )
        ).toEqual({
            status: 'WAIT',
            waitingFor:
                'another windows-server-2025 run (build lease 44623195255-1-build-windows-server-2025: ' +
                'CF_RUN_ID 44623195255-1, VMID 200201, held 5h48m)',
        })
    })

    test('says when the holder was not started by CI', () => {
        // Lease ids fall back to a random UUID without CF_RUN_ID, which every
        // CI build job sets.
        const admission = parseAdmission(
            'WAIT 8192 16384 4 8 1 0b6c9e1e-2f43-4c1d-9a51-1d2f5d8c7e10 verify 0 -1',
            recipe
        )
        expect(admission).toEqual({
            status: 'WAIT',
            waitingFor:
                'another windows-server-2025 run (verify lease 0b6c9e1e-2f43-4c1d-9a51-1d2f5d8c7e10: ' +
                'no CF_RUN_ID, so not started by CI, no VMID yet)',
        })
    })

    test('keeps the capacity wait as it was', () => {
        expect(
            parseAdmission('WAIT 12288 16384 6 8 0 - - 0 -1', recipe)
        ).toEqual({
            status: 'WAIT',
            waitingFor: 'node capacity (12288/16384 MiB, 6/8 CPU in use)',
        })
    })

    test('reads admission and rejection, and refuses anything else', () => {
        expect(parseAdmission('ACQUIRED 16384 8', recipe)).toEqual({
            status: 'ACQUIRED',
        })
        expect(parseAdmission('REJECT 4096 2', recipe)).toEqual({
            status: 'REJECT',
            message:
                'windows-server-2025 requires 8192 MiB/4 CPU, exceeding the node build budget 4096 MiB/2 CPU',
        })
        expect(() => parseAdmission('bash: flock: not found', recipe)).toThrow(
            'invalid build-lease response'
        )
    })

    test('reads a run id out of a sanitized lease id', () => {
        expect(
            describeLeaseHolder(
                {
                    id: runLeaseId('12345-2', 'build', 'ubuntu 24.04'),
                    kind: 'build',
                    vmid: 100300,
                    heldSecs: 59,
                },
                'ubuntu 24.04'
            )
        ).toBe(
            'build lease 12345-2-build-ubuntu-24.04: CF_RUN_ID 12345-2, VMID 100300, held 1m'
        )
    })
})

describe('a lease wait under a time budget', () => {
    const MIN = 60_000

    test('gives up once the time left cannot cover an attempt, naming the holder', () => {
        // windows-server-2025 on 2026-11-19 waited out the job's whole 6h
        // behind a build started outside CI, and its log never said why the
        // job died.
        let now = 0
        const budget: TimeBudget = {
            limitMs: 300 * MIN,
            startedAtMs: 0,
            now: () => now,
        }
        const admission = parseAdmission(
            'WAIT 8192 16384 4 8 1 0b6c9e1e-2f43-4c1d-9a51-1d2f5d8c7e10 build 200201 25500',
            { name: 'windows-server-2025' } as RecipeInfo
        )
        if (admission.status !== 'WAIT') throw new Error('expected WAIT')
        const floorMs = 170 * MIN

        now = 130 * MIN
        expect(
            leaseWaitExhausted(budget, floorMs, now, admission.waitingFor)
        ).toBeUndefined()

        now = 131 * MIN
        expect(
            leaseWaitExhausted(budget, floorMs, now, admission.waitingFor)
                ?.message
        ).toBe(
            'gave up after waiting 2h11m for another windows-server-2025 run ' +
                '(build lease 0b6c9e1e-2f43-4c1d-9a51-1d2f5d8c7e10: no CF_RUN_ID, so not started by CI, VMID 200201, held 7h05m): ' +
                '2h11m of the 5h00m build time budget (CF_BUILD_TIME_BUDGET_MINUTES) used, 2h49m left, ' +
                'and a build attempt needs at least 2h50m. ' +
                "Starting one now would end in the CI job's time limit cancelling it."
        )
    })
})
