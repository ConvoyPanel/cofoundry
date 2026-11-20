import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { listRecipes } from '@/config.ts'
import { parseEnv } from '@/env.ts'
import {
    ATTEMPT_FLOOR_MINUTES,
    attemptFloorMs,
    budgetLeftMs,
    budgetUsedMs,
    describeBudget,
    onBudgetSpent,
    timeBudgetFromEnv,
} from '@/build/budget.ts'

const MIN = 60_000

describe('build time budget', () => {
    test('is off unless CF_BUILD_TIME_BUDGET_MINUTES is set', () => {
        expect(timeBudgetFromEnv({})).toBeUndefined()
    })

    test('reads CF_BUILD_TIME_BUDGET_MINUTES as CI passes it', () => {
        const env = parseEnv({
            PVE_HOST: 'pve.example.com',
            PVE_NODE: 'pve1',
            PVE_TOKEN_ID: 'budget-test@pam!id',
            PVE_TOKEN_SECRET: 'budget-test-secret',
            SSH_TARGET: 'root@pve.example.com',
            CF_BUILD_TIME_BUDGET_MINUTES: '300',
        })
        expect(env.CF_BUILD_TIME_BUDGET_MINUTES).toBe(300)
    })

    test('counts from its start and says where it stands', () => {
        let now = 1_000_000
        const budget = timeBudgetFromEnv(
            { CF_BUILD_TIME_BUDGET_MINUTES: 300 },
            now,
            () => now
        )!
        now += 61 * MIN
        expect(budgetUsedMs(budget)).toBe(61 * MIN)
        expect(budgetLeftMs(budget)).toBe(239 * MIN)
        expect(describeBudget(budget)).toBe(
            '1h01m of the 5h00m build time budget (CF_BUILD_TIME_BUDGET_MINUTES) used, 3h59m left'
        )
        now += 300 * MIN
        expect(budgetLeftMs(budget)).toBeLessThan(0)
        expect(describeBudget(budget)).toEndWith(', 0m left')
    })

    test('counts from process start by default', () => {
        // Prefetch and the repository sync run before the build itself, and
        // they spend the same CI job time.
        const budget = timeBudgetFromEnv({ CF_BUILD_TIME_BUDGET_MINUTES: 1 })!
        expect(budget.startedAtMs).toBe(performance.timeOrigin)
        expect(budgetUsedMs(budget)).toBeGreaterThan(0)
    })
})

describe('attempt floors', () => {
    test('name only recipes that exist, and cover every Windows recipe', async () => {
        const names = (await listRecipes()).map(r => r.name)
        for (const name of Object.keys(ATTEMPT_FLOOR_MINUTES))
            expect(names).toContain(name)
        for (const name of names.filter(n => n.startsWith('windows-')))
            expect(ATTEMPT_FLOOR_MINUTES[name], name).toBeNumber()
    })

    test('fall back to the family default for an unlisted recipe', () => {
        expect(attemptFloorMs('windows-server-2022', true)).toBe(210 * MIN)
        expect(attemptFloorMs('windows-server-2031', true)).toBe(80 * MIN)
        expect(attemptFloorMs('debian-12', false)).toBe(5 * MIN)
    })
})

describe('build-one.yml time budget', () => {
    // A static guard over the workflow's text, which nothing in the test
    // process runs.
    const workflow = readFileSync(
        fileURLToPath(
            new URL('../.github/workflows/build-one.yml', import.meta.url)
        ),
        'utf8'
    )
    const setting = (key: string): number =>
        Number(
            workflow.match(
                new RegExp(`^\\s*${key}:\\s*'?(\\d+)'?\\s*(?:#.*)?$`, 'm')
            )?.[1]
        )
    const timeoutMinutes = setting('timeout-minutes')
    const budgetMinutes = setting('CF_BUILD_TIME_BUDGET_MINUTES')

    test('ends the budget inside the job limit, with room for what follows', () => {
        // GitHub cancels a hosted job at 6h however high this is set.
        expect(timeoutMinutes).toBeLessThanOrEqual(360)
        // Setup, a Windows verify (up to ~20m) and the upload run outside the
        // budget; an attempt that overruns its estimate eats into the rest.
        expect(timeoutMinutes - budgetMinutes).toBeGreaterThanOrEqual(30)
    })

    test('leaves every recipe time for at least one attempt', () => {
        // A floor at or above the budget would refuse every attempt of that
        // recipe before it started.
        for (const [name, minutes] of Object.entries(ATTEMPT_FLOOR_MINUTES))
            expect(minutes, name).toBeLessThan(budgetMinutes)
    })
})

describe('onBudgetSpent', () => {
    const almostSpent = () =>
        timeBudgetFromEnv(
            { CF_BUILD_TIME_BUDGET_MINUTES: 1 },
            Date.now() - MIN + 5
        )!

    test('says so once the budget runs out mid-attempt', async () => {
        let notices = 0
        const stop = onBudgetSpent(almostSpent(), () => notices++)
        await Bun.sleep(50)
        stop()
        expect(notices).toBe(1)
    })

    test('stays silent for work that ends inside the budget', async () => {
        let notices = 0
        onBudgetSpent(almostSpent(), () => notices++)()
        await Bun.sleep(50)
        expect(notices).toBe(0)
    })
})
