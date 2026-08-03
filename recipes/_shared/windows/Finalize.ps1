$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Write-Step($Message) { Write-Host "==> $Message" }

function Find-FileOnMedia($FileName) {
  foreach ($drive in Get-PSDrive -PSProvider FileSystem) {
    $candidate = Join-Path $drive.Root $FileName
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function ConvertTo-Bytes($Size) {
  # "32G" / "32768M" / "33285996544" -> bytes. G/M/K are 1024-based (GiB/MiB/KiB),
  # matching Proxmox/qemu-img's interpretation of the same suffix on the host.
  if ($Size -match '^\s*(\d+(?:\.\d+)?)\s*([KkMmGgTt]?)[Bb]?\s*$') {
    $n = [double]$Matches[1]
    switch ($Matches[2].ToUpper()) {
      'K' { return [long]($n * 1KB) }
      'M' { return [long]($n * 1MB) }
      'G' { return [long]($n * 1GB) }
      'T' { return [long]($n * 1TB) }
      default { return [long]$n }
    }
  }
  throw "unrecognized disk size '$Size'"
}

# Shrink C: so the partition ends below the final virtual-disk size, leaving a
# margin for the GPT backup header + alignment. The host then truncates the
# qcow2 to CF_FINAL_DISK_SIZE (shrink-disk.sh); cloudbase-init's
# ExtendVolumesPlugin grows C: back to fill the disk on first boot of a clone.
function Shrink-SystemPartition($FinalSize) {
  $marginBytes = 1GB
  $finalBytes  = ConvertTo-Bytes $FinalSize
  $targetBytes = $finalBytes - $marginBytes

  $supported = Get-PartitionSupportedSize -DriveLetter C
  if ($supported.SizeMin -gt $targetBytes) {
    throw ("C: needs at least {0:N0} bytes but final disk {1} (minus 1G margin) is only {2:N0} bytes -- raise final_disk_size." -f $supported.SizeMin, $FinalSize, $targetBytes)
  }
  # Round down to a MiB boundary so the partition end is cleanly below the disk end.
  $targetBytes = [long]([math]::Floor($targetBytes / 1MB) * 1MB)

  $current = (Get-Partition -DriveLetter C).Size
  if ($current -le $targetBytes) {
    Write-Step ("C: already {0:N0} bytes (<= target {1:N0}); no shrink needed" -f $current, $targetBytes)
    return
  }
  Resize-Partition -DriveLetter C -Size $targetBytes
  $after = (Get-Partition -DriveLetter C).Size
  Write-Step ("C: shrunk {0:N0} -> {1:N0} bytes (final disk {2})" -f $current, $after, $FinalSize)
}

# Overwrite free space with zeros so the exported qcow2 compresses. Stops short
# of actually filling the volume, and proves the fill file is gone afterwards.
#
# The first version wrote until ERROR_DISK_FULL and relied on a
# `-ErrorAction SilentlyContinue` delete to give the space back. Both halves of
# that are hazardous: at zero bytes free NTFS can fail the delete itself (the
# change needs journal space), and because the failure was silenced the script
# marched on to sysprep over a full disk. That is what "PROVISIONER ERROR: There
# is not enough space on the disk" was on 2026-08-03 -- reported from the step
# *after* this one, naming nothing.
function Zero-FreeSpace($DriveLetter) {
  # Enough that NTFS metadata operations, sysprep, and the servicing stack all
  # still have room. The zeroing is a compression optimisation; the last GB of
  # it is worth far less than a 3h build.
  $reserveBytes = 1GB
  $root   = "${DriveLetter}:\"
  $target = Join-Path $root "zero.fill"
  $free   = { (Get-PSDrive $DriveLetter).Free }
  if ((& $free) -le $reserveBytes) {
    Write-Step ("  only {0:N1} GB free; skipping zero pass" -f ((& $free) / 1GB))
    return
  }
  $buffer = New-Object byte[] (1024 * 1024)
  $stream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew)
  try {
    # Re-check free space periodically rather than per-MB: Get-PSDrive is far
    # more expensive than the write itself.
    while ($true) {
      for ($i = 0; $i -lt 64; $i++) { $stream.Write($buffer, 0, $buffer.Length) }
      $stream.Flush()
      if ((& $free) -le $reserveBytes) { break }
    }
  } catch [System.IO.IOException] {
    # Something else on the box consumed the reserve while we ran. Not fatal --
    # the gate below is what decides.
  } finally {
    $stream.Close()
  }
  Remove-Item -Force $target -ErrorAction SilentlyContinue
  if (Test-Path $target) {
    throw "could not delete $target after the zero pass - C: would go into sysprep full"
  }
  Write-Step ("  zero pass done; {0:N1} GB free on {1}:" -f ((& $free) / 1GB), $DriveLetter)
}

Write-Step "stop Windows Update service and purge download cache"
Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path "C:\Windows\SoftwareDistribution\Download" -Force -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Step "purge log and cache directories"
$prunePaths = @(
  "C:\Windows\Logs\CBS",
  "C:\Windows\Panther",
  "C:\ProgramData\Microsoft\Windows\WER",
  "C:\Windows\Prefetch",
  "C:\Windows\ServiceProfiles\NetworkService\AppData\Local\Microsoft\Windows\DeliveryOptimization\Cache"
)
foreach ($p in $prunePaths) {
  if (Test-Path $p) {
    Get-ChildItem -Path $p -Force -ErrorAction SilentlyContinue |
      Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Step "empty recycle bin"
Clear-RecycleBin -Force -ErrorAction SilentlyContinue

Write-Step "remove C:\Windows.old if the WU passes left one"
# Server 2025's checkpoint cumulative is applied as a full OS re-deploy, which
# can park the previous OS tree here. Measured on the 2026-08-03 build: the
# directory is present but EMPTY (0 files, 0 enumeration errors), so on this
# release it is a stub and reclaims nothing -- it is *not* the cause of the
# "not enough space" failure, whatever the size of C:\Windows.old suggests.
# Removed anyway because a re-deploy that does leave a populated tree would
# otherwise be shrunk around, zeroed around, and exported, and because an
# unexplained C:\Windows.old in a shipped template is its own bug report.
# The tree is owned by TrustedInstaller, so Remove-Item cannot touch it.
if (Test-Path "C:\Windows.old") {
  $before = (Get-PSDrive C).Free
  & takeown.exe /f "C:\Windows.old" /a /r /d y  | Out-Null
  & icacls.exe "C:\Windows.old" /grant "*S-1-5-32-544:F" /t /c /q | Out-Null
  & cmd.exe /c 'rd /s /q C:\Windows.old' 2>&1 | Out-Null
  if (Test-Path "C:\Windows.old") {
    # Not fatal on its own: the free-space gate before sysprep decides whether
    # what survived actually costs us the build.
    Write-Step "  WARNING C:\Windows.old survived removal; it will be exported"
  } else {
    Write-Step ("  reclaimed {0:N1} GB from C:\Windows.old" -f (((Get-PSDrive C).Free - $before) / 1GB))
  }
} else {
  Write-Step "  no C:\Windows.old present"
}

Write-Step "cleanup component store"
Start-Process -FilePath "dism.exe" `
  -ArgumentList "/Online", "/Cleanup-Image", "/StartComponentCleanup", "/ResetBase" -Wait

Write-Step "clear temp directories and event logs"
Get-ChildItem -Path "C:\Windows\Temp", "$env:TEMP" -Force -ErrorAction SilentlyContinue |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$ErrorActionPreference = "SilentlyContinue"
wevtutil el | ForEach-Object { wevtutil cl $_ 2>&1 | Out-Null }
$ErrorActionPreference = "Stop"

Write-Step "install Cloudbase-Init"
# Installed here -- after the last Windows Update pass, right before sysprep --
# rather than in Install.ps1. On Server 2025 the monthly checkpoint cumulative
# is applied via UpdateAgent as a full OS re-deploy (creates C:\Windows.old),
# and software installed before the WU passes does not reliably survive it.
# At this point nothing destructive runs between the install and the vzdump.
$cloudbaseMsi = Find-FileOnMedia "CloudbaseInitSetup_x64.msi"
if (-not $cloudbaseMsi) {
  $cloudbaseMsi = "C:\Windows\Temp\CloudbaseInitSetup_x64.msi"
  $msiUrl = "https://github.com/cloudbase/cloudbase-init/releases/latest/download/CloudbaseInitSetup_x64.msi"
  Write-Step "downloading Cloudbase-Init from $msiUrl"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  (New-Object System.Net.WebClient).DownloadFile($msiUrl, $cloudbaseMsi)
}
$p = Start-Process -FilePath "msiexec.exe" `
  -ArgumentList "/i", $cloudbaseMsi, "/qn", "/norestart", "RUN_SERVICE_AS_LOCAL_SYSTEM=1" `
  -Wait -PassThru
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  throw "Cloudbase-Init MSI exited $($p.ExitCode)"
}

Write-Step "verify Cloudbase-Init"
$svc = Get-Service -Name "cloudbase-init" -ErrorAction SilentlyContinue
if (-not $svc) { throw "cloudbase-init service not found after install" }
# Keep the service enabled for clones (it applies the cloud-init password on
# first boot) but make sure it is not running during the remaining build steps.
Stop-Service -Name cloudbase-init -Force -ErrorAction SilentlyContinue
Set-Service -Name cloudbase-init -StartupType Automatic -ErrorAction SilentlyContinue

# ALL releases: make Cloudbase-Init delayed-auto-start.
#
# A clone reaches GeneralizationState=7 while OOBE is still on screen, so an
# Automatic-start Cloudbase-Init wakes and runs its plugins before the VDS,
# WMI-licensing, and user-profile subsystems are ready. That first run fails
# ExtendVolumes/Licensing/CreateUser (they only recover after the hostname
# reboot) and races the oobeSystem pass: its SetUserPassword lands before
# oobeSystem re-seeds the AdministratorPassword, so the clone ships with the
# build's throwaway WinRM password instead of the cloud-init one.
#
# This was gated to Server 2019 (BuildNumber <= 17763) on the belief that
# 2022/2025 reach 7 only once OOBE completes. **That is false**, and it is why
# every 2022 clone looped on "The computer restarted unexpectedly": the service
# starts during the specialize pass, runs with cloudbase-init.conf (which has
# SetHostNamePlugin and no allow_reboot=false), renames the machine, and reboots
# the VM mid-pass. Captured from a clone's System event log 2026-08-03:
#
#   id=1074  ...Cloudbase-Init\Python\python.exe | restart
#            | "Cloudbase-Init reboot" | NT AUTHORITY\SYSTEM
#
# It is specifically the *service* run, not the specialize run: the unattend run
# logs "Plugins execution done" / "Stopping Cloudbase-Init service" -- init.py's
# else-branch, i.e. no reboot -- while the clone still carries a populated
# cloudbase-init.log from the service. Delaying the service (~2 min) lets OOBE
# and specialize finish first.
Write-Step "set Cloudbase-Init to delayed auto-start (clone OOBE/specialize timing)"
# Windows PowerShell 5.1's Set-Service has no AutomaticDelayedStart; sc.exe does.
# The spaces after 'start=' are required by sc.exe's argument parser.
& sc.exe config cloudbase-init start= delayed-auto | Out-Null

$cloudbaseConfDir = "C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf"
New-Item -ItemType Directory -Force -Path $cloudbaseConfDir | Out-Null
# The plugins list below intentionally omits CreateUserPlugin. Administrator
# already exists on the clone, so it never needs creating; its only effect is
# opening an Administrator logon session, which re-creates the
# C:\Users\Administrator profile that remove-build-profile.ps1 deletes at specialize
# -- shipping a stale profile again. SetUserPasswordPlugin applies the cloud-init
# password on its own (verified live: the password validates and C:\Users holds only
# Public). Comment kept out here rather than in the .conf so the parser never sees it.
#
# SetUserSSHPublicKeysPlugin is omitted too: the template ships no OpenSSH, so
# there is nothing for seeded keys to grant, and with `--sshkeys` metadata present
# the plugin fails outright ([WinError 2], observed live on a 2019 clone) --
# which cf verify's cloudbase-init-completed correctly reads as a plugin failure.
# Re-add it only if the template ever installs Win32-OpenSSH.
@"
[DEFAULT]
username=Administrator
groups=Administrators
inject_user_password=true
first_logon_behaviour=no
check_latest_version=false
bsdtar_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\bin\bsdtar.exe
mtools_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\bin\
verbose=true
debug=false
logdir=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\log\
logfile=cloudbase-init.log
default_log_levels=comtypes=INFO,suds=INFO,iso8601=WARN,requests=WARN
local_scripts_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\LocalScripts\
metadata_services=cloudbaseinit.metadata.services.configdrive.ConfigDriveService,cloudbaseinit.metadata.services.nocloudservice.NoCloudConfigDriveService
plugins=cloudbaseinit.plugins.common.mtu.MTUPlugin,cloudbaseinit.plugins.windows.ntpclient.NTPClientPlugin,cloudbaseinit.plugins.common.sethostname.SetHostNamePlugin,cloudbaseinit.plugins.common.setuserpassword.SetUserPasswordPlugin,cloudbaseinit.plugins.common.networkconfig.NetworkConfigPlugin,cloudbaseinit.plugins.windows.licensing.WindowsLicensingPlugin,cloudbaseinit.plugins.windows.extendvolumes.ExtendVolumesPlugin,cloudbaseinit.plugins.common.userdata.UserDataPlugin,cloudbaseinit.plugins.common.localscripts.LocalScriptsPlugin

[config_drive]
types=vfat,iso
locations=cdrom,hdd,partition
"@ | Set-Content -Path (Join-Path $cloudbaseConfDir "cloudbase-init.conf") -Encoding ASCII

# Also overwrite cloudbase-init-unattend.conf -- the config the specialize-pass
# RunSynchronous command runs with on a clone's first boot. The MSI's shipped
# copy ran the FULL plugin stage during specialize, which is the root of the
# password-overwrite defect: SetUserPasswordPlugin consumed its run-once slot
# *before* the oobeSystem pass applied the seeded build AdministratorPassword,
# so the build's throwaway password ended up as the clone's final credential
# (verified live on Server 2025, 2026-07-21; see docs/windows.md). Restricting
# the specialize run to MTU + hostname leaves SetUserPasswordPlugin for the
# post-OOBE service run, whose write lands *after* oobeSystem and therefore
# wins -- the same ordering the delayed-auto start gives Server 2019.
# Logged to its own file so cloudbase-init.log stays the service run's record
# (cf verify's cloudbase-init-completed parses that log).
#
# allow_reboot=false is LOAD-BEARING and must not be dropped. SetHostNamePlugin
# requests a reboot after renaming the clone. With cloudbase-init's default
# allow_reboot=true it acts on that itself: configure_host() calls
# osutils.terminate(), which stops the cloudbase-init *service* -- but during
# specialize this runs as a console process, so the service is not started and
# ControlService raises (1062, 'The service has not been started.'), unhandled:
#
#   CRITICAL cloudbaseinit [-] Unhandled error: pywintypes.error:
#     (1062, 'ControlService', 'The service has not been started.')
#
# That non-zero exit takes the `|| exit 2` branch of the RunSynchronous command,
# SetupUGC returns 3, the specialize pass fails, and every clone loops on
# "The computer restarted unexpectedly or encountered an unexpected error"
# without ever reaching OOBE. Observed on a 2026-08-02 clone of an image the
# export gate had already certified as correctly generalized and armed.
#
# The reboot is supposed to be the *unattend's* job: the shipped
# RunSynchronous command is `cloudbase-init.exe ... && exit 1 || exit 2`, and
# exit 1 is what signals WillReboot=OnRequest. cloudbase-init must exit 0 for
# that to happen, which is exactly what allow_reboot=false produces.
#
# reset_service_password=false is load-bearing for the same reason, and was the
# *next* failure once allow_reboot was fixed (2026-08-02, clone of a gate-
# certified image). configure_host() begins with
# _reset_service_password_and_respawn(), which resets the cloudbase-init service
# account's password and re-spawns as that user. During specialize this is a
# console run, not the service, and the call dies:
#
#   init.py configure_host() -> _reset_service_password_and_respawn(osutils)
#   -> osutils.reset_service_password() -> OpenSCManager
#   pywintypes.error: (1115, 'OpenSCManager', 'A system shutdown is in progress.')
#
# Same consequence as before: non-zero exit -> `|| exit 2` -> SetupUGC 4 ->
# specialize fails -> the clone loops on "The computer restarted unexpectedly".
#
# BOTH flags exist in the MSI's stock cloudbase-init-unattend.conf. They went
# missing because this file is overwritten wholesale, so any future rewrite of
# this block must carry them forward.
@"
[DEFAULT]
username=Administrator
groups=Administrators
inject_user_password=true
first_logon_behaviour=no
allow_reboot=false
reset_service_password=false
check_latest_version=false
bsdtar_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\bin\bsdtar.exe
mtools_path=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\bin\
verbose=true
debug=false
logdir=C:\Program Files\Cloudbase Solutions\Cloudbase-Init\log\
logfile=cloudbase-init-unattend.log
default_log_levels=comtypes=INFO,suds=INFO,iso8601=WARN,requests=WARN
metadata_services=cloudbaseinit.metadata.services.configdrive.ConfigDriveService,cloudbaseinit.metadata.services.nocloudservice.NoCloudConfigDriveService
# MTU ONLY. SetHostNamePlugin must NOT run in the specialize pass: renaming the
# machine makes the plugin request a reboot, and cloudbase-init performs that
# reboot itself, mid-pass. Captured from a clone's System event log (2026-08-02):
#
#   id=1074  C:\Program Files\Cloudbase Solutions\Cloudbase-Init\Python\python.exe
#            WIN-8OHAID6OILR | restart | "Cloudbase-Init reboot" | NT AUTHORITY\SYSTEM
#
# The rename had already happened (note the randomized name), then the reboot
# aborted specialize ~11s in, and every clone looped forever on "The computer
# restarted unexpectedly". allow_reboot=false did not prevent this.
#
# The hostname is still applied: cloudbase-init.conf above runs
# SetHostNamePlugin in the post-OOBE service run, where a reboot is normal and
# harmless. MTUPlugin never requests one, so specialize now completes.
plugins=cloudbaseinit.plugins.common.mtu.MTUPlugin

[config_drive]
types=vfat,iso
locations=cdrom,hdd,partition
"@ | Set-Content -Path (Join-Path $cloudbaseConfDir "cloudbase-init-unattend.conf") -Encoding ASCII

if ($env:CF_FINAL_DISK_SIZE) {
  Write-Step "shrink C: for final disk $($env:CF_FINAL_DISK_SIZE)"
  Shrink-SystemPartition $env:CF_FINAL_DISK_SIZE
}

Write-Step "zero free space"
Zero-FreeSpace "C"
Optimize-Volume -DriveLetter C -ReTrim -ErrorAction SilentlyContinue

Write-Step "re-enable system-managed pagefile"
# PreFinalize.ps1 + the windows-restart before this script freed pagefile.sys
# so the zero pass above could compress that space. Restore the default
# "automatically manage" setting so the cloned VM recreates pagefile.sys at
# the correct size on first boot.
$cs = Get-CimInstance -ClassName Win32_ComputerSystem
Set-CimInstance -InputObject $cs -Property @{ AutomaticManagedPagefile = $true }

# NOTE: the ENTIRE WinRM teardown -- keepalive task, Basic/AllowUnencrypted
# policy unpin, and the firewall rules -- deliberately does NOT happen here. All
# of it runs after generalize, near the shutdown at the end of this file. See
# "tear down the build's WinRM exposure" there for why.

Write-Step "remove per-user Appx packages that block generalize"
# sysprep /generalize aborts in pre-validation if any Appx package is registered
# for the current user but not provisioned for all users:
#
#   SYSPRP Package Microsoft.MicrosoftEdge.Stable_150.0.4078.105... was installed
#          for a user, but not provisioned for all users.
#   SYSPRP Failed to remove apps for the current user: 0x80073cf2.
#
# Windows Update does exactly that to Edge mid-build, so the failure appears only
# when a build happens to pick up an Edge update (observed 2026-07-31 on
# windows-server-2022; 2019 is unaffected — legacy Edge is not an Appx package).
# Removing the per-user registration is the supported fix and does not uninstall
# Edge itself, which is a separate Win32 install. Best-effort per package: a
# package that refuses to unregister should not fail the build here, because
# sysprep's own pre-validation is the authority and the host-side
# assert-generalized check is what actually gates the export.
# Enumerate provisioned packages ONCE, keeping the objects (not just names) so
# the deprovision fallback below never has to re-query. Re-querying inside the
# catch is what made that fallback silently no-op on 2026-08-03: it returned
# nothing (or threw) and the outer catch logged "STILL REGISTERED" without ever
# printing a "deprovisioning" line.
$provisionedPkgs = @()
try {
  $provisionedPkgs = @(Get-AppxProvisionedPackage -Online -ErrorAction Stop)
} catch {
  Write-Step "  (could not enumerate provisioned packages: $($_.Exception.Message))"
}
$provisioned = @($provisionedPkgs | ForEach-Object { $_.PackageName })
Write-Step "  $($provisionedPkgs.Count) provisioned package(s) on this image"
# Edge resists unregistration while any of its processes are alive, and a WU
# round that updates Edge leaves them running. Stop them before the attempt.
Get-Process -Name msedge, msedgewebview2, MicrosoftEdgeUpdate -ErrorAction SilentlyContinue |
  Stop-Process -Force -ErrorAction SilentlyContinue

$blockers = @()
try {
  foreach ($pkg in Get-AppxPackage -AllUsers -ErrorAction Stop) {
    # Being provisioned is NOT sufficient to skip. That was the 2026-08-01 13:26Z
    # failure: Edge appears in $provisioned under the exact full name sysprep then
    # rejected, so it was skipped and never unregistered. Provisioning covers a
    # package *version*; a WU round installs a newer Edge for the current user, and
    # it is that per-user registration generalize refuses. Only skip when nothing
    # is actually registered to a user -- a purely staged package is harmless.
    $registered = @()
    try {
      $registered = @($pkg.PackageUserInformation |
        Where-Object { $_.InstallState -eq "Installed" })
    } catch {
      # Cannot tell -- fall through and attempt removal rather than assume safe.
    }
    if (($provisioned -contains $pkg.PackageFullName) -and $registered.Count -eq 0) { continue }

    # Framework packages (VCLibs, .NET Native, …) cannot be removed while any
    # dependent package remains -- Windows answers "cannot remove framework".
    # sysprep does not object to them, so attempting them only produces noise and
    # inflates the blocker list. Observed on 2026-08-03 windows-server-2025.
    if ($pkg.IsFramework) { continue }

    # Packages Windows marks non-removable cannot be unregistered by any route --
    # -AllUsers returns 0x80070032 ERROR_NOT_SUPPORTED and per-user returns
    # 0x80073CFA (both confirmed on a live 2025 guest, 2026-08-03). Attempting
    # them is not merely noise: the failure drives the deprovision fallback
    # below, and that is what actually broke the build. See the fallback comment.
    #
    # sysprep tolerates these -- the 2026-08-03 image had 41 registered,
    # non-provisioned, non-removable inbox SystemApps and generalize objected to
    # exactly one package, the single Store-signed one whose provisioning the
    # fallback had just stripped.
    if ($pkg.NonRemovable) { continue }

    Write-Step "  unregistering $($pkg.PackageFullName)"
    try {
      Remove-AppxPackage -Package $pkg.PackageFullName -AllUsers -ErrorAction Stop
    } catch {
      Write-Step "    unregister failed: $($_.Exception.Message)"
      # A per-user registration that will not go usually needs its provisioned
      # entry dropped first, which also stops it re-registering at next logon.
      #
      # Match on the family, not DisplayName equality: 2025 ships TWO versions of
      # Microsoft.DesktopAppInstaller (1.26.510.0 registered per-user, which
      # sysprep rejects, and 1.29.280.0), and removal of the stale one fails with
      # 0x80070032 ERROR_NOT_SUPPORTED until the provisioned entry goes. Use the
      # already-enumerated list so a failed/slow re-query cannot silently skip this.
      #
      # NEVER drop the provisioned entry for the very version that is
      # registered. Deprovisioning it does not help the removal, and it converts
      # a package sysprep was perfectly happy with -- registered AND provisioned
      # -- into the one state sysprep refuses. That is not hypothetical: on
      # 2026-08-03 windows-server-2025 entered Finalize with 5 provisioned
      # packages and left with 0, because every deprovision here reported
      # "Removal failed. Please contact your software vendor." while still
      # removing the provisioning registration. Generalize then aborted
      # 0x80073cf2 on Microsoft.SecHealthUI -- which the WU "Windows Security
      # platform" update (KB5007651) had made a Store-signed, non-removable
      # package that arrived correctly provisioned. The cleanup manufactured its
      # own blocker and cost two 3h04m builds.
      $match = @($provisionedPkgs | Where-Object {
        ($_.DisplayName -eq $pkg.Name -or $_.PackageName -like "$($pkg.Name)_*") -and
        $_.PackageName -ne $pkg.PackageFullName
      })
      Write-Step "    $($match.Count) provisioned entr(y/ies) match $($pkg.Name)"
      foreach ($pp in $match) {
        try {
          Write-Step "    deprovisioning $($pp.PackageName)"
          Remove-AppxProvisionedPackage -Online -PackageName $pp.PackageName -ErrorAction Stop | Out-Null
        } catch {
          Write-Step "      deprovision failed: $($_.Exception.Message)"
        }
      }
      try {
        Remove-AppxPackage -Package $pkg.PackageFullName -AllUsers -ErrorAction Stop
        Write-Step "    recovered after deprovisioning"
      } catch {
        $blockers += $pkg.PackageFullName
        Write-Step "    STILL REGISTERED: $($_.Exception.Message)"
      }
    }
  }
} catch {
  Write-Step "  (Appx enumeration unavailable: $($_.Exception.Message))"
}

# Still best-effort -- sysprep's pre-validation is the authority and
# assert-generalized gates the export -- but never silent. The 2026-08-01 build
# swallowed this failure and paid for it three hours later with a bare
# 0x80073cf2 sysprep abort, with nothing in the build log naming the package.
if ($blockers.Count) {
  Write-Step "  WARNING $($blockers.Count) package(s) registered for a user but not provisioned; sysprep generalize aborts 0x80073cf2 on these:"
  foreach ($b in $blockers) { Write-Step "    $b" }
}

Write-Step "sysprep and shutdown"

# Everything from here to the shutdown -- copying the answer file, rewriting it,
# generalize itself -- needs somewhere to write. When C: is full those failures
# surface as bare "There is not enough space on the disk" from whichever
# statement happened to be first, naming neither the drive nor the cause. Check
# it once, up front, and say what filled up.
$freeGB = (Get-PSDrive C).Free / 1GB
Write-Step ("  C: has {0:N1} GB free before generalize" -f $freeGB)
if ($freeGB -lt 0.75) {
  $hogs = Get-ChildItem C:\ -Force -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {
      $b = (Get-ChildItem $_.FullName -Recurse -Force -File -ErrorAction SilentlyContinue |
        Measure-Object Length -Sum).Sum
      [pscustomobject]@{ Path = $_.FullName; GB = [math]::Round($b / 1GB, 1) }
    } | Sort-Object GB -Descending | Select-Object -First 8
  foreach ($h in $hogs) { Write-Step ("    {0,6:N1} GB  {1}" -f $h.GB, $h.Path) }
  throw ("only {0:N1} GB free on C: - sysprep needs room to generalize. Largest directories are listed above; if this is C:\Windows.old the reclaim step above failed, otherwise raise final_disk_size." -f $freeGB)
}

# Pass cloudbase-init's bundled Unattend.xml so OOBE on the cloned VM auto-
# completes (accepts EULA, skips the machine and user OOBE screens) and its
# specialize pass runs cloudbase-init to set the hostname. Without this, first
# boot blocks in noVNC waiting for an operator, and the cloudbase-init service
# can't start until OOBE finishes -- which defeats unattended cloning.
$sysprepUnattend = "C:\Program Files\Cloudbase Solutions\Cloudbase-Init\conf\Unattend.xml"
if (-not (Test-Path $sysprepUnattend)) {
  throw "cloudbase-init Unattend.xml not found at $sysprepUnattend - was Cloudbase-Init installed?"
}
# Copy to a space-free path: with the "Program Files" path, Start-Process's
# argument joining mangles the quoting and sysprep aborts with "Unable to
# parse command-line arguments" -- while still exiting 0, so the build
# "succeeds" with a non-generalized image. (Sysprep caches the answer file
# into C:\Windows\Panther at generalize, so the temp source path is fine.)
$unattendCopy = "C:\Windows\Temp\cb-sysprep-unattend.xml"
Copy-Item $sysprepUnattend $unattendCopy -Force

# Drop the build's Administrator profile on the clone's first boot.
#
# sysprep /generalize does NOT remove existing user profiles, so without this the
# template ships C:\Users\Administrator exactly as the build left it. That
# profile's per-user shell state predates generalize and no longer matches the
# shell packages re-registered at OOBE, so on the clone ShellHost.exe __fastfails
# (0xc0000409 in ControlCenter.dll) roughly every 30s: explorer.exe runs, but no
# desktop, wallpaper, or taskbar ever paints -- just a gray field with a working
# Ctrl+Alt+Del. A profile created *after* generalize is fine, so the fix is to
# not ship the stale one and let first logon build a fresh profile.
#
# This can't be done from this script: Packer is logged in as Administrator with
# that profile loaded. The specialize pass runs as SYSTEM on the clone before any
# logon, which is the first point the profile is deletable. See docs/windows.md.
$removeProfileScript = "C:\Windows\Setup\Scripts\remove-build-profile.ps1"
New-Item -ItemType Directory -Force -Path (Split-Path $removeProfileScript) | Out-Null
@'
# Runs in the specialize pass on a clone. Best-effort by design: a clone that
# boots with a stale profile is broken, but one that fails to delete an already
# absent profile is not, so nothing here should abort specialize.
$ErrorActionPreference = "SilentlyContinue"
$target = Join-Path $env:SystemDrive "Users\Administrator"
# Remove-CimInstance takes the ProfileList registry entry with it; a bare
# Remove-Item would orphan that key and Windows would refuse to recreate the
# profile at the same path, silently falling back to Administrator.TEMPLATE.
Get-CimInstance Win32_UserProfile |
  Where-Object { $_.LocalPath -eq $target } |
  Remove-CimInstance
if (Test-Path $target) { Remove-Item -Recurse -Force $target }

# Shred the answer file handed to sysprep. It carries <AdministratorPassword> in
# plain text, and unlike C:\Windows\Panther\unattend.xml (which Windows is
# expected to scrub) nothing cleans up this copy -- it was still sitting in
# C:\Windows\Temp on an inspected clone. Sysprep cached what it needed at
# generalize, so it is dead weight by the time specialize runs.
Remove-Item -Force "C:\Windows\Temp\cb-sysprep-unattend.xml" -ErrorAction SilentlyContinue
'@ | Set-Content -Path $removeProfileScript -Encoding ASCII

# Inject the deletion into the unattend's existing specialize RunSynchronous
# block. Built through the XML DOM rather than string edits so .NET handles
# attribute escaping and the wcm: prefix already declared on the component.
[xml]$unattendXml = Get-Content $unattendCopy
$nsUri = $unattendXml.DocumentElement.NamespaceURI
$wcmUri = "http://schemas.microsoft.com/WMIConfig/2002/State"
$ns = New-Object System.Xml.XmlNamespaceManager($unattendXml.NameTable)
$ns.AddNamespace("u", $nsUri)
$runSync = $unattendXml.SelectSingleNode(
  "/u:unattend/u:settings[@pass='specialize']/u:component[@name='Microsoft-Windows-Deployment']/u:RunSynchronous", $ns)
if (-not $runSync) {
  throw "sysprep unattend has no specialize RunSynchronous node to extend - did the Cloudbase-Init Unattend.xml layout change?"
}

# Drop cloudbase-init's own specialize entry entirely.
#
# The MSI ships it as `cloudbase-init.exe --config-file …-unattend.conf && exit 1
# || exit 2`, where exit 1 means "reboot requested" (WillReboot=OnRequest). Every
# clone failure chased on 2026-08-02 traced back to that command:
#
#   allow_reboot default true   -> crashed stopping its own service (1062)
#   reset_service_password true -> crashed on OpenSCManager (1115)
#   SetHostNamePlugin           -> renamed in specialize, and the pending reboot
#                                  landed mid-OOBE, leaving SetupType=2 +
#                                  OOBEInProgress=1 and setup.exe looping on
#                                  "The computer restarted unexpectedly"
#
# Each was fixed and the next surfaced. With SetHostNamePlugin removed the run
# did nothing but MTU, and the guest still rebooted ~44s into specialize with
# cloudbase-init's log ending mid-plugin -- so the command was still derailing
# the pass without doing anything the service run does not already do.
#
# Removing it is not a loss of function. The specialize run existed only to keep
# SetUserPasswordPlugin *out* of specialize (it would consume its run-once slot
# before oobeSystem seeds the AdministratorPassword, shipping the build's
# throwaway password). Deleting the command achieves that outright, and the
# post-OOBE service run still applies MTU, hostname and password in the correct
# order. Specialize is then just our profile cleanup: one command, exit 0, no
# reboot request, nothing that can strand OOBE.
$removed = 0
foreach ($existing in @($runSync.SelectNodes("u:RunSynchronousCommand", $ns))) {
  $pathNode = $existing.SelectSingleNode("u:Path", $ns)
  if ($pathNode -and $pathNode.InnerText -match 'cloudbase-init') {
    $runSync.RemoveChild($existing) | Out-Null
    $removed++
  }
}
Write-Step "  removed $removed cloudbase-init specialize command(s) from the unattend"

# Renumber whatever remains, then take Order 1 for the profile cleanup below.
$order = 2
foreach ($existing in @($runSync.SelectNodes("u:RunSynchronousCommand", $ns))) {
  $orderNode = $existing.SelectSingleNode("u:Order", $ns)
  $orderNode.InnerText = [string]$order
  $order++
}

$cmdNode = $unattendXml.CreateElement("RunSynchronousCommand", $nsUri)
$cmdNode.SetAttribute("action", $wcmUri, "add") | Out-Null
# Child order follows the sequence the shipped file already uses (Order, Path,
# Description); the unattend schema validates RunSynchronousCommand as a sequence.
foreach ($pair in @(
    @("Order", "1"),
    @("Path", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File $removeProfileScript"),
    @("Description", "Remove the stale build Administrator profile"))) {
  $child = $unattendXml.CreateElement($pair[0], $nsUri)
  $child.InnerText = $pair[1]
  $cmdNode.AppendChild($child) | Out-Null
}
$runSync.PrependChild($cmdNode) | Out-Null

# Make OOBE complete unattended, so the clone reaches a logon instead of an
# interactive OOBE screen.
#
# Cloudbase-Init's Unattend.xml drives OOBE with the deprecated <SkipMachineOOBE>
# and <SkipUserOOBE>. The replacement is the explicit Hide* screen set plus an
# AdministratorPassword -- the same combination the per-recipe autounattend.xml
# uses to clear OOBE unattended during the build. (The International-Core component
# added below covers the one screen Hide* cannot -- see that block.)
$oobe = $unattendXml.SelectSingleNode(
  "/u:unattend/u:settings[@pass='oobeSystem']/u:component[@name='Microsoft-Windows-Shell-Setup']/u:OOBE", $ns)
if (-not $oobe) {
  throw "sysprep unattend has no oobeSystem OOBE node - did the Cloudbase-Init Unattend.xml layout change?"
}

# The unattend schema validates OOBE's children as an ordered sequence, so the
# node is rebuilt in schema order rather than appended to. Values already present
# in the shipped file win, so this does not silently override Cloudbase-Init's
# NetworkLocation/ProtectYourPC choices.
$oobeSettings = [ordered]@{
  HideEULAPage              = "true"
  HideLocalAccountScreen    = "true"
  HideOEMRegistrationScreen = "true"
  HideOnlineAccountScreens  = "true"
  HideWirelessSetupInOOBE   = "true"
  NetworkLocation           = "Work"
  ProtectYourPC             = "1"
}
foreach ($key in @($oobeSettings.Keys)) {
  $existingNode = $oobe.SelectSingleNode("u:$key", $ns)
  if ($existingNode) { $oobeSettings[$key] = $existingNode.InnerText }
}
while ($oobe.HasChildNodes) { $oobe.RemoveChild($oobe.FirstChild) | Out-Null }
foreach ($key in $oobeSettings.Keys) {
  $el = $unattendXml.CreateElement($key, $nsUri)
  $el.InnerText = $oobeSettings[$key]
  $oobe.AppendChild($el) | Out-Null
}

# Without an Administrator password OOBE stops and asks for one, which is the
# interactive block this whole answer file exists to avoid. Cloudbase-Init
# overwrites it with the cloud-init password seconds into first boot; this value
# only has to carry the clone from OOBE to that point. It is the build's own
# WinRM password rather than a literal in the repo, so it stays out of version
# control and remains a known fallback if Cloudbase-Init's password injection
# fails (e.g. a cloud-init password that violates the guest password policy).
#
# Exposure: Windows is expected to scrub password fields to
# *SENSITIVE*DATA*DELETED* in the copy it caches at C:\Windows\Panther, but that
# has NOT been verified on this image -- do not rely on it alone. The specialize
# script above deletes the C:\Windows\Temp copy, which nothing else cleans up.
# Both still sit in the exported template disk until a clone first boots, so
# treat the template artifact as holding the build's WinRM password.
if (-not $env:CF_ADMIN_PASSWORD) {
  throw "CF_ADMIN_PASSWORD is not set - the recipe must pass it to Finalize.ps1 via environment_vars"
}
$shellSetup = $oobe.ParentNode
$existingAccounts = $shellSetup.SelectSingleNode("u:UserAccounts", $ns)
if ($existingAccounts) { $shellSetup.RemoveChild($existingAccounts) | Out-Null }
$userAccounts = $unattendXml.CreateElement("UserAccounts", $nsUri)
$adminPassword = $unattendXml.CreateElement("AdministratorPassword", $nsUri)
foreach ($pair in @(@("Value", $env:CF_ADMIN_PASSWORD), @("PlainText", "true"))) {
  $child = $unattendXml.CreateElement($pair[0], $nsUri)
  $child.InnerText = $pair[1]
  $adminPassword.AppendChild($child) | Out-Null
}
$userAccounts.AppendChild($adminPassword) | Out-Null
# UserAccounts follows OOBE in the Shell-Setup sequence, matching autounattend.xml.
$shellSetup.InsertAfter($userAccounts, $oobe) | Out-Null

# Add a Microsoft-Windows-International-Core component to the oobeSystem pass so a
# clone's OOBE does not stop at the region/language/keyboard screen ("Hi there").
#
# Cloudbase-Init's shipped Unattend.xml carries only a Shell-Setup component. The
# Hide* settings above suppress the EULA, local-account, and OEM screens, but none
# of them covers the first regional screen -- that one is skipped only by supplying
# locale settings, which the per-recipe autounattend.xml does during the build but
# the clone's answer file does not. Without this, Server 2019's OOBE reaches "Hi
# there" and blocks for an operator: GeneralizationState still advances to 7 and
# Cloudbase-Init runs every plugin, but OOBE never completes, so the clone never
# reaches an unattended logon (cf verify's shell-session-present fails, and a live
# clone sits in noVNC). Confirmed live: adding this component lets OOBE complete to
# the logon screen. en-US mirrors the build's autounattend; Server 2022/2025 skip
# the screen on their own, so pre-answering it there is a harmless no-op.
$oobeSystemNode = $shellSetup.ParentNode
$intlName = "Microsoft-Windows-International-Core"
if (-not $oobeSystemNode.SelectSingleNode("u:component[@name='$intlName']", $ns)) {
  $intl = $unattendXml.CreateElement("component", $nsUri)
  foreach ($attr in @(
      @("name", $intlName),
      @("processorArchitecture", "amd64"),
      @("publicKeyToken", "31bf3856ad364e35"),
      @("language", "neutral"),
      @("versionScope", "nonSxS"))) {
    $intl.SetAttribute($attr[0], $attr[1])
  }
  foreach ($locale in @("InputLocale", "SystemLocale", "UILanguage", "UserLocale")) {
    $el = $unattendXml.CreateElement($locale, $nsUri)
    $el.InnerText = "en-US"
    $intl.AppendChild($el) | Out-Null
  }
  $oobeSystemNode.PrependChild($intl) | Out-Null
}

$unattendXml.Save($unattendCopy)

# Suppress the privacy/diagnostic-data prompt that Windows shows on a new
# profile's first logon. SkipUserOOBE in the unattend does not cover it (it is
# per-profile first-run, not OOBE), and with the stale profile gone every clone
# now creates a fresh profile and would hit it. Without this the template still
# works, but first logon stops for an operator click -- the same unattended-clone
# regression the answer file exists to avoid.
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE" `
  -Name "DisablePrivacyExperience" -Value 1 -Type DWord

# Minimize diagnostic data. Note this is a separate decision from the setting
# above: DisablePrivacyExperience only skips the *prompt* and accepts Windows'
# defaults -- it does not reduce collection. Level 0 ("Security") is the lowest
# value and is honored only on Enterprise/Server SKUs, which Server 2025
# Datacenter is; on other SKUs it silently behaves as 1 ("Required"). Left
# deliberately as a policy key so an operator can raise it on a clone.
New-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\DataCollection" `
  -Name "AllowTelemetry" -Value 0 -Type DWord

# ProtectYourPC in the unattend is deliberately left at 1 (recommended settings).
# It gates Defender, SmartScreen, and automatic updates rather than telemetry, so
# lowering it to 3 would weaken the shipped template's security posture without
# meaningfully improving privacy -- AllowTelemetry above is the correct lever.

# Gate sysprep on a fully settled system (Server 2019 generalize reliability).
#
# 2019's sysprep /generalize intermittently produced a template whose clones never
# ran specialize: the image shipped with SetupType=0 (OOBE unarmed), so windeploy
# never launched, the queued /respecialize failed ("the machine is in an invalid
# state", hr=0x8007001f), and GeneralizationState stuck at 3 forever. The broken
# build's differentiator was a cleanly-installed cumulative at sysprep time, so
# generalize is not allowed to race half-applied servicing. NOTE the generalize
# error lines once blamed for this (MRTGeneralize "Failed ConnectServer",
# "Compat-Gentel", BCD c000000d) were falsified as indicators on 2026-07-31: a
# template whose hives were verified armed offline carries all of them, and they
# appear with this settle gate active too. Benign noise -- do not key off them.
# See docs/windows.md ("Mode B").
Write-Step "wait for a settled system before sysprep"

# 1. No half-applied servicing. A generalize captured over a pending CBS operation
# or a queued file-rename is exactly the corrupt-image case. The WU pass and the
# windows-restart before this script normally clear it; wait a bounded time in case
# the last cumulative deferred work, then fail loudly rather than ship a silently
# broken template.
$cbsKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing"
$sessionMgr = "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager"
$servicingDeadline = [DateTime]::Now.AddMinutes(10)
while ([DateTime]::Now -lt $servicingDeadline) {
  $pending = (Test-Path "$cbsKey\RebootPending") -or (Test-Path "$cbsKey\PackagesPending") -or
    (Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\WindowsUpdate\Auto Update\RebootRequired") -or
    [bool](Get-ItemProperty $sessionMgr -Name PendingFileRenameOperations -ErrorAction SilentlyContinue)
  if (-not $pending) { break }
  Start-Sleep 15
}
if ((Test-Path "$cbsKey\RebootPending") -or (Test-Path "$cbsKey\PackagesPending")) {
  throw "servicing still pending before sysprep (CBS RebootPending/PackagesPending) - a generalize over this state ships a template whose clones never specialize"
}

# 2. WMI must answer. Several generalize providers query it; confirm it responds
# before sysprep runs (probe only -- restarting it drags dependent services down
# right before generalize, which is riskier than waiting).
$wmiOk = $false
foreach ($i in 1..30) {
  try { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Out-Null; $wmiOk = $true; break }
  catch { Start-Sleep 5 }
}
if (-not $wmiOk) { throw "WMI (winmgmt) not responding before sysprep - generalize would race it" }

# 3. Let the Windows Modules Installer finish any transaction, then settle.
Wait-Process -Name TiWorker, TrustedInstaller -Timeout 300 -ErrorAction SilentlyContinue
Start-Sleep 45

# Sysprep via /quit, gated on the image actually being armed for OOBE.
#
# /generalize /oobe leaves three markers when the reseal completed: SetupType=2 and
# CmdLine=oobe\windeploy.exe under HKLM\SYSTEM\Setup (they arm windeploy.exe, which
# runs specialize/OOBE on the clone's first boot), and
# ImageState=IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE in the SOFTWARE hive. The Mode-B
# failure ships without them, and no other signal catches that: sysprep exits 0 and
# writes Sysprep_succeeded.tag even then, and its error log cannot be grepped for
# it (see the falsified-noise note above -- an earlier retry heuristic keyed on
# Compat-Gentel/RunExternalDlls lines matched known-good builds). So run sysprep
# with /quit instead of /shutdown to keep control, assert the armed markers
# directly, and retry once on failure (two generalizes stay well inside the
# activation rearm limit). If the image still is not armed, fail the build: an
# unarmed template is certainly broken on every clone, and failing here turns a
# 900s clone-verify timeout into an in-build CF_BUILD_ATTEMPTS retry.
function Test-GeneralizeArmed {
  $setup = Get-ItemProperty "HKLM:\SYSTEM\Setup" -ErrorAction SilentlyContinue
  $imageState = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State" -ErrorAction SilentlyContinue).ImageState
  return ($setup.SetupType -eq 2) -and
    ($setup.CmdLine -match "windeploy\.exe") -and
    ($imageState -eq "IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE")
}

# Sysprep's own account of why it refused, echoed into packer's output.
#
# The gate below used to fail with a message telling the reader to "check
# C:\Windows\System32\Sysprep\Panther\setuperr.log" -- advice nobody can act on,
# because packer runs its cleanup and deletes the VM within seconds of the
# provisioner erroring. On 2026-08-03 that cost two consecutive 3h04m
# windows-server-2025 attempts which both failed to arm and both produced zero
# diagnosis; the log had to be recovered by polling the guest from the node in
# the few minutes before the machine disappeared. The logs must come out through
# the one channel that survives the VM: packer's stdout.
function Show-SysprepDiagnostics($Attempt) {
  Write-Step "  --- sysprep diagnostics (attempt $Attempt) ---"
  $setup = Get-ItemProperty "HKLM:\SYSTEM\Setup" -ErrorAction SilentlyContinue
  $state = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Setup\State" -ErrorAction SilentlyContinue
  Write-Step ("    SetupType={0} CmdLine='{1}' OOBEInProgress={2} ImageState={3}" -f `
    $setup.SetupType, $setup.CmdLine, $setup.OOBEInProgress, $state.ImageState)
  foreach ($log in @(
      "C:\Windows\System32\Sysprep\Panther\setuperr.log",
      "C:\Windows\System32\Sysprep\Panther\setupact.log")) {
    if (-not (Test-Path $log)) { Write-Step "    <missing> $log"; continue }
    # setupact runs to megabytes and is only useful near the failure; setuperr is
    # short and wanted whole.
    $tail = if ($log -match "setuperr") { 200 } else { 60 }
    Write-Step "    --- $log (last $tail lines) ---"
    Get-Content -Tail $tail $log -ErrorAction SilentlyContinue |
      ForEach-Object { Write-Host "      $_" }
  }
}

$tagPath = "C:\Windows\System32\Sysprep\Sysprep_succeeded.tag"
$gateLog = "C:\Windows\Temp\cf-sysprep-retry.log"
$maxAttempts = 2
$armed = $false
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
  Remove-Item $tagPath -Force -ErrorAction SilentlyContinue
  Write-Step "sysprep generalize (attempt $attempt/$maxAttempts)"
  $p = Start-Process -FilePath "C:\Windows\System32\Sysprep\Sysprep.exe" `
    -ArgumentList "/generalize", "/oobe", "/quit", "/quiet", "/unattend:$unattendCopy" `
    -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "Sysprep exited $($p.ExitCode)" }
  # The tag is still required -- its absence catches runs that never generalized
  # at all (e.g. the command-line parse failure that exits 0).
  $deadline = [DateTime]::Now.AddMinutes(3)
  while (-not (Test-Path $tagPath) -and [DateTime]::Now -lt $deadline) { Start-Sleep 5 }
  $armed = (Test-Path $tagPath) -and (Test-GeneralizeArmed)
  $setup = Get-ItemProperty "HKLM:\SYSTEM\Setup" -ErrorAction SilentlyContinue
  ("[{0}] attempt {1}: sysprepExit={2} tag={3} SetupType={4} CmdLine='{5}' armed={6}" -f `
      (Get-Date -Format s), $attempt, $p.ExitCode, (Test-Path $tagPath), $setup.SetupType, $setup.CmdLine, $armed) |
    Out-File -Append -Encoding ascii $gateLog
  if ($armed) { break }
  # Dump per attempt, not just at the end: attempt 2 overwrites Panther, so a
  # single dump after the loop can only ever explain the last failure.
  Show-SysprepDiagnostics $attempt
  if ($attempt -lt $maxAttempts) { Start-Sleep 45 }
}
if (-not $armed) {
  throw "sysprep did not arm the image for OOBE after $maxAttempts attempts (need SetupType=2 + windeploy CmdLine + IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE) - an unarmed template sticks every clone at GeneralizationState 3; sysprep's own logs are dumped above"
}

Write-Step "restore Windows Update automatic-reboot behavior"
# Install.ps1 disabled WU auto-update/auto-reboot for the build so a pending
# cumulative could not restart the VM mid-provisioner. Restore it only now, after
# generalize: the template still ships Windows' default update policy (registry
# writes after /quit land in the sealed image), but the orchestrator can no longer
# fire a restart between here and the power-off below -- a reboot in that window
# would let windeploy consume the armed SetupType on the build VM and export a
# Mode-B template.
Remove-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" -Force -Recurse -ErrorAction SilentlyContinue
foreach ($t in @("Reboot", "Reboot_AC", "Reboot_Battery")) {
  Enable-ScheduledTask -TaskPath "\Microsoft\Windows\UpdateOrchestrator\" -TaskName $t -ErrorAction SilentlyContinue | Out-Null
}

# The sysprep answer-file copy carries the plaintext AdministratorPassword and is
# dead weight once generalize has cached it into C:\Windows\Panther. Deleting it
# here (instead of only at clone specialize) keeps it out of the exported template
# disk entirely; the specialize-script deletion stays as a backstop.
Remove-Item $unattendCopy -Force -ErrorAction SilentlyContinue

Write-Step "tear down the build's WinRM exposure"
# EVERYTHING that can cut packer's WinRM session MUST stay here, after generalize
# and immediately before the shutdown. Nothing above this point may touch WinRM
# auth, its policy keys, or its firewall rules.
#
# This bit the build twice on 2026-08-01, the second time because only half the
# teardown was moved:
#   13:26Z  the firewall rules ran before sysprep. The build NIC is on an
#           unidentified (Public-profile) network, so removing them dropped the
#           session mid-script.
#   21:45Z  the firewall move worked -- Finalize reached the Appx step for the
#           first time -- but the Basic/AllowUnencrypted unpin was still up
#           there, and packer connects with exactly Basic over unencrypted HTTP.
#           Turning both off cut the session just as effectively.
#
# In both cases the script kept running on the guest while its output and exit
# code went nowhere, and packer read the disconnect as provisioner success and
# exported a never-generalized template. That is the 2026-07-31 silent export.
#
# Running it here is safe: sysprep used /quit, so the machine is still up, and
# registry writes after generalize land in the sealed image (same reason the WU
# policy restore above sits here). Losing the session now costs nothing, because
# the only remaining action is the power-off.
Unregister-ScheduledTask -TaskName "PackerWinRMKeepalive" -Confirm:$false -ErrorAction SilentlyContinue
Remove-Item "C:\Windows\System32\packer-winrm-keepalive.ps1" -Force -ErrorAction SilentlyContinue
# Remove the Group Policy registry keys that pinned Basic auth / AllowUnencrypted
# during the build so the sysprep'd template ships with WinRM in its secure default state.
Remove-Item -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WinRM\Service" -Force -ErrorAction SilentlyContinue
# Must go through cmd.exe: from PowerShell the @{...} argument is parsed as a
# hashtable and winrm.cmd receives "System.Collections.Hashtable".
# Best-effort - the authoritative unpin is the policy-key removal.
cmd.exe /c 'winrm set winrm/config/service @{AllowUnencrypted="false"} >nul 2>&1'
cmd.exe /c 'winrm set winrm/config/service/auth @{Basic="false"} >nul 2>&1'
#
# WinRM itself is deliberately left running: on Windows Server (unlike client
# SKUs) the service, the HTTP listener on 5985, and the Domain/Private firewall
# rules are all enabled out of the box, so disabling them would ship a template
# that deviates from stock Server behavior.
#
# What the build adds on top of that is removed here:
#   - "WinRM-HTTP", created by autounattend.xml's netsh command, applies to every
#     profile including Public.
#   - the stock "Windows Remote Management (HTTP-In)" rule bound to the Public
#     profile, which winrm quickconfig enables and which is not on by default.
# Both leave the management port reachable on untrusted networks on every clone.
Remove-NetFirewallRule -Name "WinRM-HTTP" -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName "WinRM-HTTP" -ErrorAction SilentlyContinue
Get-NetFirewallRule -DisplayName "Windows Remote Management (HTTP-In)" -ErrorAction SilentlyContinue |
  Where-Object { $_.Profile -match "Public" } |
  Disable-NetFirewallRule -ErrorAction SilentlyContinue

# Completion sentinel. THIS MUST BE THE LAST THING WRITTEN before the power-off.
#
# Finalize has silently truncated twice (2026-08-01/02): once when the firewall
# teardown ran before sysprep, once when the Basic/AllowUnencrypted unpin did.
# Both severed packer's WinRM session, so the script kept running on the guest
# with its output and exit code going nowhere and packer read the disconnect as
# SUCCESS. The export gate catches truncation *before* sysprep (the image is not
# generalized), but truncation *after* it is invisible: the image generalizes
# fine and merely ships with the build's WinRM exposure still in place.
#
# The sentinel closes that hole generically -- any future step that kills the
# session, anywhere in this script, means this file never lands and
# assert-generalized refuses the export. Do not move it earlier.
$sentinel = "C:\Windows\Setup\cf-finalize-complete.tag"
New-Item -ItemType Directory -Force -Path (Split-Path $sentinel) | Out-Null
@(
    "finalized=$([DateTime]::UtcNow.ToString('o'))"
    "winrm_teardown=done"
    "generalize=armed"
) -join "`r`n" | Set-Content -Path $sentinel -Encoding ASCII
Write-Step "wrote completion sentinel $sentinel"

# Generalize is done but /quit left the machine running. Power it off so the
# node-side vzdump captures the sealed image -- the same end state sysprep
# /shutdown produced; packer sees a normal shutdown-disconnect here.
Write-Step "generalize complete and armed; shutting down"
& shutdown.exe /s /t 0 /f
# Give the OS time to power off; nothing after this needs to run.
Start-Sleep 180
exit 0
