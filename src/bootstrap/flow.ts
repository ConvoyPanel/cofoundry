import { chmod } from 'node:fs/promises'
import { confirm, input } from '@inquirer/prompts'
import pc from 'picocolors'
import { log } from '@/log.ts'
import type {
    BootstrapPlan as Plan,
    BootstrapStep as Step,
    ProbeResult,
} from '@/bootstrap/model.ts'
import { sshCapture, sshOk } from '@/bootstrap/remote.ts'
import { ALL_STEPS, stepToken } from '@/bootstrap/steps.ts'
import { detectBuildGateway } from '@/bootstrap/network.ts'
import { BUILD_NET_GATEWAY } from '@/build/buildnet.ts'
import type { PartialEnv } from '@/env.ts'

// ── .env updater ──────────────────────────────────────────────────────────────

const ENV_PATH = '.env'

export const formatSummaryTable = (
    rows: ReadonlyArray<readonly [label: string, value: string]>
): string[] => {
    const headings = ['Detail', 'Value'] as const
    const labelWidth = Math.max(
        headings[0].length,
        ...rows.map(([label]) => label.length)
    )
    const valueWidth = Math.max(
        headings[1].length,
        ...rows.map(([, value]) => value.length)
    )
    const border = (left: string, middle: string, right: string): string =>
        `  ${left}${'─'.repeat(labelWidth + 2)}${middle}${'─'.repeat(valueWidth + 2)}${right}`
    const row = (label: string, value: string): string =>
        `  │ ${label.padEnd(labelWidth)} │ ${value.padEnd(valueWidth)} │`
    return [
        border('┌', '┬', '┐'),
        row(...headings),
        border('├', '┼', '┤'),
        ...rows.map(([label, value]) => row(label, value)),
        border('└', '┴', '┘'),
    ]
}

/**
 * Apply `kvs` to the text of a .env file: replace a key in place, append a new
 * one, and drop a key whose value is `null`.
 */
export const applyEnvUpdates = (
    content: string,
    kvs: Record<string, string | null>
): string => {
    const lines = content === '' ? [] : content.split('\n')
    // Drop trailing empty line so we don't get a double newline.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const seen = new Set<string>()
    const output: string[] = []
    for (const line of lines) {
        const key = line.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1]
        if (key === undefined || !(key in kvs)) {
            output.push(line)
            continue
        }
        seen.add(key)
        const value = kvs[key]
        if (value !== null) output.push(`${key}=${value}`)
    }
    for (const [k, v] of Object.entries(kvs)) {
        if (!seen.has(k) && v !== null) output.push(`${k}=${v}`)
    }
    return output.join('\n') + '\n'
}

// .env holds PVE_TOKEN_SECRET -- a root@pam token with privilege separation
// off, i.e. root over the whole cluster API -- so it is owner-only, whatever
// the umask would have made it.
const upsertEnvFile = async (
    kvs: Record<string, string | null>
): Promise<void> => {
    const file = Bun.file(ENV_PATH)
    const content = (await file.exists()) ? await file.text() : ''
    await Bun.write(ENV_PATH, applyEnvUpdates(content, kvs))
    await chmod(ENV_PATH, 0o600)
}

// The cluster script is a per-TEMPLATE hook: it needs the sidecar, which names
// every image. Earlier bootstraps wired it as the per-IMAGE CF_UPLOAD_CMD,
// which handed it a bare .qcow2 and, being set in .env, also replaced the R2
// upload command -- so every upload failed. That exact value is removed.
export const CLUSTER_SIDECAR_CMD =
    'bash "$PVE_DUMP_DIR/cofoundry-work/scripts/cf-cluster-templates.sh" {{file}}'
export const LEGACY_CLUSTER_UPLOAD_CMD = `${CLUSTER_SIDECAR_CMD} {{sha256}}`

// ── interactive flow ──────────────────────────────────────────────────────────

