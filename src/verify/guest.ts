import { redactSensitive } from '@/util.ts'
import { captureRemote } from '@/build/remote.ts'
import type {
    CheckContext,
    CheckPhase,
    CheckSuite,
    GuestCheck,
    GuestShell,
} from '@/verify/checks/types.ts'
import { checksForPhase, renderScript } from '@/verify/checks/types.ts'

export interface GuestExecResult {
    /** Guest-side exit code, or null when the agent never ran the command. */
    exitCode: number | null
    stdout: string
    stderr: string
    /** Set when the agent itself failed (not reachable, guest-exec disabled). */
    transportError?: string
}

/**
 * Both shells receive their script base64-encoded rather than inline. The script
 * then contains only `[A-Za-z0-9+/=]`, so it survives the ssh layer, the node
 * shell, and `qm guest exec` argv splitting without a single quoting decision —
 * which matters because these bodies are full of quotes, pipes, and backslashes.
 */
export const encodeGuestScript = (shell: GuestShell, script: string): string =>
    shell === 'powershell'
        ? Buffer.from(wrapPowerShell(script), 'utf16le').toString('base64')
        : Buffer.from(script, 'utf8').toString('base64')

/**
 * PowerShell exits 0 even after a non-terminating error, so a check that fails
 * midway would otherwise report as a pass. Force everything terminating and map
 * an escaping exception to a non-zero exit. `exit` inside `try` is not an
 * exception, so checks can still exit explicitly.
 */
const wrapPowerShell = (script: string): string =>
    `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
${script}
} catch {
  Write-Output "EXCEPTION: $($_.Exception.Message)"
  exit 1
}
exit 0`

