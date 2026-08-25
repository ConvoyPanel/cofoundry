import { createArgs, type CreateOptions } from '@/registry/create.ts'
import type { Template } from '@/registry/schema.ts'

export type { CreateOptions }

const run = async (
    args: string[],
    onProgress?: (pct: number) => void,
    signal?: AbortSignal
): Promise<void> => {
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })
    const abort = (): void => {
        proc.kill('SIGTERM')
    }
    signal?.addEventListener('abort', abort, { once: true })

    const decoder = new TextDecoder()
    try {
        for await (const chunk of proc.stdout) {
            if (signal?.aborted) throw new Error('Aborted')
            const text = decoder.decode(chunk)
            // `qm create` reports each import as "transferred X of Y (Z%)".
            const m = text.match(/\((\d+(?:\.\d+)?)%\)/)
            if (m && onProgress) onProgress(Number(m[1]))
        }

        const code = await proc.exited
        if (signal?.aborted) throw new Error('Aborted')
        if (code !== 0) {
            const errText = decoder.decode(
                await new Response(proc.stderr).arrayBuffer()
            )
            throw new Error(
                `${args[0]} ${args[1]} exited with code ${code}: ${errText.trim()}`
            )
        }
    } finally {
        signal?.removeEventListener('abort', abort)
    }
}

/**
 * Build a clonable template from downloaded images.
 *
 * `qm create --force` only applies to `archive` restores, so an overwrite has
 * to destroy the occupant first rather than being a flag on the create.
 */
export const installTemplate = async (
    template: Template,
    options: CreateOptions & { overwrite: boolean },
    onProgress?: (pct: number) => void,
    signal?: AbortSignal
): Promise<void> => {
    if (options.overwrite) {
        await run([
            'qm',
            'destroy',
            String(options.vmid),
            '--purge',
            '1',
            '--destroy-unreferenced-disks',
            '1',
        ]).catch(() => {})
    }

    await run(createArgs(template, options), onProgress, signal)
    await run(['qm', 'template', String(options.vmid)], undefined, signal)
}
