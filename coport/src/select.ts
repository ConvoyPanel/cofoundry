import type { Group, Registry, Template } from '../../src/registry/schema.ts'

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
 * like `1,3-5`, or a comma-separated list of template names.
 */
export const selectBySpec = (
    spec: string,
    registry: Registry,
    groupFilter?: string,
    tagFilter?: string
): Template[] => {
    const flat = flatten(collectGroups(registry, groupFilter, tagFilter))
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
    const result: Template[] = []
    for (const part of trimmed.split(',')) {
        const name = part.trim()
        if (!name) continue
        const t = byName.get(name)
        if (!t) throw new Error(`Unknown template: "${name}"`)
        result.push(t)
    }
    if (result.length === 0) throw new Error('Empty --select value.')
    return result
}
