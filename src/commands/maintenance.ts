import type { Command } from 'commander'
import { runClean, runPrune, runPruneR2 } from '@/prune.ts'
import { runBootstrap } from '@/bootstrap.ts'
import { runVerify } from '@/verify.ts'
import { listRecipes, loadRecipe } from '@/config.ts'
import { loadEnv, loadEnvPartial } from '@/env.ts'
import { DEFAULT_PREFIX } from '@/config-file/upload.ts'

export const registerMaintenanceCommands = (program: Command): void => {
    program
        .command('clean')
        .description('Remove remote build leftovers and uploaded ISOs')
        .action(async () => runClean(loadEnv(), await listRecipes()))

    program
        .command('prune')
        .description('Reclaim space on the Proxmox node or in R2')
        .option('--days <n>', 'Treat files older than N days as stale', '30')
        .option('--dry-run', 'Enumerate targets without deleting', false)
        .option('--r2', 'Prune R2 image objects instead of node files')
        .option(
            '--keep <n>',
            'With --r2: keep newest N per template prefix',
            '5'
        )
        .option(
            '--reap-lease <prefix>',
            'Reap leases under this run-id prefix regardless of age (CI cleanup)'
        )
        .action(
            async (opts: {
                days: string
                dryRun: boolean
                r2?: boolean
                keep: string
                reapLease?: string
            }) => {
                if (opts.r2) {
                    const env = loadEnvPartial()
                    if (!env.R2_ENDPOINT || !env.R2_BUCKET)
                        throw new Error(
                            'R2_ENDPOINT and R2_BUCKET are required for --r2 prune'
                        )
                    await runPruneR2(
                        {
                            endpoint: env.R2_ENDPOINT,
                            bucket: env.R2_BUCKET,
                            prefix: env.R2_PREFIX ?? DEFAULT_PREFIX,
                        },
                        {
                            keep: Number.parseInt(opts.keep, 10),
                            dryRun: Boolean(opts.dryRun),
                        }
                    )
                    return
                }
                await runPrune(loadEnv(), {
                    days: Number.parseInt(opts.days, 10),
                    dryRun: Boolean(opts.dryRun),
                    reapLeasePrefix: opts.reapLease,
                })
            }
        )

    program
        .command('bootstrap')
        .description('Interactively provision a fresh Proxmox build node')
        .action(async () => runBootstrap(loadEnvPartial()))

    program
        .command('verify <name>')
        .description('Restore and smoke-test a built artifact')
        .option(
            '--level <level>',
            'quick (boot + agent ping) or full (check battery)',
            'full'
        )
        .option('--ci', 'CI mode: never write framebuffer captures to disk')
        .action(async (name: string, opts: { level: string; ci?: boolean }) => {
            if (opts.level !== 'quick' && opts.level !== 'full') {
                throw new Error(
                    `--level must be "quick" or "full", got "${opts.level}"`
                )
            }
            await runVerify(loadEnv(), await loadRecipe(name), {
                level: opts.level,
                ciMode: Boolean(opts.ci),
            })
        })
}
