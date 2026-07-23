import { spawn } from 'node:child_process'
import { Duplex } from 'node:stream'
import { execa } from 'execa'

/**
 * SFTP is the one transport `cf` does not delegate to the `ssh` binary — it runs
 * in-process over `ssh2`, which ignores `~/.ssh/config` entirely. Every other
 * remote call (`execa('ssh', …)`) inherits the user's ProxyCommand, jump hosts,
 * and bastions for free; this module gives the SFTP path the same reach so a
 * build can run from behind a tailnet/SOCKS/bastion where a direct TCP connect
 * to the node is impossible. On a plain host (CI) no ProxyCommand resolves and
 * the SFTP client connects directly, exactly as before.
 */

// Expand the ssh(1) ProxyCommand tokens we substitute ourselves. %h/%p are the
// host/port ssh2 is about to connect to; %% is a literal percent. Other tokens
// (%r, %C, …) are rare in a ProxyCommand and left untouched.
const substituteTokens = (
    command: string,
    host: string,
    port: number
): string =>
    command.replace(/%[%hp]/g, token =>
        token === '%%' ? '%' : token === '%h' ? host : String(port)
    )

/**
 * Extract an effective ProxyCommand from `ssh -G <host>` output. Returns the
 * token-substituted command, or null when the host has no ProxyCommand (or an
 * explicit `none`, ssh's way of clearing an inherited one).
 */
export const parseProxyCommand = (
    sshConfigDump: string,
    host: string,
    port: number
): string | null => {
    for (const line of sshConfigDump.split('\n')) {
        const match = /^proxycommand\s+(.*)$/i.exec(line.trim())
        if (!match) continue
        const raw = match[1]!.trim()
        if (raw === '' || raw.toLowerCase() === 'none') return null
        return substituteTokens(raw, host, port)
    }
    return null
}

// Resolution is per host:port and stable for a process, so memoize it: a
// download pool opens several connections at once and each would otherwise
// re-run `ssh -G`.
const cache = new Map<string, string | null>()

/**
 * Determine the ProxyCommand to reach host:port, or null for a direct connect.
 * `CF_SSH_PROXYCOMMAND` overrides detection (set it to `none` to force a direct
 * connect); otherwise the effective ProxyCommand from `~/.ssh/config` is used.
 */
export const resolveProxyCommand = async (
    host: string,
    port: number
): Promise<string | null> => {
    const key = `${host}:${port}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached

    let result: string | null = null
    const override = process.env.CF_SSH_PROXYCOMMAND
    if (override !== undefined) {
        result =
            override.trim() === '' || override.trim().toLowerCase() === 'none'
                ? null
                : substituteTokens(override, host, port)
    } else {
        try {
            const { stdout } = await execa('ssh', ['-G', host], {
                stdin: 'ignore',
                stderr: 'ignore',
                reject: false,
            })
            result = parseProxyCommand(stdout, host, port)
        } catch {
            result = null
        }
    }
    cache.set(key, result)
    return result
}

export type ProxySock = { sock: Duplex; cleanup: () => void }

/**
 * Run a ProxyCommand and expose its stdio as a Duplex for `ssh2`'s `sock`
 * option: ssh2 runs its handshake over this stream instead of opening its own
 * TCP socket. The child is killed via `cleanup` once the connection ends.
 */
export const openProxyCommandSock = (command: string): ProxySock => {
    const child = spawn('sh', ['-c', command], {
        stdio: ['pipe', 'pipe', 'ignore'],
    })
    // Never let a ProxyCommand failure crash the process: ssh2 surfaces it as a
    // handshake error on the dead stream, which the connect retry handles.
    child.on('error', () => {})
    const sock = Duplex.from({
        readable: child.stdout!,
        writable: child.stdin!,
    })
    return {
        sock,
        cleanup: () => {
            child.kill('SIGTERM')
        },
    }
}
