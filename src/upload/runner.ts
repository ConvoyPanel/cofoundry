import { createRenderer, title, accent, dim } from '@cofoundry/ui'
import type { Env } from '@/env.ts'
import { buildRemoteOutDir } from '@/build/paths.ts'
import { log } from '@/log.ts'
import { systemDisk } from '@/registry/schema.ts'
import type { UploadOptions } from '@/upload/model.ts'
import { loadSidecars } from '@/upload/sidecars.ts'
import {
    executeUpload,
    localUploadSource,
    remoteUploadSource,
} from '@/upload/source.ts'
import {
    formatArtifactSize,
    localArtifactName,
    renderUploadTemplate,
    uploadVariables,
} from '@/upload/template.ts'

export const runUpload = async (
    env: Env,
    opts: UploadOptions
): Promise<void> => {
    if (!env.CF_UPLOAD_CMD) throw new Error('CF_UPLOAD_CMD is not set')
    const sidecarCommand = env.CF_SIDECAR_UPLOAD_CMD
    const source = opts.remote
        ? remoteUploadSource(
              env.SSH_TARGET,
              opts.sourceDir ?? buildRemoteOutDir(env)
          )
        : localUploadSource(opts.sourceDir ?? env.CF_OUT_DIR)
    const items = await loadSidecars(source, opts.names)
    if (items.length === 0) {
        log.warn(`No sidecar .json files found in ${source.label}`)
        return
    }

    const renderer = createRenderer({
        title: title(
            `Uploading ${items.length} artifact${items.length === 1 ? '' : 's'} ${dim('from')} ${accent(source.label)}${opts.dryRun ? dim(' (dry-run)') : ''}`
        ),
        outputLines: 2,
    })
    const failed: string[] = []
    let succeeded = 0

    try {
        for (const { sidecar } of items) {
            const task = renderer.task(sidecar.name)
            const sidecarFile = `${sidecar.name}.json`

            // Every disk must be present before ANY of them is uploaded. A
            // template whose system disk published but whose varstore did not
            // is unusable, and the sidecar advertising both would already be
            // live — better to fail the template whole than half-publish it.
            task.setPhase('checking artifacts')
            const artifacts = sidecar.disks.map(disk => ({
                disk,
                file: localArtifactName(sidecar, disk),
            }))
            const missing = (
                await Promise.all(
                    artifacts.map(async ({ file }) =>
                        (await source.fileExists(file)) ? null : file
                    )
                )
            ).filter((file): file is string => file !== null)
            if (missing.length > 0) {
                task.fail(
                    `artifact missing (${missing.map(f => source.pathOf(f)).join(', ')})`
                )
                failed.push(sidecar.name)
                continue
            }

            try {
                let variables = uploadVariables(
                    sidecar,
                    artifacts[0]!.disk,
                    source.pathOf(artifacts[0]!.file)
                )
                for (const { disk, file } of artifacts) {
                    variables = uploadVariables(
                        sidecar,
                        disk,
                        source.pathOf(file)
                    )
                    const command = renderUploadTemplate(
                        env.CF_UPLOAD_CMD,
                        variables
                    )
                    task.setPhase(
                        `uploading ${disk.slot} ${dim(`(${formatArtifactSize(disk.size)})`)}`
                    )
                    if (opts.dryRun) task.log(command)
                    else await executeUpload(source, command, task)
                }

                // Last, so a sidecar never advertises an image that failed to
                // upload above. Content-addressed by the system disk so each
                // build gets a distinct key instead of overwriting the last.
                if (sidecarCommand && !opts.skipSidecar) {
                    const system = systemDisk(sidecar)
                    const command = renderUploadTemplate(sidecarCommand, {
                        ...variables,
                        sha256: system.sha256,
                        file: source.pathOf(sidecarFile),
                        filename: `${sidecar.name}-${system.sha256}.json`,
                    })
                    task.setPhase('uploading sidecar')
                    if (opts.dryRun) task.log(command)
                    else await executeUpload(source, command, task)
                }
                task.succeed(opts.dryRun ? 'planned' : 'uploaded')
                succeeded++
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error)
                task.fail(message)
                failed.push(sidecar.name)
            }
        }
    } finally {
        renderer.finish()
    }

    log.blank()
    if (failed.length > 0)
        throw new Error(
            `${failed.length} upload(s) failed: ${failed.join(', ')}`
        )
    log.ok(`Uploaded ${succeeded}/${items.length}.`)
}
