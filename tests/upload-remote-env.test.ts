import { afterEach, describe, expect, test } from 'bun:test'
import { remoteEnvironmentScript } from '@/upload/source.ts'

const VARS = ['R2_ENDPOINT', 'R2_BUCKET', 'AWS_ACCESS_KEY_ID'] as const
const saved = new Map<string, string | undefined>()

const setEnv = (pairs: Partial<Record<string, string>>): void => {
    for (const key of VARS) {
        if (!saved.has(key)) saved.set(key, process.env[key])
        if (pairs[key] === undefined) delete process.env[key]
        else process.env[key] = pairs[key]
    }
}

afterEach(() => {
    for (const [key, value] of saved)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    saved.clear()
})

describe('remoteEnvironmentScript', () => {
    // A `VAR=x cmd` prefix reaches only cmd's environment, and the shell
    // expands the rest of the line before applying it — so the default upload
    // template's `$R2_ENDPOINT` expanded to nothing and `--endpoint-url` ate
    // the `s3` subcommand. Separate `export` statements are the whole fix.
    test('exports each variable as its own statement', () => {
        setEnv({
            R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
            R2_BUCKET: 'templates',
            AWS_ACCESS_KEY_ID: 'key',
        })
        const script = remoteEnvironmentScript()
        expect(script).toContain(
            "export R2_ENDPOINT='https://acct.r2.cloudflarestorage.com'\n"
        )
        expect(script).toContain("export R2_BUCKET='templates'\n")
        expect(script.endsWith('\n')).toBe(true)
        for (const line of script.split('\n').filter(Boolean))
            expect(line.startsWith('export ')).toBe(true)
    })

    test('a following command can expand the exported variables', async () => {
        setEnv({ R2_ENDPOINT: 'https://endpoint.example', R2_BUCKET: 'bucket' })
        const script = `${remoteEnvironmentScript()}echo "$R2_ENDPOINT|$R2_BUCKET"\n`
        const proc = Bun.spawn(['bash', '-s'], {
            stdin: new TextEncoder().encode(script),
            stdout: 'pipe',
        })
        const out = await new Response(proc.stdout).text()
        expect(out.trim()).toBe('https://endpoint.example|bucket')
    })

    test('omits variables that are not set', () => {
        setEnv({})
        expect(remoteEnvironmentScript()).not.toContain('R2_ENDPOINT')
    })
})
