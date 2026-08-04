import { describe, expect, test } from 'bun:test'
import type { RecipeInfo } from '@/config.ts'
import type { Env } from '@/env.ts'
import {
    runPipeline,
    stripPackerBuildPrefix,
    type PipelineDependencies,
} from '@/build/pipeline.ts'

const env = {} as Env
const recipe = {
    name: 'debian-12',
    display: 'Debian 12',
    path: 'recipes/debian-12.pkr.hcl',
    arch: 'amd64',
    buildMemoryMb: 4096,
    buildCores: 2,
} as RecipeInfo

const dependencies = (
    events: string[],
    failure?: keyof PipelineDependencies
): PipelineDependencies => {
    const run = async (name: keyof PipelineDependencies): Promise<void> => {
        events.push(name)
        if (failure === name) throw new Error(`${name} failed`)
    }
    return {
        syncRepo: async () => {
            await run('syncRepo')
            return '/dump/cofoundry-snapshots/test'
        },
        prefetch: async () => run('prefetch'),
        build: async () => {
            await run('build')
            return { startedAt: 123 }
        },
        sync: async () => run('sync'),
        acquireMaintenance: async () => ({
            lost: new Promise<never>(() => undefined),
            release: async () => {},
        }),
        shrinkPreflight: async () => run('shrinkPreflight'),
    }
}

