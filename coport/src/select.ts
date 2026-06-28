import type { Group, Registry, Template } from '@/registry/schema.ts'

export interface GroupedTemplates {
    group: Group
    templates: Template[]
}

/** Templates grouped by family, after applying --group / --filter. */
export const collectGroups = (
    registry: Registry,
    groupFilter?: string,
    tagFilter?: string
): GroupedTemplates[] => {
    const groups = groupFilter
        ? registry.groups.filter(g => g.id === groupFilter)
        : registry.groups

    const out: GroupedTemplates[] = []
    for (const group of groups) {
        const templates = group.templates.filter(
            t => !tagFilter || t.tags?.includes(tagFilter)
        )
        if (templates.length > 0) out.push({ group, templates })
    }
    return out
}

export const flatten = (grouped: GroupedTemplates[]): Template[] =>
    grouped.flatMap(g => g.templates)

/** Parse `1,3-5` style index selections against a 1-based list of `max` items. */
export const parseRanges = (input: string, max: number): number[] => {
    const indices = new Set<number>()
    for (const part of input.split(',')) {
        const range = part.trim().match(/^(\d+)(?:-(\d+))?$/)
        if (!range) throw new Error(`Invalid selection: "${part.trim()}"`)
        const start = Number(range[1])
        const end = range[2] ? Number(range[2]) : start
        for (let n = start; n <= end; n++) {
            if (n < 1 || n > max) throw new Error(`Index out of range: ${n}`)
            indices.add(n)
        }
    }
    return [...indices].sort((a, b) => a - b)
}

/**
 * Non-interactive selection for `--select <spec>`. Accepts `all`, index ranges
 * like `1,3-5`, or a comma-separated list of template names and/or group ids
 * (a group id expands to every template in that family).
 */
export const selectBySpec = (
    spec: string,
    registry: Registry,
    groupFilter?: string,
    tagFilter?: string
): Template[] => {
    const grouped = collectGroups(registry, groupFilter, tagFilter)
    const flat = flatten(grouped)
    if (flat.length === 0) {
        throw new Error('No templates match the given filters.')
    }

    const trimmed = spec.trim()
    if (!trimmed) throw new Error('Empty --select value.')
    if (trimmed.toLowerCase() === 'all') return flat

    if (/^[\d,\s-]+$/.test(trimmed)) {
        return parseRanges(trimmed, flat.length).map(i => flat[i - 1]!)
    }

    const byName = new Map(flat.map(t => [t.name, t]))
    // A token may name a whole group, by id or display name.
    const byGroup = new Map<string, Template[]>()
    for (const { group, templates } of grouped) {
        byGroup.set(group.id, templates)
        byGroup.set(group.display_name, templates)
    }

    // Dedupe so `--select ubuntu,ubuntu-22.04` yields each template once.
    const seen = new Set<string>()
    const result: Template[] = []
    const add = (t: Template): void => {
        if (seen.has(t.name)) return
        seen.add(t.name)
        result.push(t)
    }

    for (const part of trimmed.split(',')) {
        const token = part.trim()
        if (!token) continue
        const groupTemplates = byGroup.get(token)
        if (groupTemplates) {
            groupTemplates.forEach(add)
            continue
        }
        const t = byName.get(token)
        if (!t) throw new Error(`Unknown template or group: "${token}"`)
        add(t)
    }
    if (result.length === 0) throw new Error('Empty --select value.')
    return result
}