export const guestExecCommand = (
    vmid: number,
    shell: GuestShell,
    script: string,
    timeoutS: number
): string => {
    const encoded = encodeGuestScript(shell, script)
    const argv =
        shell === 'powershell'
            ? `powershell.exe -NonInteractive -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
            : `/bin/sh -c "echo ${encoded} | base64 -d | /bin/sh"`
    return `qm guest exec ${vmid} --timeout ${timeoutS} -- ${argv}`
}

/**
 * Full result parser for `qm guest exec`, which emits
 * `{ exitcode, exited, out-data, err-data }` with the agent payload already
 * base64-decoded by Proxmox.
 *
 * Distinct from `parseGuestExecOutput` in build/diagnostics, which deliberately
 * keeps only scrubbed stdout for log capture — checks need the exit code and
 * stderr to decide pass/fail.
 */
export const parseGuestExecResult = (raw: string): GuestExecResult => {
    try {
        const parsed = JSON.parse(raw) as {
            'exitcode'?: number
            'out-data'?: string
            'err-data'?: string
        }
        return {
            exitCode:
                typeof parsed.exitcode === 'number' ? parsed.exitcode : null,
            stdout: (parsed['out-data'] ?? '').trim(),
            stderr: (parsed['err-data'] ?? '').trim(),
        }
    } catch {
        return {
            exitCode: null,
            stdout: '',
            stderr: raw.trim(),
            transportError: 'agent returned non-JSON output',
        }
    }
}

export const guestExec = async (
    target: string,
    vmid: number,
    shell: GuestShell,
    script: string,
    timeoutS: number
): Promise<GuestExecResult> => {
    try {
        // captureRemote hands this to ssh as the remote command line, so it is
        // already the node shell's input — quoting belongs inside the command's
        // arguments (which guestExecCommand handles), not around the whole
        // thing.
        const raw = await captureRemote(
            target,
            guestExecCommand(vmid, shell, script, timeoutS)
        )
        return parseGuestExecResult(raw)
    } catch (err) {
        return {
            exitCode: null,
            stdout: '',
            stderr: '',
            transportError: elideEncodedPayload(
                redactSensitive(
                    err instanceof Error ? err.message : String(err)
                )
            ),
        }
    }
}

/**
 * Strip the encoded payload out of a failed command line.
 *
 * The whole script travels as one base64 argument, so an unmodified execa error
 * reproduces multiple kilobytes of it and buries the one line that explains the
 * failure ("got timeout", "guest agent is not running"). The payload is
 * recoverable from the check id, so it is never worth printing.
 */
export const elideEncodedPayload = (message: string): string =>
    message
        .replace(
            /-EncodedCommand\s+[A-Za-z0-9+/=]+/g,
            '-EncodedCommand <elided>'
        )
        .replace(/echo\s+[A-Za-z0-9+/=]{64,}\s*\|/g, 'echo <elided> |')

export type CheckStatus = 'pass' | 'fail' | 'warn'

export interface CheckResult {
    id: string
    description: string
    status: CheckStatus
    /** Why it failed — exit code, stdout mismatch, or a transport error. */
    detail: string
    output: string
    durationMs: number
}

const evaluate = (
    check: GuestCheck,
    res: GuestExecResult
): { ok: boolean; detail: string } => {
    if (res.transportError)
        return { ok: false, detail: `guest agent: ${res.transportError}` }
    if (res.exitCode !== 0)
        return { ok: false, detail: `exit ${res.exitCode ?? 'unknown'}` }
    if (check.expectStdout && !check.expectStdout.test(res.stdout))
        return {
            ok: false,
            detail: `stdout did not match ${check.expectStdout}`,
        }
    return { ok: true, detail: '' }
}

/**
 * Attempts allowed when the agent never answers. A transport error means the
 * check did not run, which is categorically different from a check that ran and
 * failed — reporting it as a failure invents defects out of node load. Observed
 * directly: identical checks passed, then timed out, on a node at load 5 with
 * three concurrent builds, then passed again.
 *
 * Only transport errors are retried, never a real non-zero exit, and every
 * check is a read-only observation, so re-running one is free of side effects.
 */
const TRANSPORT_ATTEMPTS = 2
const TRANSPORT_RETRY_MS = 5_000
// More generous than TRANSPORT_ATTEMPTS: losing the boot-id baseline aborts the
// entire verify rather than one check, and it is read at the busiest moment in
// the run (right after autologon is armed).
const BOOT_ID_ATTEMPTS = 4

export const runCheck = async (
    target: string,
    vmid: number,
    suite: CheckSuite,
    check: GuestCheck,
    ctx: CheckContext
): Promise<CheckResult> => {
    const started = Date.now()
    let res: GuestExecResult = { exitCode: null, stdout: '', stderr: '' }
    for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt++) {
        res = await guestExec(
            target,
            vmid,
            suite.shell,
            renderScript(check, ctx),
            check.timeoutS ?? 60
        )
        if (!res.transportError) break
        if (attempt < TRANSPORT_ATTEMPTS)
            await new Promise(r => setTimeout(r, TRANSPORT_RETRY_MS))
    }
    const { ok, detail } = evaluate(check, res)
    return {
        id: check.id,
        description: check.description,
        status: ok ? 'pass' : check.severity === 'warn' ? 'warn' : 'fail',
        detail,
        output: redactSensitive(
            [res.stdout, res.stderr].filter(Boolean).join('\n')
        ),
        durationMs: Date.now() - started,
    }
}

export const runPhase = async (
    target: string,
    vmid: number,
    suite: CheckSuite,
    phase: CheckPhase,
    ctx: CheckContext,
    onResult?: (result: CheckResult) => void
): Promise<CheckResult[]> => {
    const results: CheckResult[] = []
    for (const check of checksForPhase(suite, phase)) {
        const result = await runCheck(target, vmid, suite, check, ctx)
        onResult?.(result)
        results.push(result)
    }
    return results
}

/**
 * A value that necessarily changes across a reboot, used to prove the guest
 * actually went down and came back rather than answering from the boot we were
 * already on — the agent stays responsive well into shutdown.
 */
const BOOT_ID_SCRIPT: Record<GuestShell, string> = {
    sh: 'cat /proc/sys/kernel/random/boot_id',
    // Fully parenthesised: in PowerShell's command-parsing mode a bare
    // `(expr).Member` argument does not bind the way it reads.
    powershell:
        'Write-Output ((Get-CimInstance Win32_OperatingSystem).LastBootUpTime.Ticks)',
}

/**
 * Both forms hand the reboot to the OS and return immediately, rather than
 * backgrounding a child of the exec'd shell — a subshell or job owned by that
 * shell can be torn down with it before the reboot ever fires.
 */
const REBOOT_SCRIPT: Record<GuestShell, string> = {
    sh: 'systemctl reboot --no-block 2>/dev/null || shutdown -r now || reboot',
    powershell: 'shutdown.exe /r /t 5 /f',
}

const cloudbaseIdleScript = (
    expectedHostname: string
): string => `$s = Get-Service cloudbase-init -ErrorAction SilentlyContinue
if (-not $s) { Write-Output 'cloudbase-init service missing'; exit 1 }
if ($s.Status -eq 'Running') { Write-Output 'still running'; exit 1 }
# "Not Running" alone is not "done": on Server 2019 the service is delayed-auto-
# start (so it runs after OOBE settles, not during it), and a delayed service reads
# as Stopped for its whole pre-start window. Returning then would run checks before
# Cloudbase-Init has applied the hostname/password at all. Require the marker the
# service writes when a plugin run finishes, so idleness means "ran and stopped",
# not "not yet started".
$log = 'C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init\\log\\cloudbase-init.log'
if (-not (Test-Path $log) -or -not (Select-String -Path $log -Pattern 'Plugins execution done' -Quiet)) {
  Write-Output 'not finished yet'; exit 1
}
# The marker lands *before* SetHostName's rename reboot fires, so "done + a
# briefly stable boot id" can still race that reboot (observed live: checks ran,
# then the reboot step found the agent mid-restart and could not read a boot
# id). The applied computer name is the deterministic signal: it only matches
# the sentinel after the rename reboot, and the plugins are run-once per
# instance, so no further init reboot can follow it.
if ($env:COMPUTERNAME -ne '${expectedHostname}') {
  Write-Output "hostname not applied yet ($env:COMPUTERNAME)"; exit 1
}
Write-Output $s.Status`

/**
 * Wait for Cloudbase-Init to finish on Windows.
 *
 * The agent answering does not mean the guest is done initialising: the
 * SetHostName plugin reboots the guest to make the name stick, so checks
 * started too early would race that reboot and report transport errors
 * indistinguishable from real failures.
 *
 * Idleness is confirmed twice at the same boot id, because the service is also
 * briefly not-Running on the boot *before* its reboot, and the sentinel
 * hostname must already be the active computer name (the rename only takes
 * effect on the reboot, so a matching name proves that reboot is behind us).
 * Transport errors are expected here — they are what the reboot looks like
 * from outside.
 *
 * Linux needs no equivalent: `cloud-init status --wait` blocks for exactly this
 * and is itself the first Linux check.
 */
export const waitForWindowsInit = async (
    target: string,
    vmid: number,
    hostname: string,
    timeoutS: number,
    intervalS = 10
): Promise<boolean> => {
    const deadline = Date.now() + timeoutS * 1000
    // Windows applies at most the 15-character NetBIOS prefix of a longer name.
    const idleScript = cloudbaseIdleScript(hostname.slice(0, 15))
    let stableBootId = ''
    while (Date.now() < deadline) {
        const res = await guestExec(target, vmid, 'powershell', idleScript, 30)
        if (res.exitCode === 0) {
            const bootId = await readBootId(target, vmid, 'powershell')
            if (bootId && bootId === stableBootId) return true
            stableBootId = bootId
        } else {
            stableBootId = ''
        }
        await new Promise(r => setTimeout(r, intervalS * 1000))
    }
    return false
}

export const readBootId = async (
    target: string,
    vmid: number,
    shell: GuestShell
): Promise<string> => {
    const res = await guestExec(target, vmid, shell, BOOT_ID_SCRIPT[shell], 30)
    return res.stdout.trim()
}

/**
 * Reboot from inside the guest and wait for a genuinely new boot. The reboot
 * races the agent's reply, so a transport error on the trigger is expected and
 * the new boot id — not the reply — is what confirms it worked.
 */
export const rebootGuest = async (
    target: string,
    vmid: number,
    shell: GuestShell,
    timeoutS: number,
    intervalS = 5
): Promise<boolean> => {
    // Retry the baseline the way runCheck retries a check. A single empty reply
    // here used to abort the whole verify: on 2026-08-04 a windows-server-2019
    // run reached the last phase with 12 checks passed and 1 warned, then threw
    // because one guest-exec timed out while the guest was busy arming
    // autologon. Windows guest agents go unresponsive under load constantly --
    // every phase of this file already assumes that -- so the one call that
    // could not tolerate it discarded a 1h16m build's validation.
    let before = ''
    for (let attempt = 1; attempt <= BOOT_ID_ATTEMPTS && !before; attempt++) {
        if (attempt > 1)
            await new Promise(r => setTimeout(r, TRANSPORT_RETRY_MS))
        before = await readBootId(target, vmid, shell)
    }
    // Without a baseline there is nothing to compare against, and "the agent
    // answers" would pass on the boot we are already on. Fail loudly instead.
    if (!before)
        throw new Error(
            `could not read a boot id before rebooting the guest (${BOOT_ID_ATTEMPTS} attempts)`
        )
    // The reboot races the reply; a transport error here is expected, not fatal.
    await guestExec(target, vmid, shell, REBOOT_SCRIPT[shell], 30)
    const deadline = Date.now() + timeoutS * 1000
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, intervalS * 1000))
        const now = await readBootId(target, vmid, shell)
        if (now && now !== before) return true
    }
    return false
}
