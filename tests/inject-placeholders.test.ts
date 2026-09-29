import { afterEach, describe, expect, test } from 'bun:test'
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(
    new URL('../scripts/inject-placeholders.sh', import.meta.url)
)
const tempDirs: string[] = []

afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true })
})

describe('inject-placeholders.sh', () => {
    test('substitutes recipe-name, network, and SSH key placeholders in preseed files', () => {
        const root = mkdtempSync(join(tmpdir(), 'cf-inject-'))
        tempDirs.push(root)
        const httpDir = join(root, 'recipes', 'debian-test', 'http')
        const runnerTemp = join(root, 'runner-temp')
        mkdirSync(httpDir, { recursive: true })
        mkdirSync(runnerTemp)
        const preseed = join(httpDir, 'preseed.cfg')
        writeFileSync(
            preseed,
            [
                'd-i netcfg/get_hostname string packer-__PACKER_RECIPE_NAME__',
                'd-i mirror/http/hostname string __PACKER_DEBIAN_MIRROR__',
                'd-i netcfg/get_ipaddress string __PACKER_BUILD_IP__',
                'd-i netcfg/get_gateway string __PACKER_BUILD_GW__',
                'd-i netcfg/get_nameservers string __PACKER_BUILD_DNS__',
                "echo '__PACKER_SSH_PUBLIC_KEY__' > /target/home/packer/.ssh/authorized_keys",
                '',
            ].join('\n')
        )

        const result = Bun.spawnSync(['bash', script, 'debian-test'], {
            cwd: root,
            env: {
                ...process.env,
                RUNNER_TEMP: runnerTemp,
                CF_BUILD_IP: '10.99.0.5',
                CF_BUILD_GW: '10.99.0.1',
                CF_BUILD_DNS: '9.9.9.9',
            },
        })
        expect(result.exitCode).toBe(0)

        const injected = readFileSync(preseed, 'utf8')
        expect(injected).toContain(
            'd-i netcfg/get_hostname string packer-debian-test'
        )
        // No recipe file, so no `# mirror:` header: the default mirror.
        expect(injected).toContain(
            'd-i mirror/http/hostname string deb.debian.org'
        )
        expect(injected).toContain('d-i netcfg/get_ipaddress string 10.99.0.5')
        expect(injected).toContain('d-i netcfg/get_gateway string 10.99.0.1')
        expect(injected).toContain('d-i netcfg/get_nameservers string 9.9.9.9')
        expect(injected).toContain("echo 'ssh-ed25519 ")
        expect(injected).not.toMatch(/__PACKER_[A-Z_]+__/)

        const varsFile = join(runnerTemp, 'packer-vars-debian-test.pkrvars.hcl')
        expect(readFileSync(varsFile, 'utf8')).toContain(
            'packer_ssh_private_key_file = '
        )
    })

    // A release Debian has archived installs from archive.debian.org. This has
    // to reach the preseed file: a boot-command value loses to it.
    test("takes the Debian mirror from the recipe's # mirror: header", () => {
        const root = mkdtempSync(join(tmpdir(), 'cf-inject-'))
        tempDirs.push(root)
        const httpDir = join(root, 'recipes', 'debian-old', 'http')
        const runnerTemp = join(root, 'runner-temp')
        mkdirSync(httpDir, { recursive: true })
        mkdirSync(runnerTemp)
        writeFileSync(
            join(root, 'recipes', 'debian-old.pkr.hcl'),
            '# display: Debian Old\n# mirror: archive.debian.org\n'
        )
        const preseed = join(httpDir, 'preseed.cfg')
        writeFileSync(
            preseed,
            'd-i mirror/http/hostname string __PACKER_DEBIAN_MIRROR__\n'
        )

        const result = Bun.spawnSync(['bash', script, 'debian-old'], {
            cwd: root,
            env: { ...process.env, RUNNER_TEMP: runnerTemp },
        })
        expect(result.exitCode).toBe(0)
        expect(readFileSync(preseed, 'utf8')).toBe(
            'd-i mirror/http/hostname string archive.debian.org\n'
        )
    })

    test('protects generated Windows credentials with mode 0600', () => {
        const root = mkdtempSync(join(tmpdir(), 'cf-inject-'))
        tempDirs.push(root)
        const recipeDir = join(root, 'recipes', 'windows-test')
        const runnerTemp = join(root, 'runner-temp')
        mkdirSync(recipeDir, { recursive: true })
        mkdirSync(runnerTemp)
        const answerFile = join(recipeDir, 'autounattend.xml')
        writeFileSync(
            answerFile,
            '<Password>__PACKER_ADMIN_PASSWORD__</Password>'
        )

        const result = Bun.spawnSync(['bash', script, 'windows-test'], {
            cwd: root,
            env: { ...process.env, RUNNER_TEMP: runnerTemp },
        })
        expect(result.exitCode).toBe(0)

        const varsFile = join(
            runnerTemp,
            'packer-vars-windows-test.pkrvars.hcl'
        )
        // POSIX permission bits do not exist on Windows: libuv synthesizes
        // stat.mode as 0666/0444 from the read-only attribute, so chmod 600
        // inside the script is not observable here. The mode contract only
        // applies on the POSIX CI runners where this script actually runs.
        if (process.platform !== 'win32') {
            expect(statSync(varsFile).mode & 0o777).toBe(0o600)
            expect(statSync(answerFile).mode & 0o777).toBe(0o600)
        }
        expect(readFileSync(varsFile, 'utf8')).toContain('winrm_password = ')
        expect(readFileSync(answerFile, 'utf8')).not.toContain(
            '__PACKER_ADMIN_PASSWORD__'
        )
    })
})