describe('runPipeline', () => {
    test('runs repository, prefetch, build, and artifact phases', async () => {
        const events: string[] = []
        const result = await runPipeline(
            env,
            [recipe],
            { syncBack: true, ci: true },
            dependencies(events)
        )
        expect(events).toEqual([
            'shrinkPreflight',
            'syncRepo',
            'prefetch',
            'build',
            'sync',
        ])
        expect(result).toEqual({ passed: ['debian-12'], failed: [] })
    })

    test('records a phase failure and does not run later phases', async () => {
        const events: string[] = []
        const result = await runPipeline(
            env,
            [recipe],
            { syncBack: true, ci: true, skipRepoSync: true },
            dependencies(events, 'build')
        )
        expect(events).toEqual(['shrinkPreflight', 'prefetch', 'build'])
        expect(result.passed).toEqual([])
        expect(result.failed).toEqual([
            { name: 'debian-12', error: 'build failed' },
        ])
    })

    test('passes the upload override to the build phase', async () => {
        const events: string[] = []
        const deps = dependencies(events)
        deps.build = async (_env, _recipe, options) => {
            events.push('build')
            expect(options.skipUpload).toBeTrue()
            return { startedAt: 123 }
        }

        await runPipeline(
            env,
            [recipe],
            {
                syncBack: false,
                skipUpload: true,
                skipRepoSync: true,
                ci: true,
            },
            deps
        )

        expect(events).toEqual(['shrinkPreflight', 'prefetch', 'build'])
    })

    test('pins builds to the snapshot returned by repository sync', async () => {
        const events: string[] = []
        const deps = dependencies(events)
        deps.syncRepo = async () => '/dump/cofoundry-snapshots/pinned'
        deps.build = async (_env, _recipe, options) => {
            expect(options.snapshotDir).toBe('/dump/cofoundry-snapshots/pinned')
            return { startedAt: 123 }
        }

        await runPipeline(env, [recipe], { syncBack: false, ci: true }, deps)
    })

    test('holds and releases the shared maintenance lock around every phase', async () => {
        const events: string[] = []
        const deps = dependencies(events)
        deps.acquireMaintenance = async (_target, mode) => {
            expect(mode).toBe('shared')
            events.push('lock')
            return {
                lost: new Promise<never>(() => undefined),
                release: async () => void events.push('unlock'),
            }
        }
        await runPipeline(env, [recipe], { syncBack: false, ci: true }, deps)
        expect(events).toEqual([
            'lock',
            'shrinkPreflight',
            'syncRepo',
            'prefetch',
            'build',
            'unlock',
        ])
    })

    test('fails fast when the shrink preflight rejects the storage', async () => {
        const events: string[] = []
        const deps = dependencies(events)
        deps.shrinkPreflight = async () => {
            events.push('shrinkPreflight')
            throw new Error(
                'final_disk_size requires file-backed qcow2 disks, but storage "local-zfs" has type "zfspool"'
            )
        }
        await expect(
            runPipeline(env, [recipe], { syncBack: true, ci: true }, deps)
        ).rejects.toThrow('"zfspool"')
        // No sync/prefetch/build phase may start once the preflight refuses.
        expect(events).toEqual(['shrinkPreflight'])
    })

    test('requires resource budgets when parallel builds are enabled', async () => {
        expect(
            runPipeline(
                env,
                [recipe],
                {
                    syncBack: false,
                    ci: true,
                    skipRepoSync: true,
                    buildConcurrency: 2,
                },
                dependencies([])
            )
        ).rejects.toThrow('require both a memory budget and a CPU budget')
    })

    test('rejects invalid CLI resource budgets', async () => {
        expect(
            runPipeline(
                env,
                [recipe],
                {
                    syncBack: false,
                    ci: true,
                    buildMemoryBudgetMb: 0,
                },
                dependencies([])
            )
        ).rejects.toThrow('build memory budget must be a positive integer')
    })

    test('re-surfaces the template banner past trailing teardown noise', async () => {
        const events: string[] = []
        const deps = dependencies(events)
        deps.build = async (_env, _recipe, _options, onLine) => {
            events.push('build')
            onLine?.(
                '--> proxmox-iso.debian-12: A template was created: 400102'
            )
            onLine?.(
                "Configuration file 'nodes/n/qemu-server/400102.conf' does not exist"
            )
            return { startedAt: 123 }
        }

        const written: string[] = []
        const original = process.stderr.write.bind(process.stderr)
        process.stderr.write = ((chunk: unknown) => {
            written.push(String(chunk))
            return true
        }) as typeof process.stderr.write
        try {
            await runPipeline(
                env,
                [recipe],
                { syncBack: false, skipRepoSync: true, ci: true },
                deps
            )
        } finally {
            process.stderr.write = original
        }

        const out = written.join('')
        const bannerIdx = out.lastIndexOf('A template was created: 400102')
        const noiseIdx = out.lastIndexOf('does not exist')
        expect(bannerIdx).toBeGreaterThan(-1)
        expect(noiseIdx).toBeGreaterThan(-1)
        // The banner must be re-logged AFTER the teardown noise so the summary
        // ring buffer ends on the created template, not the benign warning.
        expect(bannerIdx).toBeGreaterThan(noiseIdx)
    })

    test('strips the redundant packer builder prefix, keeping the step marker', () => {
        expect(
            stripPackerBuildPrefix(
                '==> proxmox-iso.windows-server-2019: downloading 5 update(s)',
                'windows-server-2019'
            )
        ).toBe('==> downloading 5 update(s)')
        // Indented sub-output arrives without the `==>` marker after trimming.
        expect(
            stripPackerBuildPrefix(
                'proxmox-iso.windows-server-2019:     download 11%',
                'windows-server-2019'
            )
        ).toBe('download 11%')
    })

    test('sees past packer’s color codes and keeps them', () => {
        // Packer colors its output even when redirected to a file, so the SGR
        // escape — not `==>` — starts the line. Bytes copied from CI run
        // 30868276107, job 91866880126.
        expect(
            stripPackerBuildPrefix(
                '\u001b[1;32m==> proxmox-iso.rocky-linux-10: Waiting 15s for boot\u001b[0m',
                'rocky-linux-10'
            )
        ).toBe('\u001b[1;32m==> Waiting 15s for boot\u001b[0m')
        // Sub-output: no step marker, and the indent sits inside the escape.
        expect(
            stripPackerBuildPrefix(
                '\u001b[1;32m    proxmox-iso.rocky-linux-10: status: disabled\u001b[0m',
                'rocky-linux-10'
            )
        ).toBe('\u001b[1;32mstatus: disabled\u001b[0m')
    })

    test('collapses a provisioner step marker onto packer’s', () => {
        // `recipes/_shared/**` scripts echo their own `==> `; once the builder
        // prefix between the two markers is gone they would read `==> ==> x`.
        expect(
            stripPackerBuildPrefix(
                '==> proxmox-iso.rocky-linux-10: ==> Updating packages',
                'rocky-linux-10'
            )
        ).toBe('==> Updating packages')
        // A marker inside the message, not at the front, is left alone.
        expect(
            stripPackerBuildPrefix(
                '==> proxmox-iso.rocky-linux-10: done ==> next',
                'rocky-linux-10'
            )
        ).toBe('==> done ==> next')
        // Same collapse when the pair is behind a color escape.
        expect(
            stripPackerBuildPrefix(
                '\u001b[1;32m==> proxmox-iso.rocky-linux-10: ==> Updating packages\u001b[0m',
                'rocky-linux-10'
            )
        ).toBe('\u001b[1;32m==> Updating packages\u001b[0m')
    })

    test('leaves other builder-shaped text untouched', () => {
        // A different source name must not be stripped.
        expect(
            stripPackerBuildPrefix(
                '==> proxmox-iso.debian-12: booting',
                'windows-server-2019'
            )
        ).toBe('==> proxmox-iso.debian-12: booting')
        // Genuine `word.word:` content in a message is preserved.
        expect(
            stripPackerBuildPrefix('config.yaml: parsed', 'windows-server-2019')
        ).toBe('config.yaml: parsed')
    })

    test('rejects duplicate recipes in a parallel build', async () => {
        expect(
            runPipeline(
                env,
                [recipe, recipe],
                {
                    syncBack: false,
                    ci: true,
                    buildConcurrency: 2,
                    buildMemoryBudgetMb: 8192,
                    buildCpuBudget: 4,
                },
                dependencies([])
            )
        ).rejects.toThrow('cannot include debian-12 more than once')
    })
})
