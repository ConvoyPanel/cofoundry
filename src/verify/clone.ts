import { execa } from 'execa'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addSensitiveValues, shellQuote } from '@/util.ts'
import { captureRemote } from '@/build/remote.ts'
import { remotePaths } from '@/build/paths.ts'
import type { Env } from '@/env.ts'
import type { CheckContext } from '@/verify/checks/types.ts'

/**
 * Extra space added to the restored disk before first boot.
 *
 * The root-growth check asserts the guest filesystem reached at least the
 * *shipped* disk size. That is unreachable without a successful grow (a root
 * filesystem is always smaller than the disk it sits on, and smaller still once
 * an ESP and any swap are subtracted) and comfortably reachable with one, as
 * long as this headroom exceeds that non-root overhead. No fraction to tune.
 */
const GROW_GB = 4

const UNITS: Record<string, number> = {
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
}

/** Parse a Proxmox disk size (`size=32G`) into bytes. */
export const parseDiskSize = (raw: string): number | null => {
    const m = raw.match(/size=(\d+(?:\.\d+)?)([KMGT])?/)
    if (!m) return null
    return Math.round(Number.parseFloat(m[1]!) * (UNITS[m[2] ?? ''] ?? 1))
}

/**
 * Windows truncates the NetBIOS name to 15 characters and uppercases it, so the
 * sentinel stays short enough to survive both guests unchanged.
 */
export const sentinelHostname = (): string =>
    `cfv-${randomBytes(3).toString('hex')}`

/**
 * Windows enforces password complexity, and a password that fails it leaves the
 * account unusable without any obvious error — so compose from all four classes
 * explicitly rather than sampling one alphabet.
 */
export const sentinelPassword = (): string => {
    const pick = (set: string, n: number): string =>
        Array.from(randomBytes(n), b => set[b % set.length]).join('')
    const parts =
        pick('ABCDEFGHJKLMNPQRSTUVWXYZ', 6) +
        pick('abcdefghijkmnpqrstuvwxyz', 6) +
        pick('23456789', 4) +
        pick('!@#%^*-_=+', 4)
    // Shuffle so the class layout is not positionally predictable.
    const chars = parts.split('')
    for (let i = chars.length - 1; i > 0; i--) {
        const j = randomBytes(1)[0]! % (i + 1)
        ;[chars[i], chars[j]] = [chars[j]!, chars[i]!]
    }
    return chars.join('')
}

/**
 * Every caller-supplied value is attached with `--opt=value`: the sentinel
 * password samples `-` as a legal character, and a value that starts with `-`
 * is parsed by Proxmox's Getopt-based CLI as an option name — `qm set` then
 * rejects the whole command with "Unknown option: <password minus its dash>".
 * The fixed literals (`ip=dhcp`, `enabled=1`) can never start with `-`, so
 * their space form is safe either way.
 */
export const cloudInitSetCommand = (
    vmid: number,
    hostname: string,
    ciUser: string,
    password: string,
    remoteKeyPath: string
): string =>
    `qm set ${vmid} --name=${shellQuote(hostname)} ` +
    `--ciuser=${shellQuote(ciUser)} --cipassword=${shellQuote(password)} ` +
    `--sshkeys=${shellQuote(remoteKeyPath)} --ipconfig0 ip=dhcp --agent enabled=1`

export interface CloudInitSetup {
    ctx: CheckContext
    /** Removes the local temp dir holding the generated private key. */
    cleanup: () => Promise<void>
}

const generateKeypair = async (): Promise<{
    dir: string
    publicKey: string
}> => {
    const dir = await mkdtemp(join(tmpdir(), 'cf-verify-key-'))
    await execa('ssh-keygen', [
        '-t',
        'ed25519',
        '-N',
        '',
        '-C',
        'cofoundry-verify',
        '-f',
        join(dir, 'id'),
    ])
    return {
        dir,
        publicKey: (await readFile(join(dir, 'id.pub'), 'utf8')).trim(),
    }
}

