# Windows Server recipes

This document is the source of truth for Windows recipe configuration and
debugging. Update the relevant section when a new experiment changes what is
known, including when an attempted fix fails.

## Recipe matrix

| Recipe                | Proxmox `ostype` | VirtIO directory | TPM 2.0 | Final disk | Answer-file exception      |
| --------------------- | ---------------- | ---------------- | ------: | ---------: | -------------------------- |
| `windows-server-2019` | `win10`          | `2k19`           |      No |        30G | None                       |
| `windows-server-2022` | `win11`          | `2k22`           |     Yes |        30G | None                       |
| `windows-server-2025` | `win11`          | `2k25`           |     Yes |        32G | `<Compact>false</Compact>` |

The release-specific ISO URL, image name, and VirtIO directory must also match
the selected Windows release. Other settings should remain aligned unless a
documented installer requirement says otherwise.

## Proxmox OS type

Never derive an `ostype` by inventing a value from a Windows release name.
Check the current Proxmox `qemu-server` schema before changing a recipe.

The enum was verified directly on the configured Proxmox 9.1.18 build node and
against upstream `qemu-server` 9.2.0:

```text
other wxp w2k w2k3 w2k8 wvista win7 win8 win10 win11 l24 l26 solaris
```

There is no `win2k19`, `win2k22`, or `win2k25`. Proxmox maps:

- Windows Server 2019 to `win10`;
- Windows Server 2022 and 2025 to `win11`.

The upstream definition is the
[`ostype` schema in Proxmox qemu-server`](https://github.com/proxmox/qemu-server/blob/b69480d6110c005b9eb936c55c0438607d10975b/src/PVE/QemuServer.pm#L365-L387).
The Packer Proxmox plugin passes its `os` value to the Proxmox API. Its generated
field description has historically lagged the Proxmox enum, so Proxmox is the
source of truth.

## Shared configuration

All three recipes intentionally share:

- OVMF, Q35, host CPU, 4 cores, and 8 GiB RAM;
- VirtIO SCSI with discard and an I/O thread;
- a 100G temporary build disk for installation and servicing headroom;
- the NAT build network, per-build DHCP slot, and slot-derived VMID;
- the wide OVMF boot-key window;
- WinRM on the allocated IP with a 45-minute initial timeout;
- the shared install, update, pre-finalize, finalize, shrink, and export scripts.

The temporary disk is reduced before export. `Finalize.ps1` shrinks the Windows
partition, then the host-side post-processor truncates the virtual disk to the
declared final size. The `# final_disk_size` metadata and
`local.final_disk_size` must match.

For networked builds, `cf` derives the live VMID as
`base_build_vmid * 100 + slot_index`. The HCL base remains the default for a
manual Packer invocation. Find failed builds by `packer-<recipe>` name rather
than assuming a fixed VMID.

## Windows Server 2025

Server 2025 requires:

- Proxmox `ostype = "win11"`;
- `cpu_type = "host"` so setup can see SSE4.1/4.2;
- TPM 2.0;
- `2k25` VirtIO storage and network drivers;
- a 32G final disk;
- `<Compact>false</Compact>` in `autounattend.xml`.

### CompactOS decision

This ISO repeatedly selected a compact apply when the answer file omitted
`<Compact>false>`. The apply then failed deterministically during servicing with
phase 71 / DISM `0x80071160`. A 64G disk did not change that policy decision.

`<Compact>false>` allows setup to reach specialize and complete, but an
intermittent specialize-pass component-store failure has also been observed.
Bounded Windows build retries tolerate that flake. `Install.ps1` still begins
with `Compact.exe /CompactOS:never` as a post-boot safety check.

Do not add CompactOS commands to `windowsPE` or `specialize`. The attempted
variants either crashed early WinPE, were ineffective, or triggered the same
DISM filesystem-limitation failure against the staged image.

## Build flow

1. `autounattend.xml` loads the release-matched VirtIO storage and network
   drivers and installs the Datacenter image.
2. First-logon commands enable WinRM Basic authentication and unencrypted HTTP
   for the Packer session.
3. `Install.ps1` disables CompactOS, installs VirtIO guest tools, verifies
   QEMU-GA, and pins WinRM through the update reboots.
4. Two Windows Update rounds run as a SYSTEM scheduled task. Packer performs a
   conditional reboot after each round.
5. `PreFinalize.ps1` disables hibernation and the pagefile for compaction.
6. `Finalize.ps1` cleans the component store, installs Cloudbase-Init, shrinks
   the partition, zeros free space, removes temporary WinRM settings, and runs
   sysprep.
7. The host truncates the disk, creates the vzdump artifact, and destroys the
   build VM.

### Setup quit-confirmation modal opened by the boot keypress blanket

Observed live 2026-07-21 on windows-server-2025 (three identical
"Timeout waiting for WinRM" failures at exactly 46m14s — the 45m
`winrm_timeout` plus fixed overhead, so the identical duration carries no
information about *where* the guest stalled). A console screendump of the
fourth attempt showed Windows Setup at "23% complete" with a modal
**"Windows Server Setup — Are you sure you want to quit?"** dialog open and
focus on **No**.

Root cause: the ~60-second `<enter>` blanket that covers the OVMF
"Press any key to boot from CD or DVD" window keeps typing after WinPE's GUI
has loaded. The "Installing Windows Server" screen has a single focusable
Cancel button, so a stray Enter presses it and opens the quit-confirmation
modal. Any *following* Enter presses the modal's default **No** and closes it
again — which is why the burst usually gets away with it — but when the modal
opens on (or near) the burst's final keystroke, nothing remains to dismiss it
and Setup sits blocked until `winrm_timeout` expires. Whether the race hits
depends on how fast WinPE loads, i.e. on node I/O load: three parallel Windows
builds reproduced it 3/3, while the previous day's staggered run passed. The
inline comment claiming stray Enters are "harmless (autounattend drives Setup
non-interactively)" is therefore wrong for the GUI phase; the burst length is
still required for the boot prompt itself (see the failure reference).

