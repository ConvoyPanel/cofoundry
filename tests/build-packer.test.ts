import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
    assertPackerTmpDirSocketSafe,
    buildPackerVars,
    buildRemoteEnv,
    PACKER_TMP_ROOT,
    packerTmpDir,
    streamViaConsoleLog,
} from '../src/build/packer.ts'
import type { RecipeInfo } from '../src/config.ts'
import type { Env } from '../src/env.ts'

const env: Env = {
    PVE_HOST: 'pve.example.com',
    PVE_PORT: 8006,
    PVE_NODE: 'pve1',
    PVE_TOKEN_ID: 'root@pam!builder',
    PVE_TOKEN_SECRET: 'secret',
    SSH_TARGET: 'root@pve.example.com',
    PVE_DUMP_DIR: '/var/lib/vz/dump',
    CF_OUT_DIR: './dist',
    CF_SKIP_ARTIFACT_SYNC: false,
    CF_BRIDGE: 'vmbr0',
    CF_BUILD_BRIDGE: 'vmbr1',
    CF_STORAGE: 'local-lvm',
    CF_ISO_STORAGE: 'local',
    CF_BUILD_DNS: '1.1.1.1',
    CF_CLOUDBASE_INIT_VERSION: '1.1.8',
    CF_VIRTIO_WIN_VERSION: '0.1.285-1',
    CF_DOWNLOAD_CONCURRENCY: 8,
    CF_KEEP_VM: false,
}

describe('buildRemoteEnv', () => {
    test('uses a short private Packer temp directory for plugin sockets', () => {
        const tmpDir = packerTmpDir('00000000-0000-0000-0000-000000000000')
        const result = buildRemoteEnv(
            env,
            '/var/lib/vz/dump/cofoundry-out',
            tmpDir,
            'amd64',
            'linux'
        )

        expect(tmpDir).toStartWith(`${PACKER_TMP_ROOT}/`)
        expect(result).toContain(`TMPDIR='${tmpDir}'`)
        expect(() => assertPackerTmpDirSocketSafe(tmpDir)).not.toThrow()
    })

    test('rejects a temp directory that cannot hold Packer plugin sockets', () => {
        const tooLong = `/var/tmp/${'x'.repeat(100)}`
        expect(() => assertPackerTmpDirSocketSafe(tooLong)).toThrow(
            'Packer TMPDIR is too long'
        )
    })

    test('exports the recipe base VMID independently of the build slot VMID', () => {
        const result = buildRemoteEnv(
            env,
            '/var/lib/vz/dump/cofoundry-out',
            '/var/lib/vz/dump/cofoundry-tmp',
            'amd64',
            'linux',
            undefined,
            4001
        )

        expect(result).toContain("CF_RECIPE_BASE_VMID='4001'")
        expect(result).toContain("PKR_VAR_proxmox_username='root@pam!builder'")
        expect(result).toContain("PKR_VAR_proxmox_token='secret'")
    })

    test('leaves the base unset for plain callers that rely on CF_BUILT_VMID', () => {
        const result = buildRemoteEnv(
            env,
            '/var/lib/vz/dump/cofoundry-out',
            '/var/lib/vz/dump/cofoundry-tmp',
            'amd64',
            'linux'
        )

        expect(result).not.toContain('CF_RECIPE_BASE_VMID')
    })

    test('omits upload configuration and credentials when upload is skipped', () => {
        const uploadEnv: Env = {
            ...env,
            CF_UPLOAD_CMD: 'upload {{file}}',
            CF_SIDECAR_UPLOAD_CMD: 'upload-sidecar {{file}}',
            CF_PUBLIC_URL_TMPL: 'https://cdn.example.com/{{sha256}}',
            R2_ENDPOINT: 'https://r2.example.com',
            R2_BUCKET: 'templates',
            R2_PREFIX: 'templates/',
        }
        const previousAccessKey = process.env.AWS_ACCESS_KEY_ID
        process.env.AWS_ACCESS_KEY_ID = 'access-key'
        try {
            const result = buildRemoteEnv(
                uploadEnv,
                '/var/lib/vz/dump/cofoundry-out',
                '/var/lib/vz/dump/cofoundry-tmp',
                'amd64',
                'linux',
                undefined,
                undefined,
                true
            )

            expect(result).not.toContain('CF_UPLOAD_CMD')
            expect(result).not.toContain('CF_SIDECAR_UPLOAD_CMD')
            expect(result).not.toContain('R2_ENDPOINT')
            expect(result).not.toContain('R2_BUCKET')
            expect(result).not.toContain('AWS_ACCESS_KEY_ID')
        } finally {
            if (previousAccessKey === undefined)
                delete process.env.AWS_ACCESS_KEY_ID
            else process.env.AWS_ACCESS_KEY_ID = previousAccessKey
        }
    })

    test('still exports the public URL template when upload is skipped', () => {
        // CI builds with --skip-upload and uploads only after verify passes,
        // but the sidecar is written during the build and never rewritten
        // afterwards. Withholding the template here is what published a
        // registry whose every disk had `"url": ""` — the images were live and
        // reachable, and no consumer could find them.
        const uploadEnv: Env = {
            ...env,
            CF_PUBLIC_URL_TMPL: 'https://cdn.example.com/{{sha256}}{{ext}}',
        }
        const result = buildRemoteEnv(
            uploadEnv,
            '/var/lib/vz/dump/cofoundry-out',
            '/var/lib/vz/dump/cofoundry-tmp',
            'amd64',
            'linux',
            undefined,
            undefined,
            true
        )

        expect(result).toContain(
            "CF_PUBLIC_URL_TMPL='https://cdn.example.com/{{sha256}}{{ext}}'"
        )
    })
})

