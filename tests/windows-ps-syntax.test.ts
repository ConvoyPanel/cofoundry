import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Parse-check every Windows provisioner script.
//
// These scripts only ever execute inside a Windows guest, three hours into a
// build, as the last provisioner before sysprep. A syntax error there is not
// caught by anything else in this repo: packer uploads the file verbatim, the
// guest fails at parse time, and the cost of finding out is a full rebuild. The
// PowerShell parser answers the same question in milliseconds.
//
// This is a syntax check, not a lint -- it says the file *is* PowerShell, not
// that it does the right thing. The behavioural invariants live in
// windows-cloudbase-conf.test.ts.

const psDir = fileURLToPath(
    new URL('../recipes/_shared/windows', import.meta.url)
)

const scripts = readdirSync(psDir)
    .filter(f => f.endsWith('.ps1'))
    .sort()

/** pwsh is optional: it is a 70 MB download and not every dev box has it. */
const pwsh = spawnSync(
    'pwsh',
    ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'],
    {
        encoding: 'utf8',
    }
)
const havePwsh = pwsh.status === 0

describe('Windows provisioner scripts parse', () => {
    test('there are scripts to check', () => {
        // Guards against the glob silently matching nothing after a move --
        // which would turn every test below into a no-op.
        expect(scripts.length).toBeGreaterThan(0)
    })

    for (const name of scripts) {
        test.skipIf(!havePwsh)(`${name} has no parse errors`, () => {
            const script = `
                $errors = $null
                [System.Management.Automation.Language.Parser]::ParseFile(
                    '${psDir}/${name}', [ref]$null, [ref]$errors) | Out-Null
                $errors | ForEach-Object {
                    "line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message
                }`
            const r = spawnSync('pwsh', ['-NoProfile', '-Command', script], {
                encoding: 'utf8',
            })
            expect(r.status).toBe(0)
            expect(r.stdout.trim()).toBe('')
        })
    }
})
