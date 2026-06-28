import { Command } from 'commander'
import { log, dim, accent, type Renderer } from '@cofoundry/ui'
import pkg from '../package.json' with { type: 'json' }
import { resolveConfig, describeSource, RegistryKind } from './config.ts'
import { fetchRegistry } from './registry.ts'
import { readCache } from './cache.ts'
import { planInstall, staleItems, printInstalled } from './plan.ts'
import { runInstalls } from './runner.ts'
import { cleanupTempDirSync } from './download.ts'
import type { InstallItem } from './types.ts'

// A piped registry occupies stdin, leaving no keyboard for the interactive menu.
// Rather than hang, point the user at the two no-file modes that do work.
const PIPED_INTERACTIVE_HELP =
    'Reading the registry from stdin leaves no terminal for the interactive menu.\n' +
    '  • Keep it interactive — pass the registry as an argument:\n' +
    '        coport "$(curl -s https://…/registry.json)"\n' +
    '  • Or stay piped and skip the menu with --all or --select:\n' +
    '        curl -s https://…/registry.json | coport --all --storage <name>'

const program = new Command()

program
    .name('coport')
    .description('Install Cofoundry VM templates into Proxmox')
    .version(pkg.version)
    .argument(
        '[registry]',
        'Registry URL, file path, inline JSON, "-" for stdin, or omit for default/config'
    )
    .option('-s, --storage <name>', 'Proxmox storage volume (skips prompt)')
    .option('-g, --group <id>', 'Only show/install templates from this group')
    .option('-f, --filter <tag>', 'Only show/install templates with this tag')
    .option(
        '-a, --all',
        'Install every template with suggested/cached VMIDs (no prompts)'
    )
    .option(
        '--select <spec>',
        'Non-interactive selection: "all", index ranges (1,3-5), or template names'
    )
    .option(
        '--upgrade',
        'Upgrade installed templates whose registry version changed (reuses their VMIDs)'
    )
    .option(
        '-l, --list',
        'List installed templates (name, VMID, storage, version) and exit'
    )
    .option('--vmid-start <n>', 'Auto-VMID range start for conflicts', '9000')
    .option('--dry-run', 'Show what would be installed; skip downloads')
    .option(
        '--overwrite',
        'Overwrite existing VMs when a suggested VMID is already taken'
    )
    .option('--no-verify', 'Skip SHA-256 verification after download')
    .option(
        '--download-concurrency <n>',
        'Parallel downloads (env: COPORT_DOWNLOAD_CONCURRENCY)',
        process.env.COPORT_DOWNLOAD_CONCURRENCY ?? '4'
    )
    .option(
        '--restore-concurrency <n>',
        'Parallel verifies + qmrestores (env: COPORT_RESTORE_CONCURRENCY)',
        process.env.COPORT_RESTORE_CONCURRENCY ?? '2'
    )
    .option('--verbose', 'Stream per-event logs instead of in-place TUI')
    .action(async (registryArg: string | undefined, opts) => {
        const abort = new AbortController()
        let interrupted = false
        let activeRenderer: Renderer | undefined
        process.once('SIGINT', () => {
            interrupted = true
            abort.abort()
            activeRenderer?.finish()
            log.warn('Interrupted; stopping active downloads/restores...')
            cleanupTempDirSync()
            process.exit(130)
        })

        // `-l/--list`: print installed templates and exit; no registry needed.
        if (opts.list) {
            printInstalled(await readCache())
            return
        }

        const { source, defaultStorage } = await resolveConfig(registryArg)
        const nonInteractive = Boolean(
            opts.all || opts.upgrade || opts.select != null
        )

        // A piped registry can't coexist with the interactive menu (both want
        // stdin). Fail fast with guidance instead of hanging on a dead keyboard.
        if (source.kind === RegistryKind.Stdin && !nonInteractive) {
            log.err(PIPED_INTERACTIVE_HELP)
            process.exit(2)
        }

        log.info(`Registry: ${dim(describeSource(source))}`)
        const registry = await fetchRegistry(source)
        const count = registry.groups.reduce(
            (n, g) => n + g.templates.length,
            0
        )
        log.ok(
            `Loaded ${accent(`"${registry.name}"`)} ${dim(`(${count} templates)`)}`
        )

        const cache = await readCache()

        // Build the list of things to install for whichever mode we're in.
        let items: InstallItem[]
        if (opts.upgrade) {
            items = staleItems(registry, cache, opts.group, opts.filter)
            if (items.length === 0) {
                log.ok('Everything up to date — nothing to upgrade.')
                return
            }
        } else {
            items = await planInstall(
                registry,
                cache,
                opts,
                defaultStorage,
                nonInteractive
            )
            if (items.length === 0) {
                log.warn('No templates selected.')
                process.exit(0)
            }
        }

        if (opts.dryRun) {
            log.section('Dry run — would install')
            for (const item of items) {
                log.raw(
                    `  ${item.template.display.padEnd(28)} ${dim('→')} VMID ${accent(String(item.vmid))} ${dim(`(${item.storage})`)}`
                )
            }
            log.blank()
            process.exit(0)
        }

        await runInstalls(items, opts, cache, abort, r => {
            activeRenderer = r
        })

        if (interrupted) {
            log.warn(
                'Interrupted. Temporary archives were removed; inspect Proxmox for any partial restores before retrying.'
            )
            process.exit(130)
        }
    })

program.parseAsync(process.argv).catch(err => {
    cleanupTempDirSync()
    log.err(err instanceof Error ? err.message : String(err))
    process.exit(1)
})
