$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($Message) { Write-Host "==> $Message" }

$WUFlag       = "C:\Windows\Temp\tb-wu-done.flag"
$WURebootFlag = "C:\Windows\Temp\tb-wu-reboot.flag"
$WULog        = "C:\Windows\Temp\tb-wu.log"
$WUScript     = "C:\Windows\Temp\tb-wu.ps1"
$WUTaskName   = "TBWindowsUpdate"

# Install.ps1 suppresses Windows' automatic update/reboot agent for the build,
# but *installing a cumulative update wipes that policy*. Observed live on a
# 2026-08-01 windows-server-2022 build, mid-round-one: the AU key held only
# `AUOptions = 3` -- Install.ps1's NoAutoUpdate and NoAutoRebootWithLoggedOnUsers
# values were gone, UsoSvc was Running, and Schedule Scan / USO_UxBroker were
# back to Ready. Round two then starts with the agent re-armed, the Update
# Orchestrator finds a pending restart and reboots the VM out from under this
# provisioner ~2-3 min in. The process is killed rather than failing, so nothing
# throws and packer only reports `Script exited with non-zero exit status: 1`.
#
# So the suppression cannot be applied once at install time -- it has to be
# re-armed around every round. See docs/windows.md#wu-round-two.
function Set-BuildUpdateSuppression($Phase) {
  $auPolicyPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"
  New-Item -Path $auPolicyPath -Force | Out-Null
  Set-ItemProperty -Path $auPolicyPath -Name "NoAutoUpdate"                  -Value 1 -Type DWord -Force
  Set-ItemProperty -Path $auPolicyPath -Name "NoAutoRebootWithLoggedOnUsers" -Value 1 -Type DWord -Force

  # Owned by TrustedInstaller, so a Disable may be denied -- the AU policy above
  # is the authoritative control. Matches the task list Install.ps1 disables.
  foreach ($t in @("Reboot", "Reboot_AC", "Reboot_Battery")) {
    Disable-ScheduledTask -TaskPath "\Microsoft\Windows\UpdateOrchestrator\" -TaskName $t -ErrorAction SilentlyContinue | Out-Null
  }

  # Report what actually stuck: this is the state that was silently lost before,
  # so a future failure should not have to be diagnosed from outside the guest.
  $applied = Get-ItemProperty -Path $auPolicyPath -ErrorAction SilentlyContinue
  Write-Step ("update suppression ({0}): NoAutoUpdate={1} NoAutoRebootWithLoggedOnUsers={2}" -f `
      $Phase, $applied.NoAutoUpdate, $applied.NoAutoRebootWithLoggedOnUsers)
}

Set-BuildUpdateSuppression "before round"

# Clear state from any prior round. The reboot flag is preserved across the WU
# provisioner and read by the conditional restart_command in the recipe.
Remove-Item $WUFlag       -Force -ErrorAction SilentlyContinue
Remove-Item $WURebootFlag -Force -ErrorAction SilentlyContinue
Remove-Item $WULog        -Force -ErrorAction SilentlyContinue

# WinRM runs with a restricted network token that blocks the Windows Update COM
# API. Run as SYSTEM via a scheduled task with RunLevel Highest instead.
#
# The task loops internally: search -> batched download -> batched install ->
# pending-reboot check. It exits when there's nothing left to install OR when a
# reboot is required, so packer can perform the reboot and re-invoke this
# script for another round.
@'
function Log($msg) { Add-Content "C:\Windows\Temp\tb-wu.log" "[$(Get-Date -Format 'HH:mm:ss')] $msg" }

# Windows Update is normally interactive background work, and Task Scheduler
# also defaults tasks to below-normal priority. This VM is dedicated to image
# construction while this task runs, so favor throughput for the duration of
# the update round. The task itself is registered at normal priority below;
# the high-performance power scheme is restored in finally before the task
# signals completion or Packer reboots the VM.
$activeSchemeOutput = (& powercfg.exe /getactivescheme 2>$null | Out-String)
$activeSchemeMatch = [regex]::Match(
  $activeSchemeOutput,
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
)
$originalPowerScheme = if ($activeSchemeMatch.Success) { $activeSchemeMatch.Value } else { $null }
$powerSchemeChanged = $false

if ($originalPowerScheme) {
  & powercfg.exe /setactive SCHEME_MIN 2>$null
  if ($LASTEXITCODE -eq 0) {
    $powerSchemeChanged = $true
    Log "throughput mode enabled (normal task priority, High performance power scheme)"
  } else {
    Log "could not activate High performance power scheme; continuing with $originalPowerScheme"
  }
} else {
  Log "could not identify active power scheme; continuing without changing it"
}

# Async progress support. The synchronous IUpdateDownloader.Download() and
# IUpdateInstaller.Install() calls block for the whole batch with no output, so
# a single large cumulative update looks hung for many minutes. Their async
# Begin*/End* forms run the identical batch but return a job we can poll for a
# real percentage. Begin* requires COM progress/completed callback objects; we
# supply minimal no-op callbacks (we poll the job ourselves) whose interface
# IIDs must match wuapi.idl exactly or WUA rejects them. If the types fail to
# compile or Begin* throws for any reason, every caller falls back to the
# synchronous batch call, so this can never fail the build -- only lose the
# progress readout for that round.
$asyncCallbacks = $true
if (-not ([System.Management.Automation.PSTypeName]'CfWU.DlProgressCb').Type) {
  try {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace CfWU {
  [ComVisible(true), Guid("8c3f1cdd-6173-4591-aebd-a56a53ca77c1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IDownloadProgressChangedCallback { void Invoke([MarshalAs(UnmanagedType.IUnknown)] object job, [MarshalAs(UnmanagedType.IUnknown)] object args); }
  [ComVisible(true), Guid("77254866-9f5b-4c8e-b9e2-c77a8530d64b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IDownloadCompletedCallback { void Invoke([MarshalAs(UnmanagedType.IUnknown)] object job, [MarshalAs(UnmanagedType.IUnknown)] object args); }
  [ComVisible(true), Guid("e01402d5-f8da-43ba-a012-38894bd048f1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IInstallationProgressChangedCallback { void Invoke([MarshalAs(UnmanagedType.IUnknown)] object job, [MarshalAs(UnmanagedType.IUnknown)] object args); }
  [ComVisible(true), Guid("45f4f6f3-d602-4f98-9a8a-3efa152ad2d3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IInstallationCompletedCallback { void Invoke([MarshalAs(UnmanagedType.IUnknown)] object job, [MarshalAs(UnmanagedType.IUnknown)] object args); }
  [ComVisible(true)] public class DlProgressCb : IDownloadProgressChangedCallback { public void Invoke(object job, object args) {} }
  [ComVisible(true)] public class DlCompletedCb : IDownloadCompletedCallback { public void Invoke(object job, object args) {} }
  [ComVisible(true)] public class InProgressCb : IInstallationProgressChangedCallback { public void Invoke(object job, object args) {} }
  [ComVisible(true)] public class InCompletedCb : IInstallationCompletedCallback { public void Invoke(object job, object args) {} }
}
"@
  } catch {
    Log "async progress callbacks unavailable: $_"
    $asyncCallbacks = $false
  }
}

# Poll a download or installation job (both expose IsCompleted and
# GetProgress().PercentComplete) until it finishes, logging the percentage on
# each 5% step or at least once a minute so the packer-side log tail shows
# steady movement without flooding.
function Wait-WUJob($job, $phase) {
  $lastBucket = -1
  $lastLog    = Get-Date
  while (-not $job.IsCompleted) {
    Start-Sleep -Milliseconds 1500
    $pct = -1
    try { $pct = [int]$job.GetProgress().PercentComplete } catch {}
    if ($pct -lt 0) { continue }
    $bucket = [math]::Floor($pct / 5)
    if ($bucket -ne $lastBucket -or ((Get-Date) - $lastLog).TotalSeconds -ge 60) {
      Log "  $phase $pct%"
      $lastBucket = $bucket
      $lastLog    = Get-Date
    }
  }
}

function Test-PendingReboot {
  if (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending") { return $true }
  if (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired") { return $true }
  $sm = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager" -ErrorAction SilentlyContinue
  if ($sm -and $sm.PSObject.Properties.Name -contains "PendingFileRenameOperations") { return $true }
  try {
    $si = New-Object -ComObject Microsoft.Update.SystemInfo
    if ($si.RebootRequired) { return $true }
  } catch {}
  return $false
}

try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $totalInstalled = 0
  $maxIterations  = 5

  for ($iter = 1; $iter -le $maxIterations; $iter++) {
  Log "iteration $iter - searching for updates..."
  $searcher = $session.CreateUpdateSearcher()
  try {
    # IsInstalled=0: not yet installed. Type=Software: skip drivers (template should
    # stay generic). IsHidden=0: skip anything an admin would have hidden. We do NOT
    # filter on BrowseOnly here -- that excludes legitimate optional updates that
    # may be required for cumulative chains.
    $found = $searcher.Search("IsInstalled=0 and Type='Software' and IsHidden=0")
  } catch {
    Log "search failed: $_"
    break
  }

  if ($found.Updates.Count -eq 0) {
    Log "no pending updates"
    break
  }

  $total = $found.Updates.Count
  Log "found $total update(s):"
  for ($i = 0; $i -lt $total; $i++) { Log "  - $($found.Updates.Item($i).Title)" }

  # Accept EULAs (some optional/feature updates require this before download).
  for ($i = 0; $i -lt $total; $i++) {
    $u = $found.Updates.Item($i)
    if (-not $u.EulaAccepted) { try { $u.AcceptEula() } catch {} }
  }

  Log "downloading $total update(s) in one batch..."
  $dl = $session.CreateUpdateDownloader()
  $dl.Updates = $found.Updates
  try {
    $dlResult = $null
    if ($asyncCallbacks) {
      try {
        $dlJob = $dl.BeginDownload((New-Object CfWU.DlProgressCb), (New-Object CfWU.DlCompletedCb), $null)
        Wait-WUJob $dlJob "download"
        $dlResult = $dl.EndDownload($dlJob)
        try { $dlJob.CleanUp() } catch {}
      } catch {
        Log "async download unavailable ($_); using synchronous batch download"
        $dlResult = $null
      }
    }
    if ($null -eq $dlResult) { $dlResult = $dl.Download() }
    Log "  download result: HResult=$($dlResult.HResult) ResultCode=$($dlResult.ResultCode)"
  } catch {
    Log "download failed: $_"
    break
  }

  # Only install updates that actually downloaded.
  $toInstall = New-Object -ComObject Microsoft.Update.UpdateColl
  for ($i = 0; $i -lt $total; $i++) {
    if ($found.Updates.Item($i).IsDownloaded) { [void]$toInstall.Add($found.Updates.Item($i)) }
  }
  if ($toInstall.Count -eq 0) {
    Log "nothing downloaded successfully - aborting iteration"
    break
  }

  Log "installing $($toInstall.Count) update(s) in one batch..."
  $inst = $session.CreateUpdateInstaller()
  $inst.Updates = $toInstall
  try {
    $instResult = $null
    if ($asyncCallbacks) {
      try {
        $instJob = $inst.BeginInstall((New-Object CfWU.InProgressCb), (New-Object CfWU.InCompletedCb), $null)
        Wait-WUJob $instJob "install"
        $instResult = $inst.EndInstall($instJob)
        try { $instJob.CleanUp() } catch {}
      } catch {
        Log "async install unavailable ($_); using synchronous batch install"
        $instResult = $null
      }
    }
    if ($null -eq $instResult) { $instResult = $inst.Install() }
    Log "  install result: HResult=$($instResult.HResult) ResultCode=$($instResult.ResultCode) RebootRequired=$($instResult.RebootRequired)"
  } catch {
    Log "install failed: $_"
    break
  }

  # Per-update result codes (2=Succeeded, 3=SucceededWithErrors, 4=Failed, 5=Aborted).
  for ($i = 0; $i -lt $toInstall.Count; $i++) {
    $r = $instResult.GetUpdateResult($i)
    Log "    [$($i+1)/$($toInstall.Count)] code=$($r.ResultCode) hr=$($r.HResult)  $($toInstall.Item($i).Title)"
    if ($r.ResultCode -eq 2 -or $r.ResultCode -eq 3) { $totalInstalled++ }
  }

  if ($instResult.RebootRequired -or (Test-PendingReboot)) {
    Log "reboot required - exiting loop so packer can restart"
    Set-Content "C:\Windows\Temp\tb-wu-reboot.flag" "needed"
    break
  }

  Log "no reboot required - looping to check for further updates"
  }

  Log "round complete; installed $totalInstalled update(s) this invocation"
  # Safety net: some loop exits (search/download failure, max iterations) skip
  # the in-loop reboot check, so re-check here. Parentheses around the call are
  # required: without them -and/-not become arguments to Test-PendingReboot and
  # the Test-Path guard is never evaluated.
  if ((Test-PendingReboot) -and -not (Test-Path "C:\Windows\Temp\tb-wu-reboot.flag")) {
    Set-Content "C:\Windows\Temp\tb-wu-reboot.flag" "needed"
  }

  # Final verification. Without the reboot flag the recipe's conditional
  # windows-restart skips and the build proceeds as if the guest were fully
  # patched, so re-search once and surface any leftovers in the log. Leftover
  # updates or a search hiccup only WARN -- matching the loop above, which logs
  # and breaks on search failure instead of failing the build.
  if (-not (Test-Path "C:\Windows\Temp\tb-wu-reboot.flag")) {
    try {
      $remaining = $session.CreateUpdateSearcher().Search("IsInstalled=0 and Type='Software' and IsHidden=0")
      if ($remaining.Updates.Count -gt 0) {
        Log "WARNING: $($remaining.Updates.Count) applicable update(s) still pending after this round:"
        for ($i = 0; $i -lt $remaining.Updates.Count; $i++) { Log "WARNING:   - $($remaining.Updates.Item($i).Title)" }
      } else {
        Log "verified: no applicable updates remain"
      }
    } catch {
      Log "WARNING: could not verify remaining updates: $_"
    }
  }
} finally {
  if ($powerSchemeChanged) {
    & powercfg.exe /setactive $originalPowerScheme 2>$null
    if ($LASTEXITCODE -eq 0) {
      Log "restored power scheme $originalPowerScheme"
    } else {
      Log "warning: could not restore power scheme $originalPowerScheme"
    }
  }
}
Set-Content "C:\Windows\Temp\tb-wu-done.flag" "done"
'@ | Set-Content $WUScript -Encoding UTF8

$action    = New-ScheduledTaskAction -Execute "powershell.exe" `
               -Argument "-ExecutionPolicy Bypass -NonInteractive -File `"$WUScript`""
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
# Task Scheduler's default priority is 7 (below normal). Priority 4 is normal:
# the build VM has no interactive workload to protect during this task.
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 3) -Priority 4
Register-ScheduledTask -TaskName $WUTaskName -Action $action `
  -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $WUTaskName

Write-Step "waiting for Windows Update round to complete..."
$timeout   = [TimeSpan]::FromHours(3)
$stopwatch = [Diagnostics.Stopwatch]::StartNew()
$logOffset = 0

while (-not (Test-Path $WUFlag) -and $stopwatch.Elapsed -lt $timeout) {
  Start-Sleep 30

  # The SYSTEM task writes this log via Add-Content while we read it. A read that
  # collides with its write throws a sharing violation, which $ErrorActionPreference
  # = 'Stop' would turn fatal — failing the whole build (and triggering a full
  # ~1.5h reinstall retry) over a cosmetic progress tail. Read defensively and
  # skip the tick on any error. @() forces array semantics so a single-line log
  # indexes correctly.
  try {
    if (Test-Path $WULog) {
      $lines = @(Get-Content $WULog -ErrorAction Stop)
      if ($lines.Count -gt $logOffset) {
        $lines[$logOffset..($lines.Count - 1)] | ForEach-Object { Write-Host "    $_" }
        $logOffset = $lines.Count
      }
    }
  } catch {}

  $elapsed = $stopwatch.Elapsed
  Write-Host "    (elapsed $([int]$elapsed.TotalMinutes)m, waiting...)"
}

$task = Get-ScheduledTask -TaskName $WUTaskName -ErrorAction SilentlyContinue
$taskInfo = if ($task) { Get-ScheduledTaskInfo -TaskName $WUTaskName -ErrorAction SilentlyContinue } else { $null }

Unregister-ScheduledTask -TaskName $WUTaskName -Confirm:$false -ErrorAction SilentlyContinue

# Final flush of any tail lines. Defensive read for the same reason as the loop.
try {
  if (Test-Path $WULog) {
    $lines = @(Get-Content $WULog -ErrorAction Stop)
    if ($lines.Count -gt $logOffset) {
      $lines[$logOffset..($lines.Count - 1)] | ForEach-Object { Write-Host "    $_" }
    }
  }
} catch {}

if (-not (Test-Path $WUFlag)) {
  if ($taskInfo) {
    Write-Host "Windows Update task state: $($task.State); last result: $($taskInfo.LastTaskResult); last run: $($taskInfo.LastRunTime)"
  }
  throw "Windows Update did not create $WUFlag after $([int]$stopwatch.Elapsed.TotalMinutes)m"
}

# Re-arm before handing back to packer. The installs above are what wipe the
# policy, so setting it again here means the machine comes back from packer's
# reboot already suppressed -- closing the window between boot and the next
# round's Set-BuildUpdateSuppression call, which is when the orchestrator would
# otherwise be free to fire its pending restart.
Set-BuildUpdateSuppression "after round"

if (Test-Path $WURebootFlag) {
  Write-Step "updates installed - reboot required (conditional windows-restart will reboot)"
} else {
  Write-Step "no reboot required - conditional windows-restart will skip"
}

# All failure paths above throw; reaching here is success. Explicit exit 0 so a
# stale $LastExitCode from an earlier native command can't fail the provisioner.
exit 0
