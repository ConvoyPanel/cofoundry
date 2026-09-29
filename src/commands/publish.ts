import type { Command } from 'commander'
import { runUpload } from '@/upload.ts'
import { buildManifest, buildManifestFromR2 } from '@/manifest.ts'
import { loadEnv, loadEnvPartial } from '@/env.ts'
import { DEFAULT_PREFIX } from '@/config-file/upload.ts'

type UploadOptions = {
    remote?: boolean
    sourceDir?: string
    skipSidecar?: boolean
    dryRun?: boolean
}

export const registerPublishCommands = (program: Command): void => {
    program
        .command('upload [names...]')
        .description('Upload already-built artifacts and sidecars')
        .option(
            '--remote',
            'Upload directly from the PVE node instead of locally'
        )
        .option('--source-dir <dir>', 'Artifact and sidecar source directory')
        .option('--skip-sidecar', 'Skip sidecar JSON upload')
        .option('--dry-run', 'Print upload commands without running them')
        .action(async (names: string[], opts: UploadOptions) => {
            await runUpload(loadEnv(), { names, ...opts })
        })

    program
        .command('publish')
        .description('Aggregate sidecars into registry.json')
        .option('--r2', 'Source sidecars from R2 instead of CF_OUT_DIR')
        .option('--prefix <prefix>', 'R2 key prefix to scan')
        .option('--source-dir <dir>', 'Local sidecar source directory')
        .option('--out <path>', 'Where to write registry.json', 'registry.json')
        .action(
            async (opts: {
                r2?: boolean
                prefix?: string
                sourceDir?: string
                out: string
            }) => {
                if (opts.r2) {
                    const env = loadEnvPartial()
                    if (!env.R2_ENDPOINT || !env.R2_BUCKET)
                        throw new Error(
                            'R2_ENDPOINT and R2_BUCKET are required for --r2 publish'
                        )
                    await buildManifestFromR2(
                        {
                            endpoint: env.R2_ENDPOINT,
                            bucket: env.R2_BUCKET,
                            prefix: env.R2_PREFIX ?? DEFAULT_PREFIX,
                        },
                        opts.out,
                        opts.prefix
                    )
                    return
                }
                const sourceDir =
                    opts.sourceDir || loadEnvPartial().CF_OUT_DIR || './dist'
                await buildManifest(sourceDir, opts.out)
            }
        )
}
