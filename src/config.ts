import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_RECIPES_DIR = fileURLToPath(
    new URL('../recipes/', import.meta.url)
)

export interface RecipeInfo {
    name: string
    path: string
    /** Display name from `# display: ...` comment */
    display: string
    /** VMID from `# build_vmid: <n>` comment */
    buildVmid?: number
    /** RAM assigned to the Packer build VM, parsed from `memory = <MiB>`. */
    buildMemoryMb?: number
    /** Virtual cores assigned to the Packer build VM. */
    buildCores?: number
    /** ISO URL parsed from `# iso_url: ...` metadata or the boot ISO block */
    isoUrl?: string
    /** Resolved local path for the boot ISO on the Proxmox node */
    isoTargetPath?: string
    /** URL of the distro's published checksum file (e.g. CHECKSUM, SHA256SUMS) */
    isoChecksumUrl?: string
    /** Regex string matching the ISO filename inside the checksum file */
    isoFilenameRe?: string
    /** Architecture tag from `# arch: ...` comment; defaults to "amd64" */
    arch: string
    /** Group id from `# group: ...` comment */
    group?: string
    /**
     * Final exported disk size from `# final_disk_size: <size>` (e.g. "32G").
     * When set, the recipe's HCL `disk_size` is the larger *build-time* disk and
     * the post-processor shrinks the disk to this size before the export. Absent
     * = no shrink (build disk == final disk), preserving existing behavior.
     */
    finalDiskSize?: string
    /**
     * Runtime floor published in the sidecar's `minimum` block, from
     * `# min_cores:` / `# min_memory:` (MiB). Deliberately hand-authored rather
     * than captured: `buildCores`/`buildMemoryMb` are servicing headroom (8192
     * MiB on Windows for the WU rounds), not a requirement, and publishing them
     * would floor every consumer plan at the build's shape.
     *
     * There is no matching disk floor — `import-from` gives the imported disk
     * the source's virtual size and `qm disk resize` cannot shrink, so
     * `disks[0].virtual_size` already enforces it. See docs/disk-images.md.
     */
    minCores?: number
    minMemoryMb?: number
}

const parseMeta = (raw: string, key: string): string | undefined => {
    const m = raw.match(new RegExp(`^#\\s*${key}\\s*:\\s*(.+)$`, 'm'))
    return m?.[1]?.trim()
}

const parseMetaInt = (raw: string, key: string): number | undefined => {
    const v = parseMeta(raw, key)
    if (!v) return undefined
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : undefined
}

const parseHclInt = (raw: string, key: string): number | undefined => {
    const match = raw.match(
        new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*(?:#.*)?$`, 'm')
    )
    if (!match?.[1]) return undefined
    const value = Number.parseInt(match[1], 10)
    return Number.isFinite(value) ? value : undefined
}

const parseIsoUrl = (raw: string): string | undefined => {
    const meta = parseMeta(raw, 'iso_url')
    if (meta) return meta
    const m = raw.match(/^\s*iso_url\s*=\s*"([^"]+)"/m)
    return m?.[1]
}

// Parse all variable default values from the HCL file.
const parseVarDefaults = (raw: string): Record<string, string> => {
    const vars: Record<string, string> = {}
    const blockRe = /variable\s+"([^"]+)"\s*\{([^}]+)}/g
    let m: RegExpExecArray | null
    while ((m = blockRe.exec(raw)) !== null) {
        const defMatch = m[2]!.match(/default\s*=\s*"([^"]*)"/)
        if (defMatch) vars[m[1]!] = defMatch[1]!
    }
    return vars
}

// Expand ${var.name} references using the parsed defaults.
const resolveVarRefs = (value: string, vars: Record<string, string>): string =>
    value.replace(
        /\${var\.([^}]+)}/g,
        (orig, name: string) => vars[name] ?? orig
    )

const parseIsoTargetPath = (raw: string): string | undefined => {
    const meta = parseMeta(raw, 'iso_target_path')
    if (meta) return resolveVarRefs(meta, parseVarDefaults(raw))

    // Only parse the first iso_target_path (the boot ISO, not additional ISOs like VirtIO).
    const m = raw.match(/^\s*iso_target_path\s*=\s*"([^"]+)"/m)
    if (!m) return undefined
    return resolveVarRefs(m[1]!, parseVarDefaults(raw))
}

export const loadRecipe = async (
    name: string,
    recipesDir: string = DEFAULT_RECIPES_DIR
): Promise<RecipeInfo> => {
    const path = join(recipesDir, `${name}.pkr.hcl`)
    const raw = await readFile(path, 'utf8')
    return {
        name,
        path,
        display: parseMeta(raw, 'display') ?? name,
        buildVmid: parseMetaInt(raw, 'build_vmid'),
        buildMemoryMb: parseHclInt(raw, 'memory'),
        buildCores: parseHclInt(raw, 'cores'),
        isoUrl: parseIsoUrl(raw),
        isoTargetPath: parseIsoTargetPath(raw),
        isoChecksumUrl: parseMeta(raw, 'iso_checksum_url'),
        isoFilenameRe: parseMeta(raw, 'iso_filename_re'),
        arch: parseMeta(raw, 'arch') ?? 'amd64',
        group: parseMeta(raw, 'group'),
        finalDiskSize: parseMeta(raw, 'final_disk_size'),
        minCores: parseMetaInt(raw, 'min_cores'),
        minMemoryMb: parseMetaInt(raw, 'min_memory'),
    }
}

export const listRecipes = async (
    recipesDir: string = DEFAULT_RECIPES_DIR
): Promise<RecipeInfo[]> => {
    const entries = await readdir(recipesDir)
    const recipes: RecipeInfo[] = []
    for (const entry of entries) {
        if (!entry.endsWith('.pkr.hcl')) continue
        const name = basename(entry, '.pkr.hcl')
        recipes.push(await loadRecipe(name, recipesDir))
    }
    return recipes.sort((a, b) => a.name.localeCompare(b.name))
}