/**
 * Best-effort recovery of the build's Windows admin password from the node's
 * Packer vars file, so the plaintext-leak check can grep for the exact value
 * instead of falling back to a structural assertion. The vars file is written
 * per build and may already be gone; absence is not an error.
 */
const findBuildPassword = async (
    env: Env,
    recipeName: string
): Promise<string | undefined> => {
    const paths = remotePaths(env)
    const raw = await captureRemote(
        env.SSH_TARGET,
        `grep -rhs winrm_password ${shellQuote(paths.work)} ${shellQuote(paths.tmp)} ` +
            `--include=${shellQuote(`*${recipeName}*`)} --include='*.pkrvars.hcl' ` +
            `2>/dev/null | head -1 || true`
    ).catch(() => '')
    const match = raw.match(/winrm_password\s*=\s*"([^"]+)"/)
    if (!match?.[1]) return undefined
    addSensitiveValues(match[1])
    return match[1]
}

/**
 * Configure the restored VM the way a user's clone is configured, then hand the
 * sentinel values to the checks. Booting the template untouched — as verify did
 * before — leaves the cloud-init drive empty, so nothing cloud-init is supposed
 * to apply is ever exercised.
 */
export const prepareCloudInit = async (
    env: Env,
    recipeName: string,
    vmid: number,
    remoteTmp: string,
    isWindows: boolean
): Promise<CloudInitSetup> => {
    const hostname = sentinelHostname()
    const password = sentinelPassword()
    addSensitiveValues(password)
    // Windows: Cloudbase-Init sets the password on the built-in Administrator.
    // Linux: a distinct user proves cloud-init created it rather than that the
    // image shipped it.
    const ciUser = isWindows ? 'Administrator' : 'cfverify'

    const { dir, publicKey } = await generateKeypair()
    const remoteKey = `${remoteTmp}/verify.pub`
    await captureRemote(
        env.SSH_TARGET,
        `cat > ${shellQuote(remoteKey)} <<'__CF_VERIFY_KEY__'\n${publicKey}\n__CF_VERIFY_KEY__`
    )

    const config = await captureRemote(env.SSH_TARGET, `qm config ${vmid}`)
    const scsi0 = config.split('\n').find(l => l.startsWith('scsi0:')) ?? ''
    const shippedBytes = parseDiskSize(scsi0)
    if (!shippedBytes)
        throw new Error(
            `could not read scsi0 disk size from: ${scsi0 || '<missing>'}`
        )

    await captureRemote(env.SSH_TARGET, `qm resize ${vmid} scsi0 +${GROW_GB}G`)

    // --cipassword lands in the node's process list for the life of the call.
    // Acceptable here: the value is generated per run, used only by a scratch VM
    // that is destroyed minutes later, and never reused.
    await captureRemote(
        env.SSH_TARGET,
        cloudInitSetCommand(vmid, hostname, ciUser, password, remoteKey)
    )

    return {
        ctx: {
            hostname,
            ciUser,
            ciPassword: password,
            sshPublicKey: publicKey,
            minRootBytes: shippedBytes,
            buildPassword: isWindows
                ? await findBuildPassword(env, recipeName)
                : undefined,
        },
        cleanup: () => rm(dir, { recursive: true, force: true }),
    }
}

/**
 * Arm a one-shot autologon so a desktop session actually exists on the next
 * boot. Without a logon the Windows shell never starts, and the whole class of
 * "boots fine, desktop is unusable" defects stays invisible — which is exactly
 * how the ShellHost crash reached published templates.
 */
export const autologonScript = (user: string, password: string): string =>
    `$k = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
Set-ItemProperty $k -Name AutoAdminLogon -Value '1' -Type String
Set-ItemProperty $k -Name DefaultUserName -Value '${user}' -Type String
Set-ItemProperty $k -Name DefaultPassword -Value '${password.replace(/'/g, "''")}' -Type String
Set-ItemProperty $k -Name AutoLogonCount -Value 1 -Type DWord`
