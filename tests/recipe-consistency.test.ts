import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Cross-recipe invariants over the committed recipes/*.pkr.hcl files and their
// installer payloads. Runs entirely offline; no Proxmox node access required.

const recipesDir = fileURLToPath(new URL('../recipes/', import.meta.url))

interface Recipe {
    name: string
    raw: string
}

const recipes: Recipe[] = readdirSync(recipesDir)
    .filter(entry => entry.endsWith('.pkr.hcl'))
    .sort()
    .map(entry => ({
        name: basename(entry, '.pkr.hcl'),
        raw: readFileSync(join(recipesDir, entry), 'utf8'),
    }))

const headerVmid = (recipe: Recipe): number | undefined => {
    const m = recipe.raw.match(/^#\s*build_vmid:\s*(\d+)\s*$/m)
    return m ? Number.parseInt(m[1]!, 10) : undefined
}

const variableVmidDefault = (recipe: Recipe): number | undefined => {
    const m = recipe.raw.match(
        /variable\s+"build_vmid"\s*\{[^}]*?default\s*=\s*(\d+)/
    )
    return m ? Number.parseInt(m[1]!, 10) : undefined
}

const groupOf = (recipe: Recipe): string | undefined =>
    recipe.raw.match(/^#\s*group:\s*(\S+)\s*$/m)?.[1]

const bootCommand = (recipe: Recipe): string | undefined =>
    // Boot command entries are quoted strings, so the array cannot contain a
    // literal "]" before its closing bracket.
    recipe.raw.match(/boot_command\s*=\s*\[([\s\S]*?)\]/)?.[1]

const normalizeEol = (content: string): string => content.replace(/\r\n/g, '\n')

const firstDifference = (a: string, b: string): string => {
    const aLines = a.split('\n')
    const bLines = b.split('\n')
    const max = Math.max(aLines.length, bLines.length)
    for (let i = 0; i < max; i++) {
        if (aLines[i] !== bLines[i]) {
            return `first difference at line ${i + 1}: ${JSON.stringify(
                aLines[i] ?? '<missing>'
            )} vs ${JSON.stringify(bLines[i] ?? '<missing>')}`
        }
    }
    return 'contents differ'
}

describe('recipe consistency', () => {
    test('recipes directory is discovered', () => {
        expect(recipes.length).toBeGreaterThan(0)
    })

    test('every recipe declares a unique build VMID', () => {
        const violations: string[] = []
        const byVmid = new Map<number, string[]>()
        for (const recipe of recipes) {
            const vmid = headerVmid(recipe)
            if (vmid === undefined) {
                violations.push(
                    `${recipe.name}: missing "# build_vmid: <n>" header comment`
                )
                continue
            }
            byVmid.set(vmid, [...(byVmid.get(vmid) ?? []), recipe.name])
        }
        for (const [vmid, names] of byVmid) {
            if (names.length > 1) {
                violations.push(
                    `build_vmid ${vmid} is shared by ${names.join(', ')} — VMIDs must be unique across recipes`
                )
            }
        }
        expect(violations).toEqual([])
    })

    test('build_vmid header matches the HCL variable default', () => {
        const violations: string[] = []
        for (const recipe of recipes) {
            const header = headerVmid(recipe)
            const hclDefault = variableVmidDefault(recipe)
            if (header !== hclDefault) {
                violations.push(
                    `${recipe.name}: "# build_vmid: ${header}" header disagrees with variable "build_vmid" default = ${hclDefault}`
                )
            }
        }
        expect(violations).toEqual([])
    })

    test('http_directory uses the recipe_name idiom, never a hard-coded name', () => {
        const idiom = '"${path.root}/${local.recipe_name}/http"'
        const violations: string[] = []
        for (const recipe of recipes) {
            const m = recipe.raw.match(/^\s*http_directory\s*=\s*(.+?)\s*$/m)
            if (!m) continue
            if (m[1] !== idiom) {
                violations.push(
                    `${recipe.name}: http_directory = ${m[1]} — expected ${idiom}`
                )
            }
        }
        expect(violations).toEqual([])
    })

    test('recipes that type network config in boot_command keep boot_key_interval = "100ms"', () => {
        // Without a keystroke interval, Proxmox's QEMU sendkey path drops
        // characters and corrupts the typed network settings; see
        // docs/recipes.md#ubuntu-autoinstall.
        const violations: string[] = []
        for (const recipe of recipes) {
            const cmd = bootCommand(recipe)
            if (!cmd) continue
            if (!/\bip=|netcfg\//.test(cmd)) continue
            if (!/^\s*boot_key_interval\s*=\s*"100ms"\s*$/m.test(recipe.raw)) {
                violations.push(
                    `${recipe.name}: boot_command types network configuration but boot_key_interval = "100ms" is missing`
                )
            }
        }
        expect(violations).toEqual([])
    })

    test('installer http files are identical within families that share one payload', () => {
        // Debian preseeds are fully parameterized (__PACKER_RECIPE_NAME__ etc.)
        // and Ubuntu autoinstall files carry no release-specific content, so
        // each family must stay byte-identical. AlmaLinux and Rocky kickstarts
        // legitimately differ per release (repo URLs, RHEL10 biosboot and
        // sshkey workaround) and are excluded.
        const identicalHttpFamilies = ['debian', 'ubuntu']
        const violations: string[] = []
        for (const family of identicalHttpFamilies) {
            const members = recipes.filter(recipe => groupOf(recipe) === family)
            if (members.length < 2) {
                violations.push(
                    `family ${family}: expected at least two recipes with "# group: ${family}" but found ${members.length}`
                )
                continue
            }
            const fileNames = new Set<string>()
            for (const recipe of members) {
                const dir = join(recipesDir, recipe.name, 'http')
                if (!existsSync(dir)) {
                    violations.push(
                        `family ${family}: ${recipe.name} has no http/ directory`
                    )
                    continue
                }
                for (const entry of readdirSync(dir)) fileNames.add(entry)
            }
            for (const file of [...fileNames].sort()) {
                let refName: string | undefined
                let refContent: string | undefined
                for (const recipe of members) {
                    const path = join(recipesDir, recipe.name, 'http', file)
                    if (!existsSync(path)) {
                        violations.push(
                            `family ${family}: ${recipe.name}/http/${file} is missing but siblings have it`
                        )
                        continue
                    }
                    const content = normalizeEol(readFileSync(path, 'utf8'))
                    if (refContent === undefined) {
                        refName = recipe.name
                        refContent = content
                    } else if (content !== refContent) {
                        violations.push(
                            `family ${family}: ${recipe.name}/http/${file} differs from ${refName}/http/${file} — ${firstDifference(refContent, content)}`
                        )
                    }
                }
            }
        }
        expect(violations).toEqual([])
    })

    test('RHEL-family recipes enable the guest-exec RPC after updating packages', () => {
        // RHEL ships qemu-guest-agent with guest-exec denied, which fails the
        // build smoke test's reboot-and-verify (src/verify/guest.ts). Every
        // almalinux/rocky recipe must run the shared enabler, and it must run
        // after `dnf update`, which can otherwise rewrite the config back to
        // the shipped defaults. Debian/Ubuntu permit guest-exec by default and
        // are deliberately excluded.
        const script = join(recipesDir, '_shared/post/enable-guest-exec.sh')
        expect(existsSync(script)).toBe(true)

        const violations: string[] = []
        const rhelFamilies = ['almalinux', 'rocky-linux']
        const members = recipes.filter(recipe =>
            rhelFamilies.includes(groupOf(recipe) ?? '')
        )
        expect(members.length).toBeGreaterThan(0)
        for (const recipe of members) {
            const enableAt = recipe.raw.indexOf(
                '_shared/post/enable-guest-exec.sh'
            )
            if (enableAt === -1) {
                violations.push(
                    `${recipe.name}: does not run enable-guest-exec.sh`
                )
                continue
            }
            const updateAt = recipe.raw.indexOf('dnf -y update')
            if (updateAt === -1 || updateAt > enableAt)
                violations.push(
                    `${recipe.name}: enable-guest-exec.sh must run after 'dnf -y update'`
                )
        }
        expect(violations).toEqual([])
    })

    test('Ubuntu autoinstall serializes the two grubenv writers', () => {
        // 26.04 renamed grub-common.service to grub2-common.service without
        // updating grub-initrd-fallback.service's `After=`, so the two units
        // that both rewrite /boot/grub/grubenv stopped being ordered and raced
        // (measured 25/200 concurrent grub-editenv pairs failing with "invalid
        // environment block", 0/400 sequential). A losing race leaves the guest
        // `degraded`, which is what sank ubuntu-26.04 in run 30868276107.
        //
        // The drop-in must name *both* spellings: the Ubuntu family shares one
        // byte-identical payload, and whichever unit name a release does not
        // use makes its line inert.
        const violations: string[] = []
        const members = recipes.filter(recipe => groupOf(recipe) === 'ubuntu')
        expect(members.length).toBeGreaterThan(0)
        for (const recipe of members) {
            const path = join(recipesDir, recipe.name, 'http', 'user-data')
            const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
            const dropIn = content.includes(
                '/etc/systemd/system/grub-initrd-fallback.service.d'
            )
            if (!dropIn) {
                violations.push(
                    `${recipe.name}: no grub-initrd-fallback.service drop-in`
                )
                continue
            }
            for (const unit of ['grub-common.service', 'grub2-common.service'])
                if (!content.includes(`After=${unit}`))
                    violations.push(
                        `${recipe.name}: drop-in does not order after ${unit}`
                    )
        }
        expect(violations).toEqual([])
    })
})
