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

**Applied 2026-08-03 to windows-server-2025 only.** The blanket now types `<up>`
instead of `<enter>`. It recurred that day as the same `Timeout waiting for WinRM`
at 46m17s, so the race is not rare enough to ride out on retries — each attempt
costs ~46 minutes and 2026-07-21 needed four.

Deliberately NOT applied to 2019/2022 yet: 2022 is verified working end to end,
and changing a proven recipe on an untested hypothesis is the wrong trade.
Propagate only once 2025 completes a build with `<up>`.

The risk is cheap to carry: if OVMF ever stops honouring the key, the failure is
immediate and unmistakable ("no bootable device" within a couple of minutes),
not a 46-minute stall.

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

**Recurrence 2026-07-31 on windows-server-2025 (partial, under concurrent
load).** A 2025 build errored after 1h58m with the exact original signature:
round two reached `iteration 1 - searching for updates`, ran ~3–4 minutes, then
`Script exited with non-zero exit status: 1` / `Builds finished but no
artifacts were created`. Facts established at the time, so the next
investigation does not redo them:

- The suppression is **still present and unmodified** in `Install.ps1`
  (`NoAutoUpdate`, `NoAutoRebootWithLoggedOnUsers`, and the
  `UpdateOrchestrator\Reboot*` task disables). This is not a lost fix.
  **-- Superseded 2026-08-01: this checked the source, not the running guest.
  The policy *is* present in `Install.ps1` and *is* lost at runtime. See
  "Root cause found" below.**
- A **windows-server-2022 build running concurrently passed straight through
  the same round-two window** (entered round two at 22:40:03, installed and
  continued), so the failure is not a blanket regression of the mechanism.
- The distinguishing condition versus the 07-21 verification is
  **concurrency**: two Windows builds in parallel, node load average ~9.8, and
  the failing build took 1h58m to reach round two versus 1h28m of total
  provisioning on the quiet 07-21 run. A WinRM/provisioner drop under load is
  therefore as plausible as an orchestrator reboot, and the two are not
  distinguishable from the packer log alone.
- `CF_BUILD_ATTEMPTS` retried (attempt 2/3). The original systematic form of
  this bug killed *every* attempt identically, so a retry that succeeds is
  itself evidence the cause is load-related rather than the deterministic
  orchestrator restart.

**ACTUAL root cause, 2026-08-01 10:12Z: TrustedInstaller reboots the VM
itself.** Captured from the guest's System log while the build was live:

    id=1074  The process C:\Windows\servicing\TrustedInstaller.exe (TEMPLATE)
             has initiated the restart of computer TEMPLATE on behalf of user
             NT AUTHORITY\SYSTEM for the following reason:
             Operating System: Upgrade (Planned)  Reason Code: 0x80020003

Sequence on that guest, all within ~90 seconds:

    10:07:22  id=109   kernel shutdown transition   <- packer's own restart
    10:07:42  id=6005  event log started            <- machine is back
    10:08:42  id=1074  TrustedInstaller initiates a restart   <- UNSOLICITED
    10:08:44  id=109   kernel shutdown transition
    10:08:55           boot
    10:09:02  id=6005  event log started

The servicing stack performs its *own* planned restart to finish committing the
update, one minute after the machine returns from packer's restart. That second
reboot is what kills the provisioner.

**This is why none of the update suppression works.** `NoAutoUpdate` governs the
AU agent and the `UpdateOrchestrator\Reboot*` tasks govern USO-initiated
restarts. Neither has any authority over TrustedInstaller restarting to complete
a servicing operation. Do not re-attempt suppression as a fix for this; the
reboot is legitimate and must be waited out, not blocked.

