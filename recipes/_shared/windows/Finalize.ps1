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

function Zero-FreeSpace($DriveLetter) {
  $root   = "${DriveLetter}:\"
  $target = Join-Path $root "zero.fill"
  $buffer = New-Object byte[] (1024 * 1024)
  $stream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew)
  try {
    while ($true) { $stream.Write($buffer, 0, $buffer.Length) }
  } catch [System.IO.IOException] {
  } finally {
    $stream.Close()
    Remove-Item -Force $target -ErrorAction SilentlyContinue
  }
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

# Server 2019 only: make Cloudbase-Init delayed-auto-start.
#
# A Server 2019 clone reaches GeneralizationState=7 early -- while OOBE is still on
# screen -- so an Automatic-start Cloudbase-Init wakes and runs its plugins before
# the VDS, WMI-licensing, and user-profile subsystems are ready. That first run
# fails ExtendVolumes/Licensing/CreateUser (they only recover after the hostname
# reboot) and, worse, races the oobeSystem pass: its SetUserPassword lands before
# oobeSystem re-seeds the AdministratorPassword, so the clone ships with the build's
# throwaway WinRM password instead of the cloud-init one. Delaying the service to
# auto-start (~2 min) lets OOBE finish and the box settle first, so it runs clean and
# its password write wins -- matching how 2022/2025 already behave (they reach 7 only
# once OOBE completes). Verified live on a clone: with delayed start the cloud-init
# password validates, no early plugin errors, and no "Waiting for sysprep" lines.
if ([int](Get-CimInstance Win32_OperatingSystem).BuildNumber -le 17763) {
  Write-Step "set Cloudbase-Init to delayed auto-start (Server 2019 clone timing)"
  # Windows PowerShell 5.1's Set-Service has no AutomaticDelayedStart; sc.exe does.
  # The spaces after 'start=' are required by sc.exe's argument parser.
  & sc.exe config cloudbase-init start= delayed-auto | Out-Null
}

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
logfile=cloudbase-init-unattend.log
default_log_levels=comtypes=INFO,suds=INFO,iso8601=WARN,requests=WARN
metadata_services=cloudbaseinit.metadata.services.configdrive.ConfigDriveService,cloudbaseinit.metadata.services.nocloudservice.NoCloudConfigDriveService
plugins=cloudbaseinit.plugins.common.mtu.MTUPlugin,cloudbaseinit.plugins.common.sethostname.SetHostNamePlugin

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

Write-Step "remove Packer WinRM keepalive task and policy pins"
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

Write-Step "restore stock WinRM firewall exposure"
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

Write-Step "sysprep and shutdown"
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

# Take Order 1 and push the existing commands back. cloudbase-init's entry
# declares WillReboot=OnRequest, and anything sequenced after a command that
# requests a reboot is not guaranteed to run in the same pass.
foreach ($existing in $runSync.SelectNodes("u:RunSynchronousCommand", $ns)) {
  $orderNode = $existing.SelectSingleNode("u:Order", $ns)
  $orderNode.InnerText = [string]([int]$orderNode.InnerText + 1)
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
  if ($attempt -lt $maxAttempts) { Start-Sleep 45 }
}
if (-not $armed) {
  throw "sysprep did not arm the image for OOBE after $maxAttempts attempts (need SetupType=2 + windeploy CmdLine + IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE) - an unarmed template sticks every clone at GeneralizationState 3; check C:\Windows\System32\Sysprep\Panther\setuperr.log and $gateLog"
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

# Generalize is done but /quit left the machine running. Power it off so the
# node-side vzdump captures the sealed image -- the same end state sysprep
# /shutdown produced; packer sees a normal shutdown-disconnect here.
Write-Step "generalize complete and armed; shutting down"
& shutdown.exe /s /t 0 /f
# Give the OS time to power off; nothing after this needs to run.
Start-Sleep 180
exit 0