Live rescue, verified working: dismiss the modal from the host —

```sh
qm sendkey <build-vmid> ret   # presses the focused "No"; install resumed at once
```

`qm sendkey <vmid> esc` was tried first and does NOT close this modal.
Progress jumped 23% → 56% within seconds of dismissal, confirming the modal
gates the install's phase transitions.

Candidate permanent fix (untested): replace `<enter>` in the boot blanket with
a key OVMF accepts as "any key" but that cannot activate a focused button in
the Setup GUI (e.g. `<up>`). Verify OVMF actually honors the chosen key at the
boot prompt before committing to it — a key it ignores turns every build into
"no bootable device".

### Windows Update automatic reboot suppression

Windows Update's own Update Orchestrator will auto-restart the VM when a
servicing operation is pending. On Server 2025 the checkpoint cumulative leaves
such an operation pending after the first WU round, and the orchestrator fires
the restart a few minutes into the **second** round — while `WU.ps1`'s SYSTEM
task is still scanning. Because the build is headless (WinRM, no interactive
user), nothing defers that restart: the VM reboots out from under the running
powershell provisioner, Packer reports `Script exited with non-zero exit status:
1`, and `Builds finished but no artifacts were created`. This reproduced on all
three build attempts, so `CF_BUILD_ATTEMPTS` did not rescue it — every attempt
died the same way in round two.

`WU.ps1` already installs every update explicitly through the WUA COM API and
signals `RebootRequired` back to Packer, which owns every restart through
`windows-restart`. The orchestrator's *automatic* install/reboot is therefore
pure interference during the build. `Install.ps1` disables it for the build's
duration by writing the `...\WindowsUpdate\AU` policy (`NoAutoUpdate=1`,
`NoAutoRebootWithLoggedOnUsers=1`) and disabling the
`\Microsoft\Windows\UpdateOrchestrator\Reboot*` tasks. `NoAutoUpdate` does not
affect the explicit COM install path. `Finalize.ps1` removes the policy key and
re-enables the reboot tasks before sysprep, so the shipped template keeps
Windows' default update policy rather than inheriting a "never auto-reboot"
state.

Status: **VERIFIED on a live build 2026-07-21.** All three Windows recipes
built to completion (2019, 2022, and 2025 at 1h28m of provisioning) with both
WU rounds finishing and no mid-round orchestrator reboot killing a provisioner.
(The 2025 run needed four attempts, but every failure was the boot-keypress
quit-modal race described above — pre-WinRM, unrelated to WU.)

Cloudbase-Init is deliberately installed after Windows Update. Server 2025
checkpoint cumulative updates can perform a near-full OS redeploy and create
`C:\Windows.old`. Installed software survived the observed redeploy, but the
late install guarantees Cloudbase-Init is present immediately before export.
The observed `Windows.old` directory was empty by finalization, so no cleanup
step is needed.

### Gray desktop on a clone (stale Administrator profile)

Symptom: a cloned VM reaches the logon screen, accepts the Administrator
password, and then shows a **gray desktop** — no wallpaper, no icons, no
taskbar. Ctrl+Alt+Del works and Task Manager opens normally.

Root cause: `sysprep /generalize` does **not** delete existing user profiles.
Without intervention the template ships `C:\Users\Administrator` exactly as the
build left it — a profile that lived through autologon, the WinRM sessions, both
WU rounds, and the checkpoint cumulative. Generalize resets machine identity and
the shell packages are re-registered at OOBE, but that carried-over profile's
per-user shell state still refers to the pre-generalize package identities.
`ShellHost.exe` — which composes the taskbar and desktop surfaces on Server 2025,
and is a separate process from `explorer.exe` — hits `__fastfail` and crash-loops
on it, so nothing ever paints.

Diagnostic signature, confirmed on VM 101 (build 26100.33158):

- `explorer.exe` **is running** and persists; it is not the crasher.
- Application log repeats, roughly every 31 seconds:
  `Faulting application name: ShellHost.exe ... Faulting module name:
  ControlCenter.dll ... Exception code: 0xc0000409`
  (`0xc0000409` is `STATUS_STACK_BUFFER_OVERRUN`, i.e. the `__fastfail` path —
  a deliberate abort, not file damage).
- `sfc /verifyonly` reports **no** integrity violations.
- `ControlCenter.dll` and `ShellHost.exe` carry an identical `LastWriteTime`, so
  they are from the same servicing transaction.
- A newly created local account logs straight into a full working desktop.
- Deleting the profile (`Get-CimInstance Win32_UserProfile | Where LocalPath -eq
  'C:\Users\Administrator' | Remove-CimInstance`) and logging back in as
  Administrator produces first-run setup and then a working desktop.

The last two are the decisive ones: the image is fine, only the profile is bad.

Handling: `Finalize.ps1` writes `C:\Windows\Setup\Scripts\remove-build-profile.ps1`
and injects a `RunSynchronousCommand` calling it into the **specialize** pass of
the unattend passed to sysprep. Specialize runs as SYSTEM before any logon loads
the profile, which is the first point it can be deleted — `Finalize.ps1` itself
cannot, because Packer is logged in as Administrator at that moment. The command
takes `Order` 1 and the existing cloudbase-init entry is renumbered, because that
entry declares `WillReboot=OnRequest` and work sequenced after a reboot request is
not guaranteed to run in the same pass.

Every clone therefore creates a fresh Administrator profile on first logon. That
would newly expose the per-profile privacy/diagnostic-data prompt, which
`SkipUserOOBE` does not cover (it is first-run, not OOBE), so `Finalize.ps1` also
sets `DisablePrivacyExperience=1` under the `...\Policies\Microsoft\Windows\OOBE`
key to keep first logon non-interactive.