export const runBootstrap = async (initialEnv: PartialEnv): Promise<void> => {
    if (!process.stdin.isTTY) {
        throw new Error(
            'cf bootstrap must run interactively (stdin is not a TTY). It is a one-time setup, not for CI.'
        )
    }

    // 1. SSH_TARGET
    let target = initialEnv.SSH_TARGET
    if (!target) {
        target = await input({
            message:
                'SSH target for the Proxmox node (e.g. root@pve.example.com)',
            validate: v => v.includes('@') || 'expected user@host',
        })
        log.step(`testing ssh ${target}`)
        const ok = await sshOk(target, 'true')
        if (!ok) {
            throw new Error(
                `ssh ${target} true failed — fix passwordless ssh first (ssh-copy-id), then re-run`
            )
        }
        const persist = await confirm({
            message: `write SSH_TARGET=${target} to .env?`,
            default: true,
        })
        if (persist) await upsertEnvFile({ SSH_TARGET: target })
    } else {
        const ok = await sshOk(target, 'true')
        if (!ok) {
            throw new Error(
                `ssh ${target} true failed — fix passwordless ssh first, then re-run`
            )
        }
    }

    // 2. Cluster: optionally turn each build into a clonable template on every
    // node (per-node VMID, local storage — no shared storage needed).
    const members = await sshCapture(
        target,
        `grep -c '"id":' /etc/pve/.members 2>/dev/null || echo 1`
    )
    const nodeCount = parseInt(members.stdout.trim(), 10) || 1
    if (nodeCount > 1) {
        if (process.env.CF_UPLOAD_CMD === LEGACY_CLUSTER_UPLOAD_CMD) {
            await upsertEnvFile({ CF_UPLOAD_CMD: null })
            delete process.env.CF_UPLOAD_CMD
            log.ok(
                'removed the cluster script from CF_UPLOAD_CMD in .env — it replaced the upload command and failed on every image'
            )
        }
        const existingSidecarCmd = process.env.CF_SIDECAR_UPLOAD_CMD
        if (existingSidecarCmd === CLUSTER_SIDECAR_CMD) {
            log.ok('cluster template distribution already enabled')
        } else if (existingSidecarCmd) {
            // Setting the hook in .env REPLACES the configured one. With R2
            // publishing that is the sidecar upload, and an R2 prefix full of
            // images with no sidecar is one prune run from being emptied.
            log.warn(
                `Cluster of ${nodeCount} nodes detected, but CF_SIDECAR_UPLOAD_CMD is already set, and the cluster template script would replace it:`
            )
            log.note(existingSidecarCmd)
            log.note(
                `To run both, set CF_SIDECAR_UPLOAD_CMD in .env to that command followed by: && ${CLUSTER_SIDECAR_CMD}`
            )
        } else {
            const clusterTemplates = await confirm({
                message: `Cluster of ${nodeCount} nodes detected — restore each build as a clonable template on every node (per-node VMID via scripts/cf-cluster-templates.sh)?`,
                default: false,
            })
            if (clusterTemplates) {
                // $PVE_DUMP_DIR is exported into the post-processor env by
                // buildPostProcEnv() in src/build/packer.ts, so this resolves
                // on the PVE node regardless of how PVE_DUMP_DIR is
                // configured. The sidecar carries every image's hash, so the
                // script verifies each node's copy without a {{sha256}}.
                await upsertEnvFile({
                    CF_SIDECAR_UPLOAD_CMD: CLUSTER_SIDECAR_CMD,
                })
                log.ok(
                    `cluster template distribution enabled — each build creates a clonable template on all ${nodeCount} nodes`
                )
            }
        }
    }

    const buildBridge = initialEnv.CF_BUILD_BRIDGE ?? 'vmbr1'
    const buildGateway =
        (await detectBuildGateway(target, buildBridge)) ?? BUILD_NET_GATEWAY

    // 3. Token name — ask only if no 'cofoundry' token exists yet.
    // Probe with default first; if it exists, no question.
    let tokenName = 'cofoundry'
    const tokenProbe = await stepToken.probe({
        target,
        tokenName,
        buildBridge,
        buildGateway,
        buildDns: initialEnv.CF_BUILD_DNS ?? '1.1.1.1',
    })
    if (!tokenProbe.done) {
        tokenName = await input({
            message: 'API token name',
            default: 'cofoundry',
        })
    }

    const plan: Plan = {
        target,
        tokenName,
        buildBridge,
        buildGateway,
        buildDns: initialEnv.CF_BUILD_DNS ?? '1.1.1.1',
    }

    // 4. Probe everything, build checklist
    log.step('probing node state')
    const probes: Array<{ step: Step; result: ProbeResult }> = []
    for (const step of ALL_STEPS) {
        const result = await step.probe(plan)
        probes.push({ step, result })
    }

    const summary = probes.flatMap(({ result }) => result.summary ?? [])
    if (summary.length > 0) {
        log.section('Configuration')
        for (const line of formatSummaryTable(summary)) log.raw(line)
        log.blank()
    }

    log.section('Plan')
    for (const { step, result } of probes) {
        const mark = result.done ? pc.green('✓') : pc.cyan('+')
        const status = result.done
            ? `${pc.dim('·')} already done${result.note ? ` ${pc.dim(`(${result.note})`)}` : ''}`
            : `${pc.dim('·')} will run${result.note ? ` ${pc.dim(`(${result.note})`)}` : ''}`
        log.raw(`  ${mark} ${step.label.padEnd(45)} ${status}`)
    }
    log.blank()

    const toApply = probes.filter(p => !p.result.done)
    if (toApply.length === 0) {
        log.ok('node is already fully configured — nothing to do')
        return
    }

    const go = await confirm({
        message: `Apply ${toApply.length} change${toApply.length === 1 ? '' : 's'}?`,
        default: true,
    })
    if (!go) {
        log.info('aborted, no changes made')
        return
    }

    // 5. Apply
    log.section('Apply')
    for (const { step, result } of probes) {
        if (result.done) {
            log.info(
                `${step.label} ${pc.dim('·')} ${result.note ?? 'already done'}`
            )
            continue
        }
        log.step(step.label)
        const out = await step.apply(plan)
        log.ok(`${step.label} ${pc.dim('·')} ${out.note ?? 'done'}`)
        // Proxmox reveals a token secret only once. Show and optionally persist
        // it immediately so a later bootstrap step cannot make it unrecoverable.
        if (out.secret && out.tokenId) {
            log.section(
                pc.yellow('API token created — SAVE THIS, shown only once')
            )
            log.reveal(`    ${pc.cyan('PVE_TOKEN_ID')}=${out.tokenId}`)
            log.reveal(`    ${pc.cyan('PVE_TOKEN_SECRET')}=${out.secret}`)
            log.blank()
            const persist = await confirm({
                message: 'append PVE_TOKEN_ID / PVE_TOKEN_SECRET to .env?',
                default: true,
            })
            if (persist) {
                await upsertEnvFile({
                    PVE_TOKEN_ID: out.tokenId,
                    PVE_TOKEN_SECRET: out.secret,
                })
                log.ok('wrote .env')
            }
        }
    }

    log.blank()
    log.ok('Bootstrap complete.')
}
