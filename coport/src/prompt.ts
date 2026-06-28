import * as clack from '@clack/prompts'
import pc from 'picocolors'
import type { Registry, Template } from '@/registry/schema.ts'
import type { VmidAssignment } from './vmid.ts'
import { vmidTaken } from './vmid.ts'
import { collectGroups } from './select.ts'

// main.ts imports this module dynamically, so clack is only loaded for runs that
// actually prompt (interactive selection / VMID review), not for --all/--select.

/** Unwrap a clack result, exiting cleanly if the user cancelled (Esc/Ctrl-C). */
const orCancel = <T>(value: T | symbol): T => {
    if (clack.isCancel(value)) {
        clack.cancel('Aborted.')
        process.exit(130)
    }
    return value
}

export const promptStorage = async (): Promise<string> => {
    const answer = orCancel(
        await clack.text({
            message: 'Proxmox storage volume',
            placeholder: 'local-zfs',
            validate: value =>
                value.trim() ? undefined : 'Storage volume is required.',
        })
    )
    return answer.trim()
}

export const promptTemplateSelection = async (
    registry: Registry,
    groupFilter?: string,
    tagFilter?: string
): Promise<Template[]> => {
    const grouped = collectGroups(registry, groupFilter, tagFilter)
    if (grouped.length === 0) {
        throw new Error('No templates match the given filters.')
    }

    const options: Record<
        string,
        { value: Template; label: string; hint?: string }[]
    > = {}
    for (const { group, templates } of grouped) {
        options[group.display_name] = templates.map(t => ({
            value: t,
            label: t.display,
            hint: t.arch,
        }))
    }

    // Loop so an empty selection re-prompts instead of silently installing nothing.
    for (;;) {
        const selected = orCancel(
            await clack.groupMultiselect<Template>({
                message: 'Select templates to install',
                options,
                required: false,
                selectableGroups: true,
            })
        )
        if (selected.length > 0) return selected
        clack.log.warn(
            'Select at least one template (space toggles, a group header toggles its family).'
        )
    }
}

const assignmentHint = (a: VmidAssignment): string => {
    if (a.overwrite) return pc.red('overwrite existing')
    if (a.conflict) {
        const suggested = a.template.suggested_vmid
        return pc.yellow(
            suggested
                ? `reassigned · suggested ${suggested} taken`
                : 'auto-assigned'
        )
    }
    return pc.dim('suggested')
}

const renderTable = (assignments: VmidAssignment[]): string => {
    const nameWidth = Math.max(
        ...assignments.map(a => a.template.display.length)
    )
    return assignments
        .map(
            a =>
                `${a.template.display.padEnd(nameWidth)}  ${pc.dim('→')} VMID ${pc.bold(
                    String(a.vmid)
                )}  ${assignmentHint(a)}`
        )
        .join('\n')
}

/** Re-validate a user-entered VMID: positive integer, free, not already used. */
const validateVmid = async (
    raw: string,
    used: Set<number>
): Promise<{ vmid: number } | { error: string }> => {
    if (!/^\d+$/.test(raw.trim())) return { error: 'Enter a positive integer.' }
    const vmid = Number(raw.trim())
    if (vmid < 100) return { error: 'VMID must be ≥ 100.' }
    if (used.has(vmid))
        return { error: `VMID ${vmid} is already in this batch.` }
    if (await vmidTaken(vmid))
        return { error: `VMID ${vmid} is already in use.` }
    return { vmid }
}

const pickAssignment = async (
    assignments: VmidAssignment[],
    message: string
): Promise<number | undefined> => {
    const choice = await clack.select<number>({
        message,
        options: assignments.map((a, i) => ({
            value: i,
            label: a.template.display,
            hint: `VMID ${a.vmid}`,
        })),
    })
    if (clack.isCancel(choice)) return undefined
    return choice
}

/**
 * Review the VMID plan before install. Returns the (possibly edited/trimmed) list,
 * or null if the user cancels. Offers Proceed / Edit a VMID / Skip a template.
 */
export const reviewAssignments = async (
    assignments: VmidAssignment[]
): Promise<VmidAssignment[] | null> => {
    let current = [...assignments]

    for (;;) {
        clack.note(renderTable(current), 'VMID assignments')

        const action = await clack.select<
            'proceed' | 'edit' | 'skip' | 'cancel'
        >({
            message: 'Proceed with these VMIDs?',
            options: [
                { value: 'proceed', label: 'Proceed', hint: 'install now' },
                { value: 'edit', label: 'Edit a VMID' },
                { value: 'skip', label: 'Skip a template' },
                { value: 'cancel', label: 'Cancel' },
            ],
        })
        if (clack.isCancel(action) || action === 'cancel') return null
        if (action === 'proceed') return current

        if (action === 'edit') {
            const idx = await pickAssignment(current, 'Edit which template?')
            if (idx === undefined) continue
            const used = new Set(
                current.filter((_, i) => i !== idx).map(a => a.vmid)
            )
            const raw = await clack.text({
                message: `New VMID for ${current[idx]!.template.display}`,
                placeholder: String(current[idx]!.vmid),
                validate: value =>
                    /^\d+$/.test(value.trim())
                        ? undefined
                        : 'Enter a positive integer.',
            })
            if (clack.isCancel(raw)) continue
            const result = await validateVmid(raw, used)
            if ('error' in result) {
                clack.log.error(result.error)
                continue
            }
            current = current.map((a, i) =>
                i === idx
                    ? {
                          ...a,
                          vmid: result.vmid,
                          conflict: false,
                          overwrite: false,
                      }
                    : a
            )
            continue
        }

        // action === 'skip'
        const idx = await pickAssignment(current, 'Skip which template?')
        if (idx === undefined) continue
        current = current.filter((_, i) => i !== idx)
        if (current.length === 0) {
            clack.log.warn('All templates skipped.')
            return []
        }
    }
}