**Pending flags alone are insufficient (2026-08-02).** A 2022 build rebooted
twice after round one, 79 seconds apart, with the flags clear throughout —
captured live from the guest:

    13:21:15  BOOT TIME CHANGED 11:00:10 -> 13:20:44   (packer's restart)
    13:21:29  cbsPending=False wuPending=False servicingRunning=True
    13:22:27  BOOT TIME CHANGED 13:20:44 -> 13:22:03   (second, unsolicited)
    13:24:48  cbsPending=False wuPending=False servicingRunning=False

The registry flags describe work already *queued*; they say nothing about
servicing still executing. `TiWorker`/`TrustedInstaller` running is the signal
that another restart may still be coming. With only the flag checks, packer
resumed into that window and the second reboot destroyed the uploaded
provisioner script (`script never arrived within 300s`). The process check must
stay alongside the flags, and the minimum uptime went 120s -> 180s.

Fix: `restart_check` gates on *pending servicing* rather than on liveness —
`Component Based Servicing\RebootPending`, `WindowsUpdate\Auto Update\
RebootRequired`, and `PendingFileRenameOperations`, plus a minimum uptime. Packer
therefore keeps polling across TrustedInstaller's restart instead of provisioning
into the gap before it. A windows-server-2022 build survived exactly this reboot
at 10:08:42 because the earlier 180s-uptime check happened to still be holding —
which is the same mechanism, arrived at by luck rather than design.

### Provisioner uploads race the post-update reboots (max_retries)

Even with `restart_check` correctly holding through the double reboot (verified
2026-08-02 16:14–16:18Z: it waited past both reboots until `servicingRunning`
went False), a provisioner upload can still fail to land. Three separate builds
were lost this way, each with a *different* missing file:

    script-<uuid>.ps1                  "is not recognized"        (before the gate existed)
    script-<uuid>.ps1                  "never arrived within 300s"
    packer-ps-env-vars-<uuid>.ps1      "is not recognized"

Packer's powershell provisioner uploads two files — the env-vars file and the
script — and `ps_execute` waits for both. It now reports each by name, instead of
falling through to `. $_v` and producing a vague "not recognized".

The important change is `max_retries = 2` on every powershell provisioner. A lost
upload used to cost the entire ~3h build; now Packer retries just that
provisioner, which re-uploads. Treat the upload as inherently unreliable in the
window after a cumulative update rather than something a wait can fully prevent.

### The silent non-generalized export: the WinRM firewall teardown

**Root cause identified 2026-08-01 13:26Z.** `Finalize.ps1` restored the stock
WinRM firewall exposure *before* the Appx cleanup and sysprep. The build NIC sits
on an unidentified (Public-profile) network, so removing `WinRM-HTTP` and
disabling the Public-profile `Windows Remote Management (HTTP-In)` rule drops
packer's live WinRM session. The script kept running on the guest — sysprep ran,
and failed — but its output and exit code never got back, and **packer read the
disconnect as provisioner success** and went straight to export.

That is the mechanism behind the 2026-07-31 silent non-generalized export. The
`3094234` diagnosis (stale `$LastExitCode`) was a real weakness but not this;
`ps_execute` never got the chance to return anything at all. The evidence is the
truncation point: the build log ends at `==> restore stock WinRM firewall
exposure` and the next line is packer's `Stopping VM`, with the Appx and sysprep
steps between them never appearing — identical across the 07-31 run and the
08-01 13:26Z run.

Fix: the **entire** WinRM teardown moved to immediately before the final
shutdown, after generalize. Sysprep uses `/quit`, so the machine is still up and registry writes
land in the sealed image (the WU policy restore already relies on this). Losing
the session there costs nothing, since the only remaining action is power-off.

**Keep this ordering.** Anything that can sever WinRM must run after sysprep, or
it will silently truncate the script and re-introduce a shipped broken template.

**Moving only part of it is not enough (2026-08-01 21:45Z).** With the firewall
rules moved, Finalize reached the Appx step for the first time — and truncated
*there* instead, because the Basic/`AllowUnencrypted` policy unpin was still
above sysprep:

    ==> remove Packer WinRM keepalive task and policy pins
    ==> remove per-user Appx packages that block generalize
    Stopping VM                                <- silence, packer proceeds

Packer connects with Basic auth over unencrypted HTTP, so
`winrm set .../auth @{Basic="false"}` cuts its session exactly as the firewall
rule removal did. The keepalive task, the policy-key removal, the two `winrm
set` calls and the firewall rules now all sit together after generalize. The
rule is simple: **nothing above sysprep may touch WinRM auth, its policy keys,
or its firewall rules.**

### windows-server-2022 VERIFIED end to end (2026-08-03)

`cf verify windows-server-2022` passed on the `124401b` artifact: **15 checks
passed, 1 warned**, including the two that matter most —

    cipassword-validates   the clone-password defect from PR #30 is fixed
    winrm-not-exposed      the teardown really ran (what the sentinel guarantees)
    hostname-applied       set by the post-OOBE service run, after a clean OOBE

The build side reached this after five consecutive clean builds: the gate passed
every time, upload races were absorbed by `max_retries` rather than killing a
build, and transport blips were absorbed by the raised SSH keepalive.

The clone side took five layers, each found by reading the guest's own logs
offline (`qemu-nbd` + mount), never by guessing:

    allow_reboot=true            cloudbase-init self-terminated (ControlService 1062)
    reset_service_password=true  next call died (OpenSCManager 1115)
    SetHostNamePlugin            renamed in specialize; reboot landed mid-OOBE
    (still failed)               guest rebooted ~44s into specialize regardless
    -> removed the command       specialize is now just the profile cleanup

The lesson worth keeping: after three fixes to cloudbase-init's specialize entry
each surfaced another failure, **deleting the command entirely** was what worked.
It was never load-bearing — its only purpose was keeping SetUserPasswordPlugin
out of specialize, which removal achieves outright. Prefer removing a fragile
step over repairing it when the post-OOBE service run already does the work.

Remaining known warning: `no-critical-service-failures` reports an Automatic
service not yet running at post-reboot. It is a `warn`, not a failure, and the
check already allow-lists the usual delayed starters; if it persists, widen that
list rather than treating it as a defect.

### Guards against these classes recurring

Ten of the 2026-08-01/02 fixes fell into two repeating shapes, each costing a
~3.5h build to discover. Both now fail fast instead.

**The cloudbase-init config is overwritten wholesale**, so any stock setting not
carried forward is dropped silently. That produced three separate failures
(`allow_reboot`, `reset_service_password`, then `SetHostNamePlugin` running in
specialize). `tests/windows-cloudbase-conf.test.ts` asserts the specialize config
keeps the load-bearing keys and runs no reboot-requesting plugin. Note the
assertions are **anchored** (`/^allow_reboot=false$/m`): the config also mentions
those keys in its own comments, and a substring check passed even with the
setting deleted — verify any change to that test with a negative control.

**Finalize.ps1 truncates silently** when a step severs packer's WinRM session:
the script keeps running on the guest while its output and exit code go nowhere,
and packer reads the disconnect as success. Truncation *before* sysprep is caught
by the export gate (the image is not generalized). Truncation *after* it was
invisible — the image generalizes fine and merely ships with the build's WinRM
exposure intact. `Finalize.ps1` now writes
`C:\Windows\Setup\cf-finalize-complete.tag` as its last act, after the
teardown, and `assert-generalized.sh` refuses the export if it is missing. Any
future step that kills the session, anywhere in that script, is now a loud gate
failure. Do not move the sentinel earlier.

### Clones loop on "The computer restarted unexpectedly" (allow_reboot)

**Root cause found 2026-08-02, on an image the export gate had already certified
as correctly generalized and armed.** The template was fine; every *clone*
failed the specialize pass and looped on Setup's

    The computer restarted unexpectedly or encountered an unexpected error.
    Windows installation cannot proceed.

so Cloudbase-Init never ran, the guest agent never came up, and `cf verify`
failed with `Cloudbase-Init did not settle within 900s`. Chain, from the clone's
own logs read offline via qemu-nbd:

    Panther/setupact.log        SETUPUGC.EXE specialize -> process exit code = 3   (looping)
    Panther/UnattendGC/…        Finished executing [cmd.exe /c ""…cloudbase-init.exe"
                                  --config-file "…cloudbase-init-unattend.conf"
                                  && exit 1 || exit 2"]
                                Process returned with exit code 0x2
    cloudbase-init-unattend.log CRITICAL Unhandled error: pywintypes.error:
                                  (1062, 'ControlService', 'The service has not been started.')
                                init.py:238 configure_host() -> osutils.terminate()
                                windows.py:1289 terminate() -> stop_service(...)

`SetHostNamePlugin` requests a reboot after renaming the clone. Cloudbase-Init
defaults to `allow_reboot=true`, so it acts on that itself: `terminate()` stops
the cloudbase-init *service* — but during specialize it runs as a console
process, the service is not started, and `ControlService` raises 1062
unhandled. The non-zero exit takes the `|| exit 2` branch, SetupUGC returns 3,
and specialize fails on every boot.

The reboot is the *unattend's* job: `&& exit 1` is what signals
`WillReboot=OnRequest`, and cloudbase-init must exit 0 for that to happen.

Fix: `allow_reboot=false` in the `cloudbase-init-unattend.conf` that
`Finalize.ps1` writes. **It is load-bearing — do not drop it.** It was missing
because that file is overwritten wholesale to restrict the specialize run to
MTU + hostname (the password-overwrite fix), and the stock MSI copy's
`allow_reboot=false` went with it.

Note what this says about the export gate: a template can be genuinely
generalized and armed and still produce unusable clones. The gate proves the
image is armed; only `cf verify` proves a clone boots.

**`allow_reboot=false` alone was not enough (2026-08-02).** With it applied and
confirmed present in the shipped image, clones still looped — the next call in
the same family failed:

    init.py configure_host() -> _reset_service_password_and_respawn(osutils)
    -> osutils.reset_service_password() -> OpenSCManager
    pywintypes.error: (1115, 'OpenSCManager', 'A system shutdown is in progress.')
    SetupUGC returning with exit code [4]

`configure_host()` opens by resetting the cloudbase-init *service* account
password and respawning as that user. During specialize this is a console run,
so the call dies and takes the `|| exit 2` branch again. Fix:
`reset_service_password=false`.

**Both flags ship in the MSI's stock `cloudbase-init-unattend.conf`** and were
lost because `Finalize.ps1` overwrites that file wholesale. Any future rewrite of
that block must carry them forward. The general lesson: the specialize-pass run
is a *console* invocation, so every service-oriented code path in
`configure_host()` has to be disabled by config.

### Sysprep Appx pre-validation: being provisioned does not mean safe

With the session restored, the underlying generalize failure was visible:

    SYSPRP Package Microsoft.MicrosoftEdge.Stable_150.0.4078.105_neutral__8wekyb3d8bbwe
           was installed for a user, but not provisioned for all users
    SYSPRP Failed to remove apps for the current user: 0x80073cf2

`f861196` was written for exactly this package and still missed it, because its
loop skipped anything appearing in `Get-AppxProvisionedPackage`. Edge appears
there under the very full name sysprep rejects, so it was skipped every time.
Provisioning covers a package *version*; a WU round installs a newer Edge for the
current user, and it is that per-user registration generalize refuses.

Fix: skip only packages with **no per-user registration** (`PackageUserInformation`
with `InstallState = Installed`); on a failed unregister, drop the provisioned
entry and retry; and report survivors by name instead of `SilentlyContinue`.

### Clone specialize aborted by the Cloudbase-Init SERVICE (SOLVED)

**VERIFIED WORKING 2026-08-03 08:36Z.** A clone of the `339eccd` artifact
settled on its own:

    AGENT UP at 90s | hostname=WIN-T0LDD15A7D4 | cloudbase-init=Stopped
    *** CLONE SETTLED — cloudbase-init completed ***

Guest agent up in 90 seconds, hostname applied, cloudbase-init ran to completion
and stopped. The event log shows the *designed* sequence rather than an abort:

    08:13:23  winlogon.exe | "Operating System: Upgrade (Planned)" | restart
    08:13:54  boot 2
    08:16:24  python.exe   | "Cloudbase-Init reboot"                | restart
    08:16:48  boot 3

The cloudbase-init reboot moved from ~46s to ~2.5 min after boot — the delayed
auto-start working — and specialize now completes and hands off via winlogon's
planned restart instead of being cut short.

Note the working clone is *faster* to settle (90s) than the failing ones were to
time out. A theory that `cf verify`'s 900s window was simply too short was
**wrong**; the earlier failures were the real defect.



`allow_reboot=false` + `reset_service_password=false` **fixed the cloudbase-init
crash** — confirmed on a clone of the 2026-08-02 22:05Z artifact, whose
`cloudbase-init-unattend.log` is now clean end to end:

    Executing plugin 'MTUPlugin'
    Config Drive found on D:\
    Metadata service loaded: 'ConfigDriveService'
    Plugins execution done
    Stopping Cloudbase-Init service

Both flags verified present in the shipped conf. But clones still loop on "The
computer restarted unexpectedly". The failure moved:

    22:07:37  setup.exe: Executing SETUPUGC.EXE specialize
    22:07:46  remove-build-profile.ps1 -> exit 0x0
    22:07:48  CBS: TrustedInstaller SHUTDOWN_REASON_NOTIFICATION:PRESHUTDOWN
    22:07:50  cloudbase-init starts (i.e. during teardown)
    22:07:51  cloudbase-init finishes cleanly

A shutdown begins ~11s into the specialize pass, *before* cloudbase-init runs, so
the pass is aborted mid-flight — which is exactly what produces that dialog.
TrustedInstaller is reacting to the shutdown (PRESHUTDOWN notification), not
causing it.

Ruled out so far:
- Not queued servicing in the image: `Windows\WinSxS\pending.xml` is absent.
- Not cloudbase-init self-rebooting: `allow_reboot=false` is set and its log
  shows a clean exit with no reboot request logged.
- Not a one-boot hiccup: a second boot of the same clone loops identically.

**Initiator identified 2026-08-02 from the clone's System event log:**

    id=1074  C:\Program Files\Cloudbase Solutions\Cloudbase-Init\Python\python.exe
             WIN-8OHAID6OILR | restart | "Cloudbase-Init reboot" | NT AUTHORITY\SYSTEM

Cloudbase-Init reboots the machine *itself*, mid-specialize, and
`allow_reboot=false` does not prevent it. The randomized hostname in the event
shows `SetHostNamePlugin` had already renamed the machine — renaming is what makes
the plugin request the reboot.

**Correction (2026-08-03): it is the *service* run, not the specialize run.**
Two earlier readings here were wrong and cost a cycle each:

1. The randomized `WIN-…` hostname in event 1074 is what **sysprep** assigns on
   generalize. It is *not* evidence that `SetHostNamePlugin` ran. Removing that
   plugin from the specialize conf therefore changed nothing.
2. `allow_reboot=false` **does** work. Read from the shipped `init.py`:

       if reboot_required and CONF.allow_reboot:
           osutils.reboot()
       else:
           LOG.info("Plugins execution done")
           ... LOG.info("Stopping Cloudbase-Init service")

   The clone's `cloudbase-init-unattend.log` ends with exactly that else-branch,
   so the specialize run never reboots.

The reboot comes from the **cloudbase-init service**, which `Finalize.ps1` sets to
`Automatic`. On a clone's first boot it starts while specialize/OOBE is still
running, uses `cloudbase-init.conf` (which has `SetHostNamePlugin` and no
`allow_reboot=false`), renames the machine and reboots mid-pass. Corroboration:
the failed clone carries a populated `cloudbase-init.log` from that service run.

Real fix: **delayed auto-start for every release**, not just 2019. The
`BuildNumber <= 17763` gate assumed 2022/2025 reach GeneralizationState=7 only
after OOBE completes; they do not.

Fix: the specialize-pass conf runs **MTUPlugin only**. `MTUPlugin` never requests
a reboot. The hostname is still applied, by `SetHostNamePlugin` in the post-OOBE
service run (`cloudbase-init.conf`), where a reboot is normal and harmless.

Reading the event log is what settled this after two wrong fixes; `setupact.log`
and CBS only ever showed TrustedInstaller *reacting* to the shutdown. Extract
`Windows/System32/winevt/Logs/System.evtx` offline and parse it with
`python-evtx` (a venv is required — system pip is PEP-668 managed).

### Superseded: the policy-wipe theory (correct observation, wrong conclusion)

Installing a cumulative update **does** wipe the suppression — this part is real
and was measured directly on a live windows-server-2022 guest during round one,
via `qm guest exec`:

    HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU
      AUOptions = 3            <- Windows' own value
      (NoAutoUpdate and NoAutoRebootWithLoggedOnUsers are GONE)

    UsoSvc            Running / Automatic
    Schedule Scan     Ready
    USO_UxBroker      Ready
    Reboot_AC         Disabled   <- the task disable did survive

`Install.ps1` writes those two values once, at install time. The round-one
cumulative update removes them and re-arms the automatic agent. Round two then
begins with the orchestrator live; it finds the pending restart and reboots the
VM ~2–3 minutes in, killing the provisioner. Nothing throws — the process is
killed — so packer reports only `Script exited with non-zero exit status: 1`,
which is exactly the observed signature. The earlier note above that this was
"not a lost fix" verified the *source* and never checked the *guest*.

Fix: `WU.ps1` re-arms the suppression itself, both at the start of a round and
again after the installs (so the machine returns from packer's reboot already
suppressed), and logs the values that actually stuck. `Install.ps1` keeps its
original call for the pre-round-one window; `Finalize.ps1` still deletes the
whole AU key before sysprep, so the shipped template is unaffected.

Note this is *not* distinguishable from a load-related WinRM drop by the packer
log alone, which is why the 07-31 investigation stalled on the concurrency
correlation. Capture the guest directly instead — `qm guest exec <vmid>
--timeout 30 -- powershell -Command '<script>'`. That subcommand emits JSON by
default and has **no `--output-format` option**; passing one makes every call
fail to parse. cf's own `collectDiagnostics` cannot help here: it runs only
after all `CF_BUILD_ATTEMPTS` are exhausted, by which point packer has already
run `Deleting VM`.

### Post-update restart settling

`windows-restart` had no `restart_check_command`, so packer used its default,
which reports the machine "restarted" the moment WinRM answers. After a
cumulative update WinRM comes back long before Windows finishes committing it —
TiWorker/TrustedInstaller are still saturating the disk. Packer would then wait
`pause_before = 30s` and provision straight into that window.

**This was first written as the single cause of both 2026-08-01 failures. That
was wrong for 2025** — a rebuild with the fix in place still failed round two
identically, which is what forced the guest-side measurement that found the
policy wipe above. The restart gap did widen from ~2.5 min to ~8 min, so the
check works; it just was not what was killing 2025. Treat this section as the
fix for the *upload race* only:

- **windows-server-2022, 02:50Z, 2h36m.** `PROVISIONER ERROR: The term
  'c:/Windows/Temp/script-<uuid>.ps1' is not recognized...`. Packer's upload of
  the round-two script had not landed when `ps_execute` ran it.
- **windows-server-2025, 02:47Z / 04:42Z / 07:29Z, ~1h55m each.** The documented
  round-two signature — `iteration 1 - searching for updates`, ~2–3 min, exit 1.
  The 07:29Z run already had `restart_check_command`, so this one is **not** the
  restart race; see the policy-wipe root cause above.

Fix (all three recipes): a shared `local.restart_check` wired into every
`windows-restart` provisioner as `restart_check_command`. It refuses to report
the machine back until the guest has been up ≥180s **and** no `TiWorker` or
`TrustedInstaller` process is running, so packer keeps polling through the
servicing window instead of provisioning into it. The pre-Finalize restart
timeout went 15m → 30m for the same headroom.

`ps_execute` was hardened alongside it: its wait-for-upload deadline went 120s →
300s, and when the deadline expires it now fails with `script never arrived at
<path>` instead of falling through and running the missing path, which is what
turned a slow upload into the misleading "is not recognized" error.

Status: **TRIED AND FAILED on a live build 2026-08-01.** Do not re-attempt this
check in this form. windows-server-2025 ran with it and failed at 1h58m with the
byte-identical round-two signature (`iteration 1 - searching for updates` at
07:27:58, dead ~2 min later). Measured effect of the check: the post-round-one
restart took ~8 min with it versus ~7.4 min without — i.e. **it added nothing
beyond its own 180s uptime floor.**

Why it does not work: `TiWorker`/`TrustedInstaller` are a **weak busy signal**.
Probing a live 2022 guest at 07:27Z, *mid-update*, showed `TrustedInstaller` in
state `Stopped` and no `TiWorker` process at all. Those processes are absent for
most of the servicing window, so the gate opens immediately. Any future settle
check must key on something that is actually true during servicing — pending
reboot flags (CBS `RebootPending`, WindowsUpdate `RebootRequired`,
`PendingFileRenameOperations`), which `Finalize.ps1` already uses, are the
obvious candidates.

The `ps_execute` hardening above is independent of this and is worth keeping:
2022's `is not recognized` failure has not recurred.

Superseded by the measurement below: the restarting process is **TrustedInstaller,
not the Update Orchestrator**, and the settle idea was right while the signal was
wrong. Re-keyed onto pending-reboot state — see the next section.

The export gate remains unexercised — no 2026-08-01 build has reached it.

### The round-two reboot is TrustedInstaller, not the Update Orchestrator

**Measured directly 2026-08-01 10:12Z** by polling the live guest's System log
(`wu-capture.sh`, event 1074 on VM 200107):

```
10:08:42 id=1074  The process C:\Windows\servicing\TrustedInstaller.exe (TEMPLATE)
         has initiated the restart of computer TEMPLATE on behalf of
         NT AUTHORITY\SYSTEM for the following reason:
         Operating System: Upgrade (Planned)
         Reason Code: 0x80020003  Shutdown Type: restart
```

The initiator is the **servicing stack**, finishing a pending component-based
servicing operation. This is why suppressing the AU policy and disabling the
`UpdateOrchestrator\Reboot*` tasks does not stop it — those govern the Windows
Update *agent*, a different subsystem. `4e1e166`'s re-arm works exactly as
instrumented (round two on 2025 began with `NoAutoUpdate=1
NoAutoRebootWithLoggedOnUsers=1` logged and confirmed) and the build **still**
died at 10:11Z, 2.5 min into round two — the fourth identical 2025 failure. Keep
the re-arm (a re-armed orchestrator is its own hazard) but do not expect it to
fix this.

The same run also showed why 2022 survives where 2025 dies. It is timing, not a
per-release difference: TrustedInstaller rebooted the 2022 guest at 10:08:42
*while packer was still inside its restart-wait loop*, so packer never resumed
into a session that was about to be killed; it moved on at ~10:12 after the
second boot settled. On 2025 the same reboot lands after packer has already
resumed and started round two.

Fix: `local.restart_check` re-keyed off process presence and onto **pending
reboot state** — CBS `RebootPending`, WindowsUpdate `RebootRequired`, and
`PendingFileRenameOperations`, plus a 120s floor. If the servicing stack still
intends to reboot, packer waits; once it has rebooted and settled, the flags
clear and round two starts on a quiet machine. Validated by running the exact
predicate on a live guest (returned `restarted.` on a settled 200107) and with
`packer fmt`. **Unverified on a completed build.**

Do not reach for `TiWorker`/`TrustedInstaller` process presence as the readiness
signal — a live 2022 guest mid-update showed `TrustedInstaller` `Stopped` with no
`TiWorker` at all, so that gate opens immediately. That was 5bd7a39's mistake.

### windows-server-2022 Windows Update round-one stall (2026-08-01)

Distinct from the round-two failure and **unexplained**. A 2022 build sat at
`install 20%` for 145+ minutes, versus 112 min and ~120 min on the two prior
runs, with the guest genuinely idle rather than slow:

- `SoftwareDistribution\Download` frozen at exactly 1,132,977,685 bytes across a
  45-second sample; ~2.5 KB of network received in that window.
- Host-side over 30s: +53 KB disk read, +578 KB disk write, kvm at 8% of one
  core.
- `TrustedInstaller` service `Stopped`, no `TiWorker`, `CBS.log` untouched for
  20 minutes while WUA still reported `install 20%`.

The bound is `WU.ps1`'s own `[TimeSpan]::FromHours(3)` deadline, after which it
throws `Windows Update did not create <flag>`. This run was cancelled before
reaching it, so it is not known whether the stall self-resolves. Note both prior
runs *did* break out of this plateau after ~2 hours, so a long idle stretch here
is not by itself proof of a hang.

Note for whoever verifies this: cf cannot capture guest evidence for these
failures on its own. `collectDiagnostics` runs only after *all*
`CF_BUILD_ATTEMPTS` are exhausted (`src/build/executor.ts`), by which point
packer has already run `Deleting VM`, and `windowsGuestLogs`
(`src/build/diagnostics/guest-logs.ts`) collects Panther + CBS but not the
System event log. Poll the live guest instead — `qm guest exec <vmid> --timeout
30 -- powershell -Command '<script>'`. That subcommand emits JSON by default and
has **no `--output-format` option**; passing one makes every call fail to parse.

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

##### 2026-08-01: a failed sysprep shipped a "successful" template — the likely real Mode B

A `windows-server-2022` build reported `Build 'proxmox-iso.windows-server-2022'
finished after 3 hours 7 minutes` and published an artifact. Offline inspection
of that artifact (procedure above) showed it was **never generalized at all**:

| marker | good 2019 template | this 2022 artifact |
| --- | --- | --- |
| `SetupType` | 2 | **0** |
| `CmdLine` | `oobe\windeploy.exe` | **empty** |
| `ImageState` | `…GENERALIZE_RESEAL_TO_OOBE` | **`IMAGE_STATE_COMPLETE`** |
| `Sysprep_succeeded.tag` | present | **absent** |

That is the Mode-B signature exactly — and it was produced by a build that
reported success. Facts established from the artifact itself:

- **Sysprep ran and failed**, at 23:07:16, in Appx pre-validation:
  `SYSPRP Package Microsoft.MicrosoftEdge.Stable_150.0.4078.105… was installed
  for a user, but not provisioned for all users` → `Failed to remove apps for
  the current user: 0x80073cf2` → `Hit failure while pre-validate sysprep
  generalize internal providers`. A Windows Update had installed Edge per-user
  during the build. 2019 is immune (legacy Edge is not an Appx package), which
  is why this surfaced only now.
- **The script reached sysprep**: `C:\Windows\Temp\cb-sysprep-unattend.xml` and
  `C:\Windows\Setup\Scripts\remove-build-profile.ps1` were both written (23:06).
- **`Finalize.ps1`'s own arming gate never recorded an attempt** — its
  `C:\Windows\Temp\cf-sysprep-retry.log` does not exist, and the export began
  seconds after sysprep failed, so the guest script was cut off rather than
  completing its retry.
- **Packer never saw a failure.** No error appears in the build log; the last
  guest output is the step *before* sysprep, then packer's `Stopping VM`.

**Why this most likely IS the original Mode B.** Every earlier theory —
post-cumulative CBS corruption, a WMI race, "transient generalize corruption" —
was inferred from error lines that were later falsified. This explanation needs
no such inference: sysprep simply fails (or is cut off), nothing propagates the
failure, and the unarmed image is exported as a success. It also predicts the
observed intermittency, since whether generalize completes before packer moves
on is timing- and load-dependent, and it explains the 02:43Z 2026-07-24 template
without appealing to a guest-internal reboot. Treat the earlier CBS/WMI framing
as superseded unless new evidence revives it.

**Fixes (2026-08-01), all three defensive at a different layer:**

1. `ps_execute` in all three recipes wrapped the script call in `try/catch`.
   It previously ended `exit $LastExitCode`, which reflects the last *native*
   command, so a thrown error could exit with a stale `0`.
2. `recipes/_shared/post/assert-generalized.sh` (new) reads the finished disk
   **from the host** before the shrink and fails the build unless the image is
   generalized and armed, dumping the guest's `setuperr.log` on failure. This is
   the guarantee: no guest-side exit-code plumbing can mask it.
3. `Finalize.ps1` unregisters per-user Appx packages that are not provisioned
   for all users, which is the supported fix for `0x80073cf2` and leaves the
   Win32 Edge install alone.

Still open: the precise mechanism by which packer concluded success. It was not
worth another build cycle to pin down, because fix 2 makes the outcome safe
either way — but do not "explain" it in this document without evidence.

**Both fixes confirmed working on a live build 2026-08-01 13:26Z.** A
windows-server-2022 build reached sysprep for the first time since the WU
round-two failures were fixed, sysprep aborted, and the gate did exactly its job:

```
==> assert-generalized: inspecting /var/lib/vz/images/200107/base-200107-disk-1.qcow2
assert-generalized: reading Windows volume at sector 239616
assert-generalized: FAIL Sysprep_succeeded.tag missing — sysprep did not generalize this image
--- guest sysprep setuperr.log (last 20 lines) ---
SYSPRP Package Microsoft.MicrosoftEdge.Stable_150.0.4078.105_neutral__8wekyb3d8bbwe was ins...
SYSPRP Failed to remove apps for the current user: 0x80073cf2.
SYSPRP Exit code of RemoveAllApps thread was 0x3cf2.
assert-generalized: FAIL SetupType is not 2 / CmdLine does not launch windeploy.exe /
                    ImageState is not GENERALIZE_RESEAL_TO_OOBE
assert-generalized: REFUSING to export — every clone would stick at GeneralizationState 3
```

This is the 2026-07-31 silent export caught loudly, with the culprit named. Note
`ImageState` read back `IMAGE_STATE_COMPLETE`, i.e. a plain un-generalized image —
exactly what shipped silently before.

**The Appx cleanup (fix 3) is not sufficient.** It ran and Edge still blocked
sysprep. Its `Remove-AppxPackage -ErrorAction SilentlyContinue` swallowed
whatever went wrong, so the build log named nothing and the failure only surfaced
three hours later as a bare `0x80073cf2`. Changed so the per-package failure is
caught and printed, Edge processes (`msedge`, `msedgewebview2`,
`MicrosoftEdgeUpdate`) are stopped first since the package cannot be unregistered
while they run, and any package still registered-but-not-provisioned is listed as
a WARNING naming the exact blocker. Still deliberately non-fatal — sysprep's
pre-validation and the gate remain the authority.

**Unverified:** whether stopping the Edge processes is enough to make the removal
succeed. The next failure will at least say why it did not, which the previous
one could not. Do not assume this is fixed.

Packer also emits a second, cosmetic error alongside the real one on this path —
`Error destroying builder artifact: ... msgpack decode error ... bad artifact: []`.
It is a plugin quirk when a post-processor fails, not a separate fault.

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

**Handling as of 2026-07-31 (third direction, generalized):** the defect's
mechanism is that the specialize-pass cloudbase run used the MSI's shipped
`cloudbase-init-unattend.conf`, which runs the **full** plugin stage —
consuming `SetUserPasswordPlugin`'s run-once slot before oobeSystem applies
the seeded password. `Finalize.ps1` now overwrites that conf with a restricted
one (MTU + SetHostName only, logging to `cloudbase-init-unattend.log`), so the
password is applied by the post-OOBE **service** run, after oobeSystem — the
same ordering the delayed-auto start already gives Server 2019. 2019's flow is
unchanged by this. Status: **expected fix for 2022/2025, pending a live
rebuild + verify** (`cipassword-validates` in `cf verify` is the direct
regression check).

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
| Build reports success but every clone is Mode B | sysprep failed (or was cut off) and the failure never reached packer, so an ungeneralized image was exported | Host-side `assert-generalized.sh` fails the build before export; `ps_execute` propagates thrown errors. See the 2026-08-01 subsection |
| Sysprep aborts `0x80073cf2` — `installed for a user, but not provisioned for all users` | Windows Update registered an Appx package (typically Edge) for the build user mid-build; generalize pre-validation refuses | `Finalize.ps1` unregisters per-user, non-provisioned Appx packages before sysprep |

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
