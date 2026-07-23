import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import PQueue from 'p-queue'
import pRetry from 'p-retry'
import SftpClient from 'ssh2-sftp-client'
import {
    openProxyCommandSock,
    resolveProxyCommand,
} from '@/build/sftp/proxy.ts'

export type SshTarget = { user: string; host: string; port: number }

export const parseSshTarget = (target: string): SshTarget => {
    const at = target.lastIndexOf('@')
    if (at === -1)
        throw new Error(`Invalid SSH_TARGET "${target}": expected user@host`)
    const user = target.slice(0, at)
    const hostPart = target.slice(at + 1)
    if (hostPart.startsWith('[')) {
        const close = hostPart.indexOf(']')
        if (close === -1)
            throw new Error(`Invalid SSH_TARGET "${target}": bad IPv6 host`)
        const host = hostPart.slice(1, close)
        const suffix = hostPart.slice(close + 1)
        if (suffix === '') return { user, host, port: 22 }
        if (!suffix.startsWith(':'))
            throw new Error(`Invalid SSH_TARGET "${target}": bad port`)
        const port = Number.parseInt(suffix.slice(1), 10)
        if (!Number.isInteger(port) || port < 1)
            throw new Error(`Invalid SSH_TARGET "${target}": bad port`)
        return { user, host, port }
    }
    const colon = hostPart.indexOf(':')
    if (colon === -1 || colon !== hostPart.lastIndexOf(':'))
        return { user, host: hostPart, port: 22 }
    const port = Number.parseInt(hostPart.slice(colon + 1), 10)
    if (!Number.isInteger(port) || port < 1)
        throw new Error(`Invalid SSH_TARGET "${target}": bad port`)
    return { user, host: hostPart.slice(0, colon), port }
}

const DEFAULT_KEYS = ['id_ed25519', 'id_rsa', 'id_ecdsa'].map(key =>
    join(homedir(), '.ssh', key)
)

const connectOnce = async (target: string): Promise<SftpClient> => {
    const { user, host, port } = parseSshTarget(target)
    const config: Record<string, unknown> = { host, port, username: user }
    if (process.env.SSH_AUTH_SOCK) config.agent = process.env.SSH_AUTH_SOCK
    else {
        const keyFile = DEFAULT_KEYS.find(existsSync)
        if (keyFile) config.privateKey = await readFile(keyFile)
        else config.authHandler = ['none']
    }

    // Reach the node the same way every `execa('ssh', …)` call does: through the
    // ProxyCommand from ~/.ssh/config, when one applies. ssh2 handshakes over
    // the supplied socket instead of dialling host:port itself, so tailnet/
    // SOCKS/bastion setups work here as they do for the rest of the tool. No
    // ProxyCommand (the CI case) means a plain direct connect, as before.
    const proxyCommand = await resolveProxyCommand(host, port)
    const proxied = proxyCommand ? openProxyCommandSock(proxyCommand) : null
    if (proxied) config.sock = proxied.sock

    const client = new SftpClient()
    // Tear the ProxyCommand child down whenever the connection ends — whether it
    // closes cleanly, errors, or the handshake below never completes.
    if (proxied) {
        client.on('close', proxied.cleanup)
        client.on('end', proxied.cleanup)
    }
    try {
        await client.connect(config as Parameters<SftpClient['connect']>[0])
    } catch (err) {
        proxied?.cleanup()
        throw err
    }
    return client
}

export const connectSftp = (target: string): Promise<SftpClient> =>
    pRetry(() => connectOnce(target), {
        retries: 3,
        minTimeout: 500,
        factor: 2,
    })

export const withSftpPool = async <T>(
    target: string,
    size: number,
    run: (clients: SftpClient[], queue: PQueue) => Promise<T>
): Promise<T> => {
    const clients = await Promise.all(
        Array.from({ length: size }, () => connectSftp(target))
    )
    const queue = new PQueue({ concurrency: size })
    try {
        return await run(clients, queue)
    } finally {
        await Promise.all(clients.map(client => client.end().catch(() => {})))
    }
}