`DisablePrivacyExperience` skips that prompt and accepts Windows' defaults — it
does **not** reduce collection, despite the name. Telemetry is minimized
separately via `AllowTelemetry=0` ("Security", the lowest level, honored on
Enterprise/Server SKUs) under `...\Policies\Microsoft\Windows\DataCollection`.

`ProtectYourPC` in the answer file stays at `1`. It gates Defender, SmartScreen,
and automatic updates rather than telemetry, so lowering it to `3` would weaken
the template's security posture without a privacy gain. Do not conflate the two.

Note the Cloudbase-Init `Unattend.xml` sets no Administrator password — it only
hides the EULA, sets `SkipMachineOOBE`/`SkipUserOOBE`, keeps
`PersistAllDeviceInstalls`, and runs cloudbase-init at specialize for the
hostname. An earlier comment in `Finalize.ps1` claiming it sets a placeholder
password was wrong and has been corrected.

Status: **VERIFIED on a live build 2026-07-21** (first clone off the first
windows-server-2025 build of this flow): `C:\Users` contained only `Public` —
the injected specialize command ran and deleted the build profile, and OOBE
auto-completed (`GeneralizationState=7`, no operator prompt). An interactive
first Administrator logon to the desktop was not exercised (blocked by the
password-overwrite defect below), but the stale-profile mechanism itself works.

### Cloudbase-Init never runs on a clone (OOBE never completes)

Symptom: a clone prompts an operator to set the Administrator password at first
boot, and the cloud-init password, hostname, and volume extension are never
applied. `cloudbase-init.log` fills with one line per second, forever:

```text
INFO cloudbaseinit.osutils.windows [-] Waiting for sysprep completion. GeneralizationState: 3
```

Root cause: Cloudbase-Init's `wait_for_boot_completion` blocks until
`HKLM\SYSTEM\Setup\Status\SysprepStatus\GeneralizationState` reaches **7**. The
shipped Cloudbase-Init `Unattend.xml` drives OOBE with `<SkipMachineOOBE>` and
`<SkipUserOOBE>`, both deprecated by Microsoft: they suppress the screens without
running the completion work that advances that value. The clone therefore sits at
`GeneralizationState 3` permanently and the service never reaches a single plugin.

Confirmed on VM 101 via `qm guest exec`: `GeneralizationState` read 3 with
`ImageState` empty; setting it to 7 and restarting the service released it, and
every plugin ran on the next poll (`SetHostNamePlugin`, `ExtendVolumesPlugin`,
`UserDataPlugin`, `LocalScriptsPlugin`).

Handling: `Finalize.ps1` rewrites the `oobeSystem` block of the unattend copy it
passes to sysprep — the deprecated skip pair is removed and replaced with the
explicit `Hide*` screen settings plus a `UserAccounts/AdministratorPassword`,
which is the combination the per-recipe `autounattend.xml` already uses to clear
OOBE unattended during the build. `NetworkLocation` and `ProtectYourPC` values
already present in the shipped file are preserved. The OOBE node is rebuilt in
schema order rather than appended to, because the unattend schema validates its
children as an ordered sequence.

The password comes from `CF_ADMIN_PASSWORD`, passed by each Windows recipe as
`var.winrm_password` — the build's own WinRM password, so nothing is hardcoded in
the repo. The original design assumed Cloudbase-Init would overwrite it with the
cloud-init password seconds into first boot — **live verification proved the
opposite order** (see the VERIFIED DEFECT below): the oobeSystem pass applies
this seeded password *after* cloudbase's specialize-phase cipassword, so it ends
up as the clone's final Administrator password.

Handling of that plaintext password, which is a real exposure and should not be
assumed away:

- `C:\Windows\Temp\cb-sysprep-unattend.xml` — the copy passed to sysprep. Nothing
  used to clean it up; it was still present on an inspected clone. The specialize
  script now deletes it.
- `C:\Windows\Panther\unattend.xml` — **VERIFIED SCRUBBED 2026-07-21** on the
  first clone off the first real build of this flow (windows-server-2025):
  `Select-String` showed `<AdministratorPassword>*SENSITIVE*DATA*DELETED*</AdministratorPassword>`.
  Windows scrubs the Panther copy, so only the `C:\Windows\Temp` copy carried
  the password, and the specialize script now deletes it (also verified: the
  file was absent on the clone). The Temp copy used to persist in the exported
  template disk until a clone's first boot; since 2026-07-31 `Finalize.ps1` runs
  sysprep with `/quit` and deletes it before shutting down (see the Mode-B
  update below), so it no longer ships at all — the specialize-script delete
  stays as a backstop for templates built earlier. `cf verify` now also runs a `no-plaintext-build-password` check on
  every Windows build (`src/verify/checks/windows.ts`): when it can recover the
  build's `winrm_password` from the node's Packer vars file it greps the answer
  files and Panther logs for that exact value, else it asserts no answer file
  carries a non-empty password element — so future regressions surface as a
  failing verify rather than requiring this manual probe.
- Both files exist in the exported template disk until a clone first boots, so
  treat the template artifact itself as carrying the build's WinRM password.

Status: **VERIFIED on a live build 2026-07-21.** The rewritten answer file drove
a real sysprep (windows-server-2025); the first clone reached
`GeneralizationState=7` with no operator prompt, and every plugin ran
(`SetHostNamePlugin` renamed + rebooted, `SetUserPasswordPlugin`,
`ExtendVolumesPlugin`, `UserDataPlugin`, `LocalScriptsPlugin`). One new defect
found in the same verification: the seeded `AdministratorPassword` is applied
*after* cloudbase's specialize-phase cipassword — see the VERIFIED DEFECT
subsection below.

