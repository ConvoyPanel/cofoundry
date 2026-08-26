import { describe, expect, test } from 'bun:test'
import { linuxSuite } from '@/verify/checks/linux.ts'
import { windowsSuite, wingetPresentCheck } from '@/verify/checks/windows.ts'
import type { GuestCheck } from '@/verify/checks/types.ts'

/**
 * Check scripts are TypeScript template literals, where `\S` is not a
 * recognized escape and silently becomes `S`. A registry path written with
 * single backslashes therefore compiles fine, reviews fine, and arrives in the
 * guest as `HKLM:SYSTEMCurrentControlSetControlTerminal Server`.
 *
 * That shipped: the rdp-enabled check failed every Windows verify with
 * "Cannot find path ... because it does not exist", ~17 minutes into each run,
 * and the only symptom was a check failing for a template that was fine.
 */
const scriptsOf = (checks: GuestCheck[]): [string, string][] =>
    checks
        .filter(c => typeof c.script === 'string')
        .map(c => [c.id, c.script as string])

const allScripts: [string, string][] = [
    ...scriptsOf(windowsSuite.checks),
    ...scriptsOf(linuxSuite.checks),
    ...scriptsOf([wingetPresentCheck]),
]

describe('verify check scripts', () => {
    test('there are scripts to inspect', () => {
        expect(allScripts.length).toBeGreaterThan(5)
    })

    test('no registry path lost its separators to template-literal escaping', () => {
        for (const [id, script] of allScripts) {
            // `HKLM:` must be followed by a separator, never straight into a
            // key name — that is exactly what a stripped backslash looks like.
            const collapsed = script.match(/HK(?:LM|CU):[A-Za-z]/g)
            expect(collapsed, `${id} has a collapsed registry path`).toBeNull()
        }
    })

    test('registry paths keep every separator, not just the first', () => {
        for (const [id, script] of allScripts) {
            for (const path of script.match(/HK(?:LM|CU):[^'"\s]+/g) ?? []) {
                // A real hive path is at least HKLM:\<hive>\<key>. One
                // separator means the rest were eaten.
                expect(
                    (path.match(/\\/g) ?? []).length,
                    `${id}: ${path}`
                ).toBeGreaterThan(1)
            }
        }
    })
})
