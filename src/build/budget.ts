import type { Env } from '@/env.ts'
import { formatMinutes } from '@/util.ts'

const MINUTE_MS = 60_000

/**
 * A wall-clock budget for one `cf build` process.
 *
 * GitHub cancels a hosted job at its time limit with nothing but "The
 * operation was canceled.", so a build it kills never says why. Two Windows
 * jobs died that way on 2026-11-19: windows-server-2022 started a retry 4h20m
 * in that could not finish inside 6h, and windows-server-2025 spent the whole
 * 6h waiting for a lease another run held.
 *
 * The budget moves the stop to the last point where cf can still explain it:
 * before an attempt, or during a lease wait, that the time left cannot cover.
 * It never stops work that is already running, so an attempt that overruns
 * its estimate can still finish in the margin CI keeps between the budget and
 * the job limit.
 */
export type TimeBudget = {
    limitMs: number
    /** Epoch ms the budget counts from. */
    startedAtMs: number
    now: () => number
}

/**
 * The budget `CF_BUILD_TIME_BUDGET_MINUTES` sets, counted from the start of
 * this process; undefined when it is unset, which leaves builds unbounded.
 */
export const timeBudgetFromEnv = (
    env: Pick<Env, 'CF_BUILD_TIME_BUDGET_MINUTES'>,
    startedAtMs: number = performance.timeOrigin,
    now: () => number = Date.now
): TimeBudget | undefined =>
    env.CF_BUILD_TIME_BUDGET_MINUTES === undefined
        ? undefined
        : {
              limitMs: env.CF_BUILD_TIME_BUDGET_MINUTES * MINUTE_MS,
              startedAtMs,
              now,
          }

export const budgetUsedMs = (budget: TimeBudget): number =>
    Math.max(0, budget.now() - budget.startedAtMs)

export const budgetLeftMs = (budget: TimeBudget): number =>
    budget.limitMs - budgetUsedMs(budget)

/** `4h21m of the 5h00m build time budget (…) used, 39m left` */
export const describeBudget = (budget: TimeBudget): string =>
    `${formatMinutes(budgetUsedMs(budget))} of the ${formatMinutes(budget.limitMs)} ` +
    `build time budget (CF_BUILD_TIME_BUDGET_MINUTES) used, ${formatMinutes(budgetLeftMs(budget))} left`

/**
 * The least time one attempt of each recipe takes, in minutes: a little under
 * the fastest single attempt CI has recorded for it. Recorded attempts took
 * 1h27m-1h55m for 2019, 3h40m-4h38m for 2022, and 2h54m-3h31m for 2025.
 *
 * Kept here rather than as a recipe header because changing a recipe file
 * rebuilds its image (src/affected.ts), and a floor changes only when a build
 * may start, not what the image contains.
 */
export const ATTEMPT_FLOOR_MINUTES: Readonly<Record<string, number>> = {
    'windows-server-2019': 85,
    'windows-server-2022': 210,
    'windows-server-2025': 170,
}

/**
 * Floors for a recipe missing from ATTEMPT_FLOOR_MINUTES, near the fastest
 * attempt recorded for its family: Linux recipes take 7-19 minutes, and the
 * quickest Windows release, 2019, about 1h27m.
 */
const DEFAULT_ATTEMPT_FLOOR_MINUTES = { linux: 5, windows: 80 }

/** The least time one build attempt of `recipeName` takes. */
export const attemptFloorMs = (
    recipeName: string,
    isWindows: boolean
): number =>
    (ATTEMPT_FLOOR_MINUTES[recipeName] ??
        DEFAULT_ATTEMPT_FLOOR_MINUTES[isWindows ? 'windows' : 'linux']) *
    MINUTE_MS

export type GateVerdict =
    | { ok: true; status: string }
    | { ok: false; reason: string }

export type AttemptGate = {
    /**
     * Whether attempt `attempt` of `attempts` may start. A pass marks it as
     * started, and its `status` says what the decision rested on.
     */
    check: (attempt: number, attempts: number) => GateVerdict
    /** The attempt that last passed `check` has failed. */
    failed: () => void
}

/**
 * Admit an attempt only while the budget covers what one needs: the recipe's
 * floor, or the longest attempt this build has already spent if that is longer.
 *
 * The floor sits near the fastest attempt CI has recorded for the recipe, so
 * stopping below it never turns away an attempt that could have finished. On
 * its own it is too hopeful for a retry. What makes an attempt slow is other
 * builds sharing the node, and that lasts for hours, so the attempt just spent
 * is the best guide to the next: windows-server-2022's floor is 3h30m, but its
 * first attempt on a busy node took 4h20m. The longest rather than the latest,
 * because an attempt that fails early says nothing about how long one that
 * gets further takes.
 */
export const attemptGate = (
    budget: TimeBudget,
    floorMs: number
): AttemptGate => {
    let startedAt: number | undefined
    let longestMs = 0
    return {
        check: (attempt, attempts) => {
            const needMs = Math.max(floorMs, longestMs)
            const basis =
                longestMs > floorMs
                    ? 'the longest attempt so far took that long'
                    : "the recipe's attempt floor"
            const need = `an attempt needs at least ${formatMinutes(needMs)} (${basis})`
            if (budgetLeftMs(budget) < needMs) {
                return {
                    ok: false,
                    reason:
                        `not starting build attempt ${attempt}/${attempts}: ${describeBudget(budget)}, and ${need}. ` +
                        `The CI job's time limit would cancel it partway, with no word of why.`,
                }
            }
            startedAt = budget.now()
            return {
                ok: true,
                status: `[budget] attempt ${attempt}/${attempts}: ${describeBudget(budget)}; ${need}`,
            }
        },
        failed: () => {
            if (startedAt === undefined) return
            longestMs = Math.max(longestMs, budget.now() - startedAt)
            startedAt = undefined
        },
    }
}

/**
 * The error that ends a lease wait once the time left can no longer cover the
 * attempt the lease is for; undefined while it still can. `waitingFor` names
 * what the wait is for, including the run holding the lease when known.
 */
export const leaseWaitExhausted = (
    budget: TimeBudget,
    needMs: number,
    waitedMs: number,
    waitingFor: string
): Error | undefined =>
    budgetLeftMs(budget) < needMs
        ? new Error(
              `gave up after waiting ${formatMinutes(waitedMs)} for ${waitingFor}: ` +
                  `${describeBudget(budget)}, and a build attempt needs at least ${formatMinutes(needMs)}. ` +
                  `Starting one now would end in the CI job's time limit cancelling it.`
          )
        : undefined

/**
 * Call `notify` once if the budget runs out before the returned function is
 * called. This is the one case the budget cannot prevent, an attempt that
 * overran its estimate, and it still gets a line saying why the job may be
 * cancelled.
 */
export const onBudgetSpent = (
    budget: TimeBudget,
    notify: () => void
): (() => void) => {
    const timer = setTimeout(notify, Math.max(0, budgetLeftMs(budget)))
    return () => clearTimeout(timer)
}