#### Server 2019: two separate clone failures — OOBE hang (fixed) and an intermittent stuck-at-3 (open) (2026-07-24)

Run #51's 2019 `cf verify` failed with `Cloudbase-Init did not settle within
900s`. Live characterisation on 2026-07-23/24 (restore the exported vma, `qm
clone`, boot — the failure is at clone first boot, not build time) found **two
distinct modes**, only one of which the earlier "GeneralizationState sticks at 3"
note actually described:

**Mode A — reaches state 7 but OOBE blocks on the region screen (FIXED).** On a
clone whose specialize/OOBE runs, `GeneralizationState` *does* reach 7 and
Cloudbase-Init runs — but OOBE stops on the interactive **"Hi there"
region/language/keyboard** screen and never completes, so no unattended logon
happens (`shell-session-present` fails; a live clone waits in noVNC). The
`Hide*` OOBE flags do not cover that first regional screen — only a
`Microsoft-Windows-International-Core` component (InputLocale/SystemLocale/
UILanguage/UserLocale) skips it, which the per-recipe `autounattend.xml` has for
the build but the clone answer file lacked. Fixes, all validated live on clones:
- `Finalize.ps1` now injects `Microsoft-Windows-International-Core` (en-US) into
  the clone's oobeSystem unattend → OOBE completes to the logon screen.
- `Finalize.ps1` sets Cloudbase-Init to **delayed-auto-start on 2019 only** (build
  `<= 17763`, via `sc.exe config cloudbase-init start= delayed-auto`). A 2019 clone
  hits state 7 *early* — while OOBE is still on screen — so an Automatic-start
  service ran plugins before VDS/WMI/user-profile were ready (ExtendVolumes/
  Licensing/CreateUser errors that recover only after the hostname reboot) and its
  SetUserPassword landed *before* oobeSystem re-seeded the AdministratorPassword,
  so clones shipped with the build's throwaway password (the documented
  password-overwrite defect). Delaying it lets OOBE finish first: clean run,
  cloud-init password validates, no "Waiting for sysprep" lines. 2022/2025 reach 7
  only once OOBE completes, so they already behave this way — hence the 2019 scope.
- `Finalize.ps1` drops `CreateUserPlugin` from the Cloudbase-Init plugin list.
  Administrator already exists; its only effect on a clone was opening a logon
  session that re-created the `C:\Users\Administrator` profile
  `remove-build-profile.ps1` deletes, re-shipping a stale profile
  (`build-profile-removed` fails). `SetUserPasswordPlugin` sets the password alone.
- `cf verify` calibrated to match: `cloudbase-init-completed`
  (`src/verify/checks/windows.ts`) now asserts "Plugins execution done" plus no
  `plugin '<name>' failed with error`/`CRITICAL`, instead of grepping every `ERROR`
  line — every Proxmox Windows clone logs benign ERRORs ("… is currently not
  supported" for the cipassword user_data cloud-config modules; "Invalid Debian
  config to parse" for the netcfg parser). And `waitForWindowsInit`
  (`src/verify/guest.ts`) now requires the completion marker, because a
  delayed-auto service reads as Stopped before it fires and would otherwise be
  taken as "already done". A clone that reaches state 7 now passes every check.

**Mode B — stuck at GeneralizationState 3, specialize never runs (OPEN).** On some
builds the clone boots straight to the lock screen with `GeneralizationState=3`,
**no `C:\Windows\Panther\setupact.log` (specialize pass), and the build's
`C:\Users\Administrator` profile intact** — i.e. the first-boot specialize/OOBE
passes never ran, so none of the Mode-A answer-file fixes can help, and
Cloudbase-Init loops "Waiting for sysprep completion" forever. This is the actual
run #51 signature. It is **per-build and intermittent**: two clones of a template
built 2026-07-24 02:43 both stuck at 3, while two clones of an earlier template
both reached 7 — with the *only* source diff between those builds being a
runtime Cloudbase-Init config line, which cannot affect sysprep. The differentiator
is the **Windows-Update servicing state at sysprep time**: the build whose clones
worked had its update round *roll back* ("We couldn't complete the updates / Undoing
changes"), the build whose clones stuck installed the 2026-07 cumulative cleanly.
This is a known-hard sysprep/CBS interaction (generalize producing an image that
does not re-run specialize after a cumulative update). **Not yet fixed.**

Dug into the broken 02:43 template's baked sysprep logs on a clone
(`C:\Windows\System32\Sysprep\Panther\setup{act,err}.log`, plus `HKLM\SYSTEM\Setup`):
- The clone has **`SetupType=0` and empty `CmdLine`** — a correctly generalized
  reseal-to-OOBE image arms the next boot to run `windeploy.exe` (SetupType +
  CmdLine); here it is unarmed, so the clone boots as a completed install and never
  runs specialize. `RespecializeCmdLine = sysprep /respecialize /quiet` is set
  instead, and on the clone that respecialize **fails**: `RunExternalDlls: … the
  machine is in an invalid state … hr = 0x8007001f`.
- The build's own generalize (logged 02:39–02:41) hit
  `SYSPRP MRTGeneralize: ERROR: Failed ConnectServer` (a **WMI connect failure**) and
  `Failed to re-enable Compat-Gentel custom trigger`. The recipe does **not** disable
  the Compatibility-Appraiser/DiagTrack tasks (only UpdateOrchestrator reboot tasks,
  re-enabled in Finalize; `AllowTelemetry=0` is a policy value, not a task disable),
  so this is not recipe-induced. WMI being unresponsive at sysprep time points to
  **sysprep running before the post-cumulative-update servicing had fully settled**,
  leaving a corrupt generalize (unarmed OOBE + a respecialize that can't run).

Leading fix hypothesis (unvalidated): before the `Sysprep.exe` call in
`Finalize.ps1`, ensure the box is fully settled — WMI (`winmgmt`) responds to a
probe, no pending CBS servicing, and ideally an extra clean reboot + delay after the
last Windows-Update round — so generalize does not race post-update servicing.
**Caveat: Mode B is intermittent, so no single build can confirm a fix; validating
needs several consecutive clean clone-verifies.** Faster iteration is possible with
the offline clone workflow, but the generalize corruption is baked at build time, so
Mode-B validation unavoidably needs real rebuilds.

##### 2026-07-31: node-only experiments recovered; the "corruption signature" falsified; Finalize now asserts the armed reseal

The 2026-07-24 session continued past the notes above with **uncommitted**
`Finalize.ps1` experiments that only survived in the node's content-addressed
build snapshots (`/var/lib/vz/dump/cofoundry-snapshots/<hash>/recipes/...` —
these record exactly what each build ran; treat them as ground truth when the
working tree has moved on). Eight 2019 builds ran 07-23 19:50 → 07-24 10:24 UTC
in three stages:

1. snapshot `d72654c7` (repo `Finalize.ps1`, plain `/shutdown`) → includes the
   broken 02:41–02:43 export;
2. snapshot `a05bf60f` adds a **settle gate** before sysprep (bounded wait for no
   CBS `RebootPending`/`PackagesPending`/`PendingFileRenameOperations`, WMI
   responds, TiWorker/TrustedInstaller exited);
3. snapshot `6549a0d1` adds `/quit` + a **retry loop keyed on grepping
   `setuperr.log` for `Compat-Gentel|re-specialize internal providers|RunExternalDlls`**,
   shipping anyway (with a warning in `C:\Windows\Temp\cf-sysprep-retry.log`)
   if the signature persisted → produced the final 10:24 export.

The 10:24 template was then inspected **offline** (no boot): decompress the vma,
`vma extract`, loop-mount the NTFS partition (`mount -t ntfs3 -o
ro,loop,offset=$((239616*512))` — the primary GPT is valid but the backup header
is truncated away by the 100G→30G shrink, so compute the offset with `sgdisk -p`),
and export `HKLM\SYSTEM\Setup` + `HKLM\SOFTWARE\...\Setup\State` with `reged -x`.
Findings, with evidence preserved on the node in `/root/win2019-evidence-20260731/`:

- The 10:24 template is **correctly armed**: `SetupType=2`,
  `CmdLine="oobe\windeploy.exe"`, `OOBEInProgress=1`,
  `ImageState=IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE`, `GeneralizationState=4`.
- Its `setuperr.log` nevertheless contains **every** error previously blamed for
  Mode B — `SYSPRP MRTGeneralize: ERROR: Failed ConnectServer`, `Failed to
  re-enable Compat-Gentel custom trigger`, `BCD ... c000000d` — and the settle
  gate was active for that build. **These lines appear in known-armed builds:
  they are benign noise, not a corruption signature.** The stage-3 retry
  heuristic therefore cannot discriminate (it flagged this good build "corrupt"
  on both attempts and shipped it with a false warning), and the earlier
  paragraph's WMI-race reading of `Failed ConnectServer` loses its evidence.
- `RespecializeCmdLine = sysprep /respecialize /quiet` is present in this armed
  template too — it is **normal** on a resealed image, not a Mode-B artifact.
  The real Mode-B anomaly reduces to exactly one thing: `SetupType=0`/empty
  `CmdLine`, i.e. the reseal-to-OOBE arming is missing (then first boot falls
  back to the respecialize path, which fails `0x8007001f` on a generalized
  image and strands the clone at `GeneralizationState=3`).
- Proxmox task logs show every build (broken and good) was captured with
  `status = stopped` and an identical `qmshutdown → qmtemplate → qmstop →
  vzdump` sequence — no host-visible restart distinguishes the broken build. If
  a post-sysprep boot consumed the arming (e.g. an UpdateOrchestrator reboot
  racing the sysprep shutdown, plausible since `Finalize.ps1` re-enabled those
  tasks *right before* sysprep, and only on builds whose cumulative installed
  cleanly — matching the observed differentiator), it happened guest-internally
  and is invisible in retained host logs. The 02:43 vma was overwritten by later
  builds, so this cannot be settled retroactively.

Current handling (in the repo `Finalize.ps1` as of this date, superseding both
node-only experiments): keep the settle gate; run sysprep with `/quit`; **assert
the armed markers directly** (`SetupType=2` + windeploy `CmdLine` +
`IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE`) instead of grepping error lines, retry
once, and **fail the build** if still unarmed (an unarmed template is broken on
every clone — never "ship anyway"); move the WU auto-reboot restore to *after*
generalize so no orchestrator reboot can race it; delete the plaintext-password
`cb-sysprep-unattend.xml` before power-off (the `/quit` flow finally allows
this, closing the exposure gap flagged in the Cloudbase-Init section). The
`/quit` → `shutdown.exe /s /t 0 /f` → vzdump flow itself is live-proven by the
10:24 build. Validation status: the arming gate makes an unarmed export
**impossible** (it fails the build instead); whether the settle gate + reordered
WU restore actually reduce how often the gate trips still needs several
consecutive builds to judge. Offline hive inspection (above) verifies a
template's arming without burning a 900s clone-verify.

Live `cf verify` of that armed 10:24 template (2026-07-31) confirmed the
offline prediction end-to-end: the clone reached `GeneralizationState=7` and
passed generalization-state, build-profile-removed, hostname-applied,
system-volume-extended, winrm-not-exposed, no-plaintext-build-password,
shell-session-present, and shell-no-crashes. Two verify-side defects surfaced
and were fixed in the same session:

- **`--sshkeys` on a Windows clone makes `SetUserSSHPublicKeysPlugin` fail**
  (`[WinError 2]`, on both init runs) because the template ships no OpenSSH —
  the one red check in an otherwise green battery. `cf verify` no longer seeds
  SSH keys for Windows clones (fixes verification of already-built templates),
  and `Finalize.ps1` drops the plugin from the shipped conf.
- **`waitForWindowsInit` could declare done before SetHostName's rename
  reboot** ("Plugins execution done" lands pre-reboot), so the check phase
  raced the reboot and the harness's own reboot step failed with "could not
  read a boot id". The wait now also requires the sentinel hostname to be the
  active computer name, which is only true after that reboot.

**Dead ends (do not retry).** A `SetupComplete.cmd` forcing `GeneralizationState=7`
never fires — it is gated on the OOBE completion that never happens. An AtStartup
scheduled task forcing 7 is fragile and non-deterministic: it can force 7 mid-setup,
so Cloudbase-Init reboots mid-specialize and bricks the clone with "The computer
restarted unexpectedly", and it runs plugins before subsystems are ready. Forcing 7
treats a symptom; the real Mode-A fix is letting OOBE complete (International-Core).

#### VERIFIED DEFECT (2026-07-21): the seeded AdministratorPassword overwrites the cloud-init password

Verified on the first clone (windows-server-2025, first build of this flow),
with a full paper trail. On the clone's first boot the order of operations is:

1. Cloudbase-Init's sysprep-phase run (released by the GeneralizationState fix)
   executes the full MAIN plugin stage **during specialize**: `cloudbase-init.log`
   06:37:08 — `Password succesfully updated for user Administrator` (the
   Proxmox `cipassword` from the configdrive).
2. The **oobeSystem pass runs after it**: `Panther\UnattendGC\setupact.log`
   06:37:37 — `[Shell Unattend] UserAccounts: Password set for 'Administrator'`
   — applying the seeded `AdministratorPassword` (the build's ephemeral WinRM
   password) **29 seconds after** Cloudbase-Init set the cipassword.
3. Cloudbase-Init's plugins are run-once per instance, so nothing re-applies
   the cipassword on later boots.

Net effect: every clone's final Administrator password is the build's
generated per-build secret — which is deleted with the build workdir — and
`ValidateCredentials('Administrator', <cipassword>)` returns False. The
assumption earlier in this section ("Cloudbase-Init overwrites it with the
cloud-init password seconds into first boot") is exactly backwards: cloudbase's
metadata pass runs at specialize, *before* oobeSystem, not after.

Everything else in the rewritten flow verified GOOD on the same clone:
`GeneralizationState=7`, all plugins ran (hostname applied + rename reboot),
`C:\Users` contains only `Public` (stale-profile deletion works),
`cb-sysprep-unattend.xml` deleted, no WinRM firewall rules (stock posture),
Panther password scrubbed.

Operational workaround until fixed: QEMU-GA works on clones, so
`qm guest exec <vmid> -- net user Administrator <new-password>` restores
access. Fix directions to evaluate: stop seeding a *secret* password (seed a
public throwaway instead — OOBE only needs *a* value while Hide* settings do
the skipping); or re-arm the SetUserPassword plugin so the post-OOBE service
pass re-applies metadata; or move the cloudbase run out of the sysprep
specialize phase so it runs after oobeSystem.

#### Cloud-init password must satisfy the guest password policy

Once unblocked, `SetUserPasswordPlugin` can still fail:

```text
ERROR cloudbaseinit.init [-] Set user password failed: The password does not meet
the password policy requirements.
```

The template ships Windows' default `PasswordComplexity = 1`, so a Proxmox
`cipassword` must use three of four character classes (upper, lower, digit,
symbol) and be at least six characters. This is a caller-side constraint, not a
recipe defect — do not relax the guest policy to work around it. The
`AdministratorPassword` seeded above is the fallback that keeps such a clone
reachable instead of locked out.

#### Falsified: `/ResetBase` before generalize

`Finalize.ps1` runs `dism /Online /Cleanup-Image /StartComponentCleanup
/ResetBase` immediately before sysprep, which was the first hypothesis for the
gray desktop — `/ResetBase` discards superseded component payloads, and the 2025
checkpoint cumulative behaves like a near-full OS redeploy, so a shell-binary
servicing mismatch looked plausible. **This was tested and disproved**: `sfc`
found no integrity violations and the shell binaries share one timestamp. Do not
spend another build cycle removing `/ResetBase` for this symptom. (It does remain
true that `/ResetBase` leaves `DISM /RestoreHealth` with no local payload, so
repair attempts on a clone need Windows Update and otherwise fail `0x800f081f`.)

Disk truncation was also considered and ruled out by arithmetic: `qemu-img resize
--shrink ... 32G` is GiB (34,359,738,368 bytes) and `Shrink-SystemPartition`
targets 32GiB − 1GiB, leaving a real 1GiB margin.

`C:\Windows.old` exists as a directory on the inspected clone but is **empty**
(0 files, 0 bytes), which confirms rather than contradicts the "empty by
finalization" observation recorded under the Cloudbase-Init note above. No
cleanup step is needed.

### Windows Update progress reporting

The SYSTEM update task in `WU.ps1` downloads and installs each batch through the
**asynchronous** `IUpdateDownloader.BeginDownload` / `IUpdateInstaller.BeginInstall`
COM methods and polls the returned job's `GetProgress().PercentComplete`, logging
each 5% step (or at least once a minute) to `tb-wu.log`. The outer script already
tails that log to Packer, so a long cumulative update now shows a climbing
percentage instead of only the elapsed-minute heartbeat. Batching is unchanged —
`Begin*` runs the same update collection the synchronous calls did.

`Begin*` requires COM progress/completed callback objects. `WU.ps1` supplies
minimal no-op callbacks defined via `Add-Type`; their interface IIDs are taken
verbatim from `wuapi.idl` (`IDownloadProgressChangedCallback`
`8c3f1cdd-6173-4591-aebd-a56a53ca77c1`, `IDownloadCompletedCallback`
`77254866-9f5b-4c8e-b9e2-c77a8530d64b`, `IInstallationProgressChangedCallback`
`e01402d5-f8da-43ba-a012-38894bd048f1`, `IInstallationCompletedCallback`
`45f4f6f3-d602-4f98-9a8a-3efa152ad2d3`). If the types fail to compile or `Begin*`
throws (e.g. a wrong IID or marshaling mismatch), the code falls back to the
original synchronous `Download()` / `Install()` batch call, so a callback problem
can only lose the progress readout for a round — it cannot fail the build.

Status: **unverified on a live build** at time of writing. The async-callback
path could not be exercised from the dev host; confirm on the next real run that
the log shows `download`/`install` percentages rather than the
`async ... unavailable ... using synchronous batch` fallback line, and record the
outcome here.

### Windows Update throughput mode

Windows servicing is intentionally conservative on interactive machines, and
Task Scheduler creates tasks at priority 7 (below normal) by default. The build
VM has no interactive workload during its update rounds, so `WU.ps1` registers
the SYSTEM task at priority 4 (normal) and temporarily selects the High
performance power scheme. It records the prior scheme and restores it in a
`finally` block before the round completes or Packer reboots the VM.

This removes avoidable scheduler and guest power-policy throttling; it does not
make servicing fully parallel. Cumulative updates still spend substantial time
in dependency-ordered component-store operations, decompression, verification,
and small random disk I/O. Do not set `TiWorker`, `TrustedInstaller`, or the
update task to High/Realtime priority: that can starve storage, RPC, QEMU-GA,
and WinRM without accelerating serialized work.

Status: **unverified on a live build** at time of writing. On the next real run,
compare update-round duration and host/guest CPU and disk utilization with the
prior build. Confirm the log contains both `throughput mode enabled` and
`restored power scheme`; record the outcome here even if no speedup is observed.

## Debugging workflow

Before changing HCL, an answer file, or a provisioner:

1. Search this document for the symptom or error code.
2. Find the live VM by name:

    ```sh
    ssh "$SSH_TARGET"
    qm list | grep 'packer-windows-server'
    ```

3. Identify the failure stage before proposing a fix:
    - no partitions: setup rejected input before disk configuration;
    - partitions but no Panther logs: early WinPE failure;
    - `$Windows.~BT/Sources/Panther`: apply or WinPE logs;
    - `Windows/Panther`: specialize or installed-OS logs;
    - negligible disk writes plus an OVMF message: boot-prompt timing.

4. Preserve log evidence and update the failure reference or rejected-approach
   section below. Record the symptom, attempted change, and result.

To confirm driver directories on the actual VirtIO ISO:

```sh
ssh "$SSH_TARGET"
mkdir -p /tmp/vm
mount -o loop /var/lib/vz/template/iso/packer-virtio-win-<version>.iso /tmp/vm
ls /tmp/vm/vioscsi/
umount /tmp/vm
```

## Failure reference

| Symptom                                                   | Cause or diagnostic                                                                                                                                                 | Current handling                                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Proxmox rejects `ostype`                                  | A release-derived value was invented                                                                                                                                | Read the Proxmox enum; use `win10` for 2019 and `win11` for 2022/2025                                  |
| APIPA address or unreachable WinRM                        | VM is on the wrong bridge or lacks its DHCP reservation                                                                                                             | Use the NAT build bridge and allocated IP/MAC slot                                                     |
| Packer waits for IP discovery                             | Windows has no QEMU agent during setup                                                                                                                              | Set `winrm_host` to the allocated build IP                                                             |
| OVMF reports no bootable device                           | Boot-from-CD keypress missed on a loaded node                                                                                                                       | Keep the two-second wait and roughly 60-second keypress blanket                                        |
| WinRM HTTP 401 during initial setup                       | Basic auth or unencrypted service access was not applied                                                                                                            | Keep the four separate first-logon commands and exact `cmd.exe /c winrm set ... @{...="true"}` quoting |
| WinRM HTTP 401 just after reboot                          | `winrm quickconfig` in the keepalive task reset or disrupted the service                                                                                            | Keepalive only reapplies the two `winrm set` commands; post-reboot provisioners wait 30 seconds        |
| Cloudbase-Init download fails in the VM                   | Older Windows TLS stack cannot reliably fetch the GitHub asset                                                                                                      | Download on the host and attach the MSI to the answer-files ISO                                        |
| Windows Update COM returns access denied                  | WinRM has a network token                                                                                                                                           | Run update work as a SYSTEM scheduled task                                                             |
| Temp PowerShell script is missing after update reboot     | WinRM reconnects before the filesystem settles                                                                                                                      | Retain `pause_before = "30s"` after reboots                                                            |
| `packer-ps-env-vars-*.ps1` not recognized after WU reboot | `ps_execute` waited only for the script (`{{.Path}}`), then dot-sourced the env-vars file (`{{.Vars}}`) which had not landed yet on the post-reboot WinRM reconnect | `ps_execute` now waits for **both** `{{.Path}}` and `{{.Vars}}` (up to 120s) before dot-sourcing `$_v` |
| Server 2025 disk is invisible in WinPE                    | Wrong VirtIO directory                                                                                                                                              | Use `2k25`, not `2k22`                                                                                 |
| Setup fails before partitioning                           | Invalid answer/setup input, including invalid CompactOS option syntax                                                                                               | Inspect attached answer files; do not use the removed `setupconfig.ini` experiment                     |
| Setup fails near 11 GB written with `0x80071160`          | Compact WOF apply cannot be serviced from WinPE                                                                                                                     | Retain `<Compact>false>`                                                                               |
| Specialize fails with `ERROR_BADDB` / `0x800703f9`        | Intermittent corrupt `COMPONENTS` hive transaction state                                                                                                            | Retain retries; investigate host RAM or storage integrity rather than CompactOS permutations           |
| WU round-two provisioner exits 1 after ~4 min, no artifact | Update Orchestrator auto-restarts the headless VM mid-scan, killing the powershell provisioner; retries all die the same way                                        | `Install.ps1` disables WU auto-update/auto-reboot for the build; `Finalize.ps1` restores it before sysprep |
| Two builds interfere or an orphan controls the slot       | Stale remote Packer/watchdog or fixed VMID state                                                                                                                    | Slot-derived VMIDs, stale process cleanup, orphan VM eviction, and name-based pruning                  |
| WinRM timeout at exactly `winrm_timeout` + overhead; Setup GUI shows "Are you sure you want to quit?" | The `<enter>` boot blanket outlives WinPE load; a stray Enter presses Setup's Cancel and the modal opens on the burst's last keystroke, blocking the install | Screendump the console first; `qm sendkey <vmid> ret` dismisses it (esc does not). Candidate fix: use a non-activating key such as `<up>` in the blanket |
| Clone boots to a gray desktop with no taskbar             | Template shipped the build's `C:\Users\Administrator`; its pre-generalize shell state crash-loops `ShellHost.exe` (`0xc0000409` in `ControlCenter.dll`)              | `Finalize.ps1` deletes that profile from the unattend's specialize pass so each clone builds a fresh one |
| Clone asks for an Administrator password; cloud-init never applies | Deprecated `SkipMachineOOBE`/`SkipUserOOBE` leave `GeneralizationState` at 3, so Cloudbase-Init loops "Waiting for sysprep completion" and runs no plugins   | `Finalize.ps1` rewrites the unattend's OOBE block to `Hide*` settings + `AdministratorPassword` from `CF_ADMIN_PASSWORD` |
| `Set user password failed: ... password policy requirements` | Proxmox `cipassword` violates the guest's `PasswordComplexity = 1` policy                                                                                        | Caller must supply a compliant password; the seeded `AdministratorPassword` keeps the clone reachable meanwhile |
| Clone's `cipassword` does not work despite `Password succesfully updated` in the cloudbase log | Cloudbase's sysprep-phase run sets the cipassword at specialize; oobeSystem then applies the seeded `AdministratorPassword` (setupact.log: `UserAccounts: Password set`) 29s later, overwriting it with the deleted per-build secret | VERIFIED DEFECT 2026-07-21, see the OOBE section; workaround `qm guest exec <vmid> -- net user Administrator <pw>` (2019: fixed by delayed-auto cloudbase start) |
| Clone stuck at `GeneralizationState=3`, no `C:\Windows\Panther\setupact.log`, build profile intact (Mode B) | Template exported with `SetupType=0`/empty `CmdLine` — the reseal-to-OOBE arming is missing, so windeploy never runs and the respecialize fallback fails `0x8007001f` | `Finalize.ps1` runs sysprep `/quit`, asserts `SetupType=2` + windeploy `CmdLine` + `IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE`, retries once, and fails the build if unarmed; verify templates offline via hive inspection (see the 2026-07-31 Mode-B update) |

The intermittent `ERROR_BADDB` failure reproduced with verified install media,
adequate free disk space, and no competing build process. Host RAM or the
storage path remained the leading untested hypothesis. Treat it as a hardware
investigation, not a reason to repeat rejected CompactOS changes.

## Rejected or superseded approaches

- `win2k19`, `win2k22`, and `win2k25` are not Proxmox enum values.
- A fixed `10.0.0.100` address and MAC caused stale-lease and concurrency
  problems; builds now allocate network slots.
- A short OVMF keypress burst missed the boot prompt under node load.
- `winrm quickconfig -force` in the startup keepalive raced Packer after reboot.
- Downloading Cloudbase-Init directly inside the VM failed on older TLS stacks.
- Reusing `2k22` VirtIO drivers for Server 2025 failed disk discovery.
- `setupconfig.ini` with `CompactOS=disable` was invalid; `CompactOS=Never` was
  ignored from the answer-files media.
- WinPE `RunSynchronous` CompactOS commands were ineffective or crashed setup.
- A specialize-pass CompactOS command caused DISM `0x80071160` earlier in setup.
- Removing `<Compact>false>` produced the deterministic phase 71 failure.
- Increasing the disk to 64G did not avoid the compact policy.
- Removing `Windows.old` would reclaim nothing in the observed update flow.
- Letting Windows Update auto-reboot during the build (no suppression) killed the
  round-two provisioner on every attempt; the build now disables WU
  auto-update/auto-reboot for its duration and restores it before sysprep.
- Removing `/ResetBase` from `Finalize.ps1` was proposed for the gray-desktop
  symptom and disproved before it cost a build; the cause was a stale
  Administrator profile surviving generalize. See the gray-desktop section.
- `SkipMachineOOBE` / `SkipUserOOBE` are deprecated and do not complete OOBE.
  Relying on them stalls `GeneralizationState` at 3 and hangs Cloudbase-Init
  indefinitely. Use the explicit `Hide*` screen settings plus an
  `AdministratorPassword` instead.
- Grepping sysprep's `setuperr.log` for `Compat-Gentel` / `MRTGeneralize
  Failed ConnectServer` / `RunExternalDlls` as a generalize-corruption signal
  was falsified 2026-07-31: an offline-verified **armed** template carries all
  of those lines. Assert `HKLM\SYSTEM\Setup` `SetupType=2` + windeploy
  `CmdLine` + `IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE` instead.
