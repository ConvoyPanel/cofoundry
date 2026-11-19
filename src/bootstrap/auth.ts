import { addSensitiveValues, shellQuote } from '@/util.ts'
import type { BootstrapStep } from '@/bootstrap/model.ts'
import { sshCapture } from '@/bootstrap/remote.ts'

export const stepToken: BootstrapStep = {
    id: 'token',
    label: 'create API token',
    probe: async plan => {
        const r = await sshCapture(
            plan.target,
            `pveum user token list root@pam --output-format json 2>/dev/null`
        )
        if (!r.ok) return { done: false }
        let tokens: Array<{ tokenid?: string }> = []
        try {
            tokens = JSON.parse(r.stdout || '[]')
        } catch {
            return { done: false }
        }
        const exists = tokens.some(t => t.tokenid === plan.tokenName)
        return exists
            ? { done: true, note: `root@pam!${plan.tokenName} already exists` }
            : { done: false }
    },
    apply: async plan => {
        const r = await sshCapture(
            plan.target,
            `pveum user token add root@pam ${shellQuote(plan.tokenName)} --privsep=0 --output-format json`
        )
        if (!r.ok) {
            throw new Error(
                `pveum user token add failed: ${r.stderr || r.stdout}`
            )
        }
        let parsed: { 'value'?: string; 'full-tokenid'?: string } = {}
        try {
            parsed = JSON.parse(r.stdout)
        } catch {
            // The output is withheld: the token was just created, so it may
            // well carry the secret, and the secret is not yet known to
            // redactSensitive (it is registered only after parsing).
            throw new Error(
                `could not parse pveum output as JSON (${r.stdout.length} bytes, withheld: it may contain the new token secret). ` +
                    `The token root@pam!${plan.tokenName} may exist now; remove it with \`pveum user token remove root@pam ${plan.tokenName}\` before re-running.`
            )
        }
        const secret = parsed.value
        const tokenId = parsed['full-tokenid'] ?? `root@pam!${plan.tokenName}`
        if (!secret) throw new Error('pveum returned no token value')
        addSensitiveValues(secret)
        return {
            secret,
            tokenId,
            note: `created ${tokenId}`,
        }
    },
}
