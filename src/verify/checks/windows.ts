import type { CheckSuite } from '@/verify/checks/types.ts'

/**
 * Shell surfaces whose crash is the "boots fine, desktop is unusable" signature
 * that a guest-agent ping cannot see. ShellHost.exe is the one that faulted in
 * ControlCenter.dll against a stale generalized profile; explorer.exe kept
 * running throughout, which is exactly why process-presence alone is not a
 * sufficient check. See docs/windows.md.
 */
const SHELL_PROCESSES = [
    'ShellHost.exe',
    'explorer.exe',
    'ShellExperienceHost.exe',
    'StartMenuExperienceHost.exe',
    'SearchHost.exe',
]

/** Answer files and setup logs known to echo the unattend password verbatim. */
const SECRET_BEARING_PATHS = [
    'C:\\Windows\\Panther\\unattend.xml',
    'C:\\Windows\\Panther\\unattend\\unattend.xml',
    'C:\\Windows\\System32\\Sysprep\\unattend.xml',
    'C:\\Windows\\Temp\\cb-sysprep-unattend.xml',
]

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

const psList = (items: string[]): string => items.map(psQuote).join(',')

export const windowsSuite: CheckSuite = {
    shell: 'powershell',
    // A painted desktop has a taskbar, icons, and window chrome, so it never
    // approaches uniformity. The gray-desktop failure is a single flat colour
    // edge to edge — which makes the framebuffer a hard signal here, and the
    // only one that crosses the session-0 boundary (see shell-no-crashes).
    screenUniformThreshold: 0.999,
    screenSeverity: 'fail',
    checks: [
        {
            // Cloudbase-Init refuses to run until sysprep reports generalization
            // complete. Clones sat at 3 and the service looped forever, so
            // nothing cloud-init was supposed to apply ever got applied.
            id: 'generalization-state',
            description: 'sysprep generalization completed (state 7)',
            script: `$k = 'HKLM:\\SYSTEM\\Setup\\Status\\SysprepStatus'
$s = (Get-ItemProperty $k).GeneralizationState
Write-Output "GeneralizationState=$s"
if ($s -ne 7) {
  Write-Output 'OOBE never advanced — Cloudbase-Init will wait forever'
  exit 1
}`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            // Assert real completion, not the absence of any ERROR line.
            // Cloudbase-Init logs benign ERRORs on every Proxmox clone that are
            // not failures: the --ciuser/--cipassword we set render as a
            // #cloud-config user_data whose modules it does not implement
            // ("Plugin '...' is currently not supported"), and it tries the Debian
            // netcfg parser first on Proxmox's network config ("Invalid Debian
            // config to parse"). A genuine plugin failure is logged as
            // "plugin '<name>' failed with error"; a CRITICAL is always one. The
            // original 2019 hang is caught by the completion assertion — it looped
            // "Waiting for sysprep completion" forever and never reached the end.
            id: 'cloudbase-init-completed',
            description:
                'Cloudbase-Init ran to completion with no plugin failures',
            script: `$log = 'C:\\Program Files\\Cloudbase Solutions\\Cloudbase-Init\\log\\cloudbase-init.log'
if (-not (Test-Path $log)) {
  Write-Output 'cloudbase-init.log missing — the service never ran'
  exit 1
}
$failed = Select-String -Path $log -Pattern "plugin '[^']+' failed with error", 'CRITICAL'
if ($failed) {
  $failed | Select-Object -First 20 | ForEach-Object { Write-Output $_.Line }
  exit 1
}
if (-not (Select-String -Path $log -Pattern 'Plugins execution done')) {
  Write-Output 'Cloudbase-Init did not finish (no "Plugins execution done") — likely still waiting for sysprep completion'
  exit 1
}`,
            severity: 'fail',
            phase: 'first-boot',
            timeoutS: 120,
        },
        {
            // sysprep /generalize does not delete user profiles. The build's
            // profile shipping in the template is what made every clone's shell
            // fault, so its absence before any logon is the direct assertion.
            id: 'build-profile-removed',
            description:
                "the build's Administrator profile is not in the image",
            script: `if (Test-Path 'C:\\Users\\Administrator') {
  Write-Output 'C:\\Users\\Administrator survived generalize — clones inherit stale shell state'
  Get-ChildItem 'C:\\Users' -Force | ForEach-Object { Write-Output $_.Name }
  exit 1
}`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            id: 'winrm-not-exposed',
            description: 'no enabled firewall rule opens 5985/5986 to Public',
            script: `$bad = @()
foreach ($r in Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue) {
  if ($r.Profile -notmatch 'Public|Any') { continue }
  $p = $r | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
  if ($p.LocalPort -contains '5985' -or $p.LocalPort -contains '5986') { $bad += $r }
}
if ($bad) {
  $bad | ForEach-Object { Write-Output "open: $($_.DisplayName) [$($_.Profile)]" }
  exit 1
}`,
            severity: 'fail',
            phase: 'first-boot',
            timeoutS: 120,
        },
        {
            // These templates publish to a public CDN, so a build password left
            // in an answer file ships to everyone. When verify recovered the
            // build password from the node it greps for that exact value;
            // otherwise it falls back to asserting no answer file carries a
            // non-empty password at all.
            id: 'no-plaintext-build-password',
            description: 'no build password left in answer files or setup logs',
            script: ctx => {
                const paths = psList(SECRET_BEARING_PATHS)
                if (ctx.buildPassword) {
                    return `$needle = ${psList([ctx.buildPassword])}
$paths = @(${paths}) + (Get-ChildItem 'C:\\Windows\\Panther' -Filter *.log -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
$hits = @()
foreach ($p in $paths) {
  if (-not (Test-Path $p)) { continue }
  if (Select-String -Path $p -SimpleMatch -Pattern $needle -ErrorAction SilentlyContinue) { $hits += $p }
}
if ($hits) {
  $hits | ForEach-Object { Write-Output "build password present in $_" }
  exit 1
}`
                }
                return `$hits = @()
foreach ($p in @(${paths})) {
  if (-not (Test-Path $p)) { continue }
  try { [xml]$x = Get-Content -Raw -LiteralPath $p } catch { continue }
  $nodes = $x.SelectNodes('//*[local-name()="AdministratorPassword" or local-name()="Password"]/*[local-name()="Value"]')
  foreach ($n in $nodes) {
    if ($n.InnerText -and $n.InnerText.Trim().Length -gt 0) { $hits += "$p ($($n.ParentNode.LocalName))" }
  }
}
if ($hits) {
  $hits | ForEach-Object { Write-Output "non-empty password value in $_" }
  exit 1
}`
            },
            severity: 'fail',
            phase: 'first-boot',
            timeoutS: 120,
        },
        {
            id: 'guest-agent-automatic',
            description: 'QEMU guest agent starts automatically',
            script: `$s = Get-Service -Name 'QEMU-GA' -ErrorAction SilentlyContinue
if (-not $s) { $s = Get-Service -DisplayName 'QEMU Guest Agent*' -ErrorAction SilentlyContinue }
if (-not $s) { Write-Output 'guest agent service not found'; exit 1 }
Write-Output "$($s.Name) StartType=$($s.StartType) Status=$($s.Status)"
if ($s.StartType -ne 'Automatic') { exit 1 }`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            // The direct regression test for the password-overwrite defect:
            // when the specialize-pass cloudbase run consumes
            // SetUserPasswordPlugin's run-once slot, the oobeSystem pass
            // re-seeds the build's throwaway password afterwards and the
            // cloud-init password never validates (verified live on 2025,
            // 2026-07-21). Checked directly so it fails here by name, not ten
            // minutes later as a mysterious autologon that never appears.
            // The password itself is never echoed.
            id: 'cipassword-validates',
            description: 'the cloud-init password authenticates the ci user',
            script: ctx => `Add-Type -AssemblyName System.DirectoryServices.AccountManagement
$ct = [System.DirectoryServices.AccountManagement.ContextType]::Machine
$pc = New-Object System.DirectoryServices.AccountManagement.PrincipalContext($ct)
$ok = $pc.ValidateCredentials(${psQuote(ctx.ciUser)}, ${psQuote(ctx.ciPassword)})
Write-Output "ValidateCredentials(${ctx.ciUser})=$ok"
if (-not $ok) {
  Write-Output 'cloud-init password does not validate — oobeSystem likely re-applied the seeded build password after cloudbase set it'
  exit 1
}`,
            severity: 'fail',
            phase: 'first-boot',
            timeoutS: 120,
        },
        {
            // Install.ps1 suppresses WU auto-update/auto-reboot for the build;
            // Finalize.ps1 must restore Windows' defaults before export. A
            // regression there ships templates that silently never update.
            id: 'wu-policy-restored',
            description:
                'Windows Update automatic-reboot defaults are restored',
            script: `$bad = @()
$au = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU'
if (Test-Path $au) {
  $v = Get-ItemProperty $au -ErrorAction SilentlyContinue
  if ($v.NoAutoUpdate -eq 1) { $bad += 'AU policy still sets NoAutoUpdate=1' }
  if ($v.NoAutoRebootWithLoggedOnUsers -eq 1) { $bad += 'AU policy still sets NoAutoRebootWithLoggedOnUsers=1' }
}
foreach ($t in @('Reboot', 'Reboot_AC', 'Reboot_Battery')) {
  $task = Get-ScheduledTask -TaskPath '\\Microsoft\\Windows\\UpdateOrchestrator\\' -TaskName $t -ErrorAction SilentlyContinue
  if ($task -and $task.State -eq 'Disabled') { $bad += "UpdateOrchestrator\\$t is still disabled" }
}
if ($bad) {
  $bad | ForEach-Object { Write-Output $_ }
  exit 1
}
Write-Output 'WU update/reboot defaults in place'`,
            severity: 'fail',
            phase: 'first-boot',
            timeoutS: 120,
        },
        {
            // PreFinalize.ps1 disables the pagefile so Finalize's zero pass can
            // compact that space; Finalize re-enables system management before
            // sysprep. If that restore regresses, clones run with no pagefile.
            id: 'pagefile-restored',
            description: 'the system-managed pagefile is back on the clone',
            script: `$cs = Get-CimInstance Win32_ComputerSystem
Write-Output "AutomaticManagedPagefile=$($cs.AutomaticManagedPagefile)"
if (-not $cs.AutomaticManagedPagefile) {
  Write-Output 'pagefile left disabled by the build'
  exit 1
}
if (-not [System.IO.File]::Exists('C:\\pagefile.sys')) {
  Write-Output 'pagefile.sys was not recreated at boot'
  exit 1
}`,
            severity: 'warn',
            phase: 'first-boot',
        },
        {
            // The build may now run sysprep /generalize up to twice (the armed-
            // reseal gate retries once), and each generalize consumes a
            // licensing rearm. Headroom left on the shipped template is what a
            // user's own sysprep of a clone would draw from.
            id: 'rearm-headroom',
            description: 'the template ships with licensing rearms remaining',
            script: `$out = cscript.exe //nologo C:\\Windows\\System32\\slmgr.vbs /dlv 2>&1 | Out-String
$m = [regex]::Match($out, 'Windows rearm count:\\s*(\\d+)')
if (-not $m.Success) {
  Write-Output 'could not read the rearm count from slmgr /dlv'
  exit 1
}
Write-Output "remaining Windows rearm count: $($m.Groups[1].Value)"
if ([int]$m.Groups[1].Value -lt 1) { exit 1 }`,
            severity: 'warn',
            phase: 'first-boot',
            timeoutS: 120,
        },
        {
            // Cloudbase-Init applies the hostname and reboots to make it stick,
            // so this is only meaningful once the guest has come back up.
            // Windows uppercases and truncates to 15 chars — compare loosely.
            id: 'hostname-applied',
            description: 'Cloudbase-Init applied the injected hostname',
            script: ctx => `$want = '${ctx.hostname}'
$got = $env:COMPUTERNAME
Write-Output "hostname=$got want=$want"
if ($got -ine $want) { exit 1 }`,
            severity: 'fail',
            phase: 'post-reboot',
        },
        {
            // Win32_LogicalDisk, not Get-Volume. Get-Volume comes from the
            // Storage module and goes through the VDS/storage-provider stack,
            // which can wedge — measured hanging indefinitely on a live Server
            // 2025 clone while every other cmdlet answered in seconds. The
            // check would then report a guest-agent timeout rather than a disk
            // size. The WMI class is far older and answers from the filesystem
            // driver.
            id: 'system-volume-extended',
            description: 'the system volume was extended to the full disk',
            script: ctx => `$want = ${ctx.minRootBytes}
$c = Get-CimInstance -ClassName Win32_LogicalDisk | Where-Object DeviceID -eq 'C:'
if (-not $c) { Write-Output 'no C: volume found'; exit 1 }
Write-Output "C=$($c.Size) want>=$want"
if ($c.Size -lt $want) { exit 1 }`,
            severity: 'fail',
            phase: 'post-reboot',
        },
        {
            id: 'no-critical-service-failures',
            description: 'no automatic-start service failed to start',
            script: `$bad = Get-Service | Where-Object { $_.StartType -eq 'Automatic' -and $_.Status -ne 'Running' }
# DelayedAutoStart services are legitimately not running yet at this point.
$bad = $bad | Where-Object { $_.Name -notin @('gpsvc','sppsvc','MapsBroker','WbioSrvc','tiledatamodelsvc','RemoteRegistry','edgeupdate') }
if ($bad) {
  $bad | ForEach-Object { Write-Output "not running: $($_.Name) ($($_.DisplayName))" }
  exit 1
}`,
            severity: 'warn',
            phase: 'post-reboot',
            timeoutS: 120,
        },
        {
            // The regression test for the gray desktop.
            //
            // This reads the event log rather than probing for a taskbar window:
            // `qm guest exec` runs as SYSTEM in session 0, which has its own
            // window station, so FindWindow('Shell_TrayWnd') can never see the
            // interactive session's shell no matter how healthy it is. Crash
            // records cross that boundary; the console screendump is the other
            // half of the signal.
            id: 'shell-no-crashes',
            description: 'no shell process crashed since boot',
            // Filtered by event id, not ProviderName. A ProviderName filter
            // makes Get-WinEvent scan rather than seek: the same query took
            // over 180s against a live Server 2025 clone and timed out, while
            // the id form returned in under 7s. 1000/1001/1002 are Application
            // Error, Windows Error Reporting, and Application Hang — the same
            // records those providers emit.
            script: `$since = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
$names = @(${psList(SHELL_PROCESSES)})
$ev = Get-WinEvent -FilterHashtable @{
  LogName = 'Application'
  Id = 1000,1001,1002
  StartTime = $since
} -MaxEvents 200 -ErrorAction SilentlyContinue
$bad = @()
foreach ($e in $ev) {
  foreach ($n in $names) {
    if ($e.Message -like "*$n*") { $bad += $e; break }
  }
}
if ($bad) {
  Write-Output "$($bad.Count) shell crash record(s) since $since"
  $bad | Select-Object -First 5 | ForEach-Object {
    Write-Output ("[{0}] {1}" -f $_.TimeCreated, ($_.Message -split "\`r?\`n")[0])
  }
  exit 1
}`,
            severity: 'fail',
            phase: 'post-logon',
            timeoutS: 180,
        },
        {
            // Necessary but not sufficient: explorer.exe stayed up during the
            // gray-desktop failure. Paired with shell-no-crashes and the
            // framebuffer check, not trusted on its own.
            id: 'shell-session-present',
            description: 'an interactive session is running the shell',
            script: `$e = Get-Process explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -gt 0 }
if (-not $e) { Write-Output 'no explorer.exe in an interactive session'; exit 1 }
Write-Output "explorer.exe session=$($e[0].SessionId)"`,
            severity: 'fail',
            phase: 'post-logon',
        },
    ],
}
