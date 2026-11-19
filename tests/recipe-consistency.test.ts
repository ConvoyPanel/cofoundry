import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
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

    test('inline provisioner lines never rely on a bare `! cmd` to fail the build', () => {
        // Packer runs a provisioner's inline lines as one script under
        // `/bin/sh -e`, and POSIX `sh -e` ignores the exit status of a command
        // negated with `!`: `sh -e -c '! true; echo reached'` prints "reached".
        // A bare `! grep …` line therefore asserts nothing. Spell the failure
        // out instead: `! grep … || { echo '…' >&2; exit 1; }`.
        const violations: string[] = []
        for (const recipe of recipes) {
            recipe.raw.split('\n').forEach((line, i) => {
                if (/^\s*"!\s/.test(line) && !line.includes('||')) {
                    violations.push(
                        `${recipe.name}.pkr.hcl:${i + 1}: ${line.trim()}`
                    )
                }
            })
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
        // build smoke test's reboot-and-verify (src/verify/guest.ts). finalize.sh
        // runs the shared enabler on the RHEL family, and every almalinux/rocky
        // recipe must run finalize.sh after `dnf update`, which can otherwise
        // rewrite the config back to the shipped defaults. Debian/Ubuntu permit
        // guest-exec by default.
        const finalize = readFileSync(
            join(recipesDir, '_shared/linux/finalize.sh'),
            'utf8'
        )
        expect(finalize).toContain('bash "$here/enable-guest-exec.sh"')
        expect(
            existsSync(join(recipesDir, '_shared/linux/enable-guest-exec.sh'))
        ).toBe(true)

        const violations: string[] = []
        const rhelFamilies = ['almalinux', 'rocky-linux']
        const members = recipes.filter(recipe =>
            rhelFamilies.includes(groupOf(recipe) ?? '')
        )
        expect(members.length).toBeGreaterThan(0)
        for (const recipe of members) {
            const finalizeAt = recipe.raw.indexOf('/tmp/cofoundry/finalize.sh')
            const updateAt = recipe.raw.indexOf('dnf -y update')
            if (finalizeAt === -1 || updateAt === -1 || updateAt > finalizeAt)
                violations.push(
                    `${recipe.name}: finalize.sh must run after 'dnf -y update'`
                )
        }
        expect(violations).toEqual([])
    })

    test('every Linux recipe reboots after updating, then ends with finalize.sh', () => {
        // finalize.sh removes every kernel but the running one, so the build
        // must be running the upgraded kernel; and it deletes the build user
        // and powers the VM off, so it is the last provisioner and Packer must
        // not try to clean up after it. See the header of
        // recipes/_shared/linux/finalize.sh.
        const violations: string[] = []
        const linux = recipes.filter(r => !r.name.startsWith('windows-'))
        expect(linux.length).toBeGreaterThan(0)
        for (const recipe of linux) {
            const provisioners = recipe.raw
                .split(/\n  (?=provisioner ")/)
                .slice(1)
            const last = provisioners.at(-1) ?? ''
            if (!last.includes('sudo bash /tmp/cofoundry/finalize.sh'))
                violations.push(
                    `${recipe.name}: last provisioner is not finalize.sh`
                )
            // A lost connection must fail the build, not pass as the
            // power-off: finalize.sh exits 0 before powering off.
            if (/expect_disconnect\s*=\s*true/.test(last))
                violations.push(
                    `${recipe.name}: finalize.sh must not set expect_disconnect`
                )
            if (!/skip_clean\s*=\s*true/.test(last))
                violations.push(`${recipe.name}: finalize.sh needs skip_clean`)
            const rebootAt = recipe.raw.indexOf('"sudo systemctl reboot"')
            const upgradeAt = Math.max(
                recipe.raw.indexOf('dist-upgrade'),
                recipe.raw.indexOf('dnf -y update')
            )
            if (rebootAt === -1 || upgradeAt === -1 || rebootAt < upgradeAt)
                violations.push(
                    `${recipe.name}: no reboot after the package upgrade`
                )
            if (!recipe.raw.includes('"${path.root}/_shared/linux/"'))
                violations.push(
                    `${recipe.name}: does not upload _shared/linux/`
                )
        }
        expect(violations).toEqual([])
    })

    test('every kickstart parses under its RHEL release', () => {
        // el8's parser rejects `%packages --exclude-weakdeps` (it knows only
        // --excludeWeakdeps), and anaconda then sits at the parse error until
        // Packer's 35-minute SSH timeout. ksvalidator catches that offline.
        // CI installs it; a machine without it skips.
        const ksvalidator = spawnSync('sh', ['-c', 'command -v ksvalidator'], {
            encoding: 'utf8',
        }).stdout.trim()
        if (!ksvalidator) return
        const violations: string[] = []
        for (const recipe of recipes) {
            const path = join(recipesDir, recipe.name, 'http', 'ks.cfg')
            if (!existsSync(path)) continue
            const release = readFileSync(path, 'utf8').match(
                /^#version=(RHEL\d+)/m
            )?.[1]
            if (!release) {
                violations.push(
                    `${recipe.name}: ks.cfg has no #version=RHELn line`
                )
                continue
            }
            const run = spawnSync(ksvalidator, ['-v', release, path], {
                encoding: 'utf8',
            })
            if (run.status !== 0)
                violations.push(
                    `${recipe.name} (${release}): ${(run.stdout + run.stderr).trim()}`
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

// Every Linux image boots under SeaBIOS and under OVMF with Secure Boot, the
// way the official cloud images do: GPT, a BIOS boot partition, a FAT32 EFI
// system partition, the root last (growpart extends only the last
// partition), and both GRUBs. The build VM boots under SeaBIOS whatever the
// UEFI half looks like, so these are checked offline as well as by
// finalize.sh and `cf verify --firmware ovmf`.
describe('hybrid BIOS and UEFI boot', () => {
    const ESP_TYPE = 'C12A7328-F81F-11D2-BA4B-00A0C93EC93B'
    const payload = (recipe: Recipe, file: string): string => {
        const path = join(recipesDir, recipe.name, 'http', file)
        return existsSync(path) ? readFileSync(path, 'utf8') : ''
    }
    const family = (group: string): Recipe[] =>
        recipes.filter(recipe => groupOf(recipe) === group)

    test('Debian preseeds add an ESP and install grub-cloud-amd64', () => {
        const members = family('debian')
        expect(members.length).toBeGreaterThan(0)
        for (const recipe of members) {
            const preseed = payload(recipe, 'preseed.cfg')
            const expert = preseed.match(
                /partman-auto\/expert_recipe string([\s\S]*?)\n[^ ]/
            )?.[1]
            expect(expert, recipe.name).toBeDefined()
            const bios = expert!.indexOf('method{ biosgrub }')
            const esp = expert!.indexOf('mountpoint{ /boot/efi }')
            const root = expert!.indexOf('mountpoint{ / }')
            expect(bios, `${recipe.name}: BIOS boot partition`).toBeGreaterThan(
                -1
            )
            expect(esp, `${recipe.name}: ESP after BIOS boot`).toBeGreaterThan(
                bios
            )
            expect(root, `${recipe.name}: root last`).toBeGreaterThan(esp)
            expect(expert).toContain('filesystem{ fat32 }')
            const late =
                preseed.match(
                    /preseed\/late_command string([\s\S]*?)\nd-i /
                )?.[1] ?? ''
            expect(late).toContain(`sfdisk --part-type /dev/sda 2 ${ESP_TYPE}`)
            expect(late).toContain('touch /etc/grub.d/enable_cloud')
            // grub-pc's purge deletes /etc/default/grub, which grub-cloud-amd64
            // ships as a conffile; the other order stops at a conffile prompt.
            const purge = late.indexOf('purge grub-pc')
            expect(purge).toBeGreaterThan(-1)
            expect(late.indexOf('install grub-cloud-amd64')).toBeGreaterThan(
                purge
            )
            expect(late.indexOf('enable_cloud')).toBeLessThan(
                late.indexOf('install grub-cloud-amd64')
            )
            // trixie's target still lists the netinst CD as an apt source but
            // no longer has it mounted, and apt waits at "Media change" until
            // Packer's SSH timeout. The entries go before the install.
            const cdrom = late.indexOf("sed -i '/^deb cdrom:/s/^/#/'")
            expect(cdrom).toBeGreaterThan(-1)
            expect(cdrom).toBeLessThan(late.indexOf('install grub-cloud-amd64'))
            // in-target's stdin is cdebconf's reply channel: redirecting it
            // desynchronised debconf and finish-install stopped at its menu.
            expect(late).not.toMatch(/in-target[^;]*</)
        }
    })

    test('Ubuntu autoinstall lays out BIOS boot, ESP and root, and installs signed GRUB', () => {
        const members = family('ubuntu')
        expect(members.length).toBeGreaterThan(0)
        for (const recipe of members) {
            const { autoinstall } = Bun.YAML.parse(
                payload(recipe, 'user-data')
            ) as {
                autoinstall: {
                    'packages': string[]
                    'storage': {
                        layout?: unknown
                        config: Record<string, unknown>[]
                    }
                    'late-commands': string[]
                }
            }
            const { storage } = autoinstall
            expect(
                storage.layout,
                `${recipe.name}: layouts cannot add an ESP`
            ).toBeUndefined()
            const partitions = storage.config.filter(
                a => a.type === 'partition'
            )
            const byFlag = (flag: string) =>
                partitions.find(p => p.flag === flag)
            expect(byFlag('bios_grub'), recipe.name).toBeDefined()
            const esp = byFlag('boot')
            expect(esp, recipe.name).toBeDefined()
            const formatOf = (id: unknown) =>
                storage.config.find(a => a.type === 'format' && a.volume === id)
            const mountOf = (format: Record<string, unknown> | undefined) =>
                storage.config.find(
                    a => a.type === 'mount' && a.device === format?.id
                )
            expect(formatOf(esp!.id)?.fstype).toBe('fat32')
            expect(mountOf(formatOf(esp!.id))?.path).toBe('/boot/efi')
            const last = partitions.reduce((a, b) =>
                Number(b.number) > Number(a.number) ? b : a
            )
            expect(last.size, `${recipe.name}: root fills the disk`).toBe(-1)
            expect(mountOf(formatOf(last.id))?.path).toBe('/')
            expect(
                storage.config.find(a => a.type === 'disk')?.grub_device
            ).toBe(true)
            for (const pkg of ['grub-efi-amd64-signed', 'shim-signed'])
                expect(autoinstall.packages, recipe.name).toContain(pkg)
            const late = autoinstall['late-commands'].join('\n')
            expect(late).toContain(
                'grub-install --target=x86_64-efi --efi-directory=/boot/efi --uefi-secure-boot --no-nvram'
            )
            expect(late).toContain(
                'grub-efi/cloud_style_installation boolean true'
            )
            expect(late).toContain(
                'grub-pc/cloud_style_installation boolean true'
            )
        }
    })

    test('kickstarts add an ESP, the UEFI packages and its partition type', () => {
        const members = recipes.filter(recipe =>
            existsSync(join(recipesDir, recipe.name, 'http', 'ks.cfg'))
        )
        expect(members.length).toBeGreaterThan(0)
        for (const recipe of members) {
            const ks = payload(recipe, 'ks.cfg')
            const parts = ks.match(/^part .*$/gm) ?? []
            expect(
                parts.map(p => p.split(/\s+/)[1]),
                recipe.name
            ).toEqual(['biosboot', '/boot/efi', '/'])
            expect(parts[1]).toContain('--fstype="vfat"')
            expect(parts[1]).toContain('--mkfsoptions="-F 32"')
            expect(parts[2]).toContain('--grow')
            const packages =
                ks.match(/^%packages[^\n]*\n([\s\S]*?)^%end/m)?.[1] ?? ''
            for (const pkg of ['grub2-efi-x64', 'shim-x64'])
                expect(packages.split('\n'), recipe.name).toContain(pkg)
            expect(ks).toContain(ESP_TYPE)
            expect(ks).toContain('gen_grub_cfgstub /boot/grub2')
        }
    })
})
