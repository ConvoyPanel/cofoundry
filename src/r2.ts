import { execa } from 'execa'

/**
 * Thin `aws` CLI wrappers shared by `cf publish --r2` and `cf prune --r2`.
 *
 * Both commands read the same bucket for the same reason — a schema-2 template
 * is several objects and only its sidecar says which — so the access lives in
 * one place rather than once per command.
 */

export const s3api = async (
    endpoint: string,
    args: string[],
    { interactive = false }: { interactive?: boolean } = {}
): Promise<string> => {
    const { stdout } = await execa(
        'aws',
        ['--endpoint-url', endpoint, 's3api', ...args],
        {
            ...(interactive ? { stdin: 'inherit' as const } : {}),
            stderr: 'inherit',
        }
    )
    return stdout
}

/** Fetch an object's body to a string. */
export const s3Get = async (
    endpoint: string,
    bucket: string,
    key: string
): Promise<string> => {
    const { stdout } = await execa(
        'aws',
        ['--endpoint-url', endpoint, 's3', 'cp', `s3://${bucket}/${key}`, '-'],
        { stderr: 'inherit' }
    )
    return stdout
}