describe('buildPackerVars', () => {
    test('never places Proxmox credentials in Packer arguments', () => {
        const args = buildPackerVars(
            env,
            { name: 'debian-13' } as RecipeInfo,
            'vmbr1',
            null,
            400100
        )
        const commandLine = args.join(' ')

        expect(commandLine).not.toContain(env.PVE_TOKEN_ID)
        expect(commandLine).not.toContain(env.PVE_TOKEN_SECRET)
        expect(commandLine).not.toContain('proxmox_username')
        expect(commandLine).not.toContain('proxmox_token')
    })

    test('passes the pinned virtio ISO filename only to Windows recipes', () => {
        const windowsArgs = buildPackerVars(
            env,
            { name: 'windows-server-2025' } as RecipeInfo,
            'vmbr1',
            null,
            200200
        )
        expect(windowsArgs.join(' ')).toContain(
            'virtio_win_iso=packer-virtio-win-0.1.285-1.iso'
        )

        // Non-Windows recipes do not declare the variable; passing it would
        // fail `packer build` with an undefined -var error.
        const linuxArgs = buildPackerVars(
            env,
            { name: 'debian-13' } as RecipeInfo,
            'vmbr1',
            null,
            400100
        )
        expect(linuxArgs.join(' ')).not.toContain('virtio_win_iso')
    })
})

describe('streamViaConsoleLog', () => {
    const command = "FOO='bar' packer build -force /tmp/x.pkr.hcl"
    const logPath = '/var/tmp/cofoundry-packer/run 1/packer-console.log'

    test('writes combined output to the log and streams it with tail', () => {
        const script = streamViaConsoleLog(command, logPath)
        const q = "'/var/tmp/cofoundry-packer/run 1/packer-console.log'"

        // Command runs backgrounded with stdout+stderr merged into the log...
        expect(script).toContain(`${command} > ${q} 2>&1 &`)
        // ...and the live view is a tail of that durable file, not the pipe.
        expect(script).toContain(`tail -n +1 --pid="$__cf_pid" -f ${q}`)
    })

    test('re-raises the command exit status so failures still propagate', () => {
        const script = streamViaConsoleLog(command, logPath)
        // `wait` on the command pid is the final statement, so the script's
        // exit code is Packer's — the retry logic depends on this.
        expect(script.trimEnd().endsWith('wait "$__cf_pid"')).toBe(true)
    })

    test('quotes the log path and stays valid bash', () => {
        const script = streamViaConsoleLog(command, logPath)
        const result = spawnSync('bash', ['-n'], {
            input: script,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })
})
