/**
 * The declarative smoke-test model.
 *
 * A check is data, not control flow: an id, a script body, and what counts as a
 * pass. Adding a regression test for a shipped bug is therefore a few lines in
 * `linux.ts` / `windows.ts` with no change to the runner, and the selection and
 * templating logic stays unit-testable without a Proxmox node.
 */

/** `warn` records a finding in the report; `fail` fails the verify run. */
export type CheckSeverity = 'fail' | 'warn'

/**
 * Which boot a check runs on.
 *
 * - `first-boot`   — the first boot of the imported VM. The only chance to
 *                    observe first-boot-only state (regenerated SSH host keys,
 *                    the build's Windows profile before a logon recreates it).
 * - `post-reboot`  — after a clean reboot. Catches "worked once" state that a
 *                   provisioner left running but never made persistent.
 * - `post-logon`   — Windows only, after an autologon has painted a desktop.
 */
export type CheckPhase = 'first-boot' | 'post-reboot' | 'post-logon'

export type GuestShell = 'sh' | 'powershell'

/**
 * Sentinel values verify injects through cloud-init, so checks can assert the
 * guest actually consumed them rather than merely booted.
 */
export interface CheckContext {
    /** Sentinel hostname set via `qm set --name` / cloud-init. */
    hostname: string
    /** Sentinel cloud-init user. */
    ciUser: string
    /** Generated per-run password. Never logged; registered for redaction. */
    ciPassword: string
    /** Generated per-run SSH public key, injected via `--sshkeys`. */
    sshPublicKey: string
    /**
     * Bytes the root filesystem must reach after the pre-boot disk grow. The
     * grow is deliberately larger than the shipped disk so "cloud-init expanded
     * the root volume" is an observable event, not an assumption.
     */
    minRootBytes: number
    /**
     * The build's Windows admin/WinRM password when verify could recover it
     * from the node's vars file. When set, the plaintext-leak check greps for
     * this exact value instead of falling back to a structural check.
     */
    buildPassword?: string
}

export interface GuestCheck {
    /** Stable identifier; used in reports and to skip/allow individual checks. */
    id: string
    /** One line, phrased as the property being asserted. */
    description: string
    /**
     * Script body. A function form receives the run's sentinel values. Runs
     * under `/bin/sh -c` or `powershell.exe -EncodedCommand` per the suite.
     */
    script: string | ((ctx: CheckContext) => string)
    /** When set, stdout must also match for the check to pass. */
    expectStdout?: RegExp
    severity: CheckSeverity
    phase: CheckPhase
    /** Guest-side timeout. Default 60s; raise for anything that blocks. */
    timeoutS?: number
}

export interface CheckSuite {
    shell: GuestShell
    checks: GuestCheck[]
    /**
     * Fraction of identical pixels above which the console framebuffer reads as
     * blank. A text login prompt is ~98-99% background, so this sits high
     * enough to only catch a genuinely uniform screen — the gray-desktop
     * signature, a panic that cleared the console, a dead framebuffer.
     */
    screenUniformThreshold: number
    /** Severity of a uniform-console finding (see the note in `windows.ts`). */
    screenSeverity: CheckSeverity
}

export const renderScript = (check: GuestCheck, ctx: CheckContext): string =>
    typeof check.script === 'function' ? check.script(ctx) : check.script

export const checksForPhase = (
    suite: CheckSuite,
    phase: CheckPhase
): GuestCheck[] => suite.checks.filter(c => c.phase === phase)
