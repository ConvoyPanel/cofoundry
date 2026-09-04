# Windows experiment log

Dated record of every Windows build experiment, including the ones that failed
and the theories that were later falsified. Newest first.

This is history, not instructions. What is *currently* true lives in
[windows.md](windows.md) — when an entry here changes that, edit windows.md too.
Append a new entry rather than rewriting an old one; a wrong theory that cost a
build cycle is worth exactly as much as the fix that followed it.

---

## 2026-08-27 — `cipassword` starting with a YAML indicator breaks every clone

Proxmox interpolates `--cipassword` into its cloud-init user-data unquoted
(confirmed on PVE 9.2.2 with `qm cloudinit dump <vmid> user`). A password
beginning with `@ ! # % * -` makes the document unparseable —
`yaml.scanner.ScannerError ... line 6, column 11`, column 11 being the password's
first character. Cloudbase-Init aborts `UserDataPlugin`; the clone comes up with
no hostname and no password while every earlier plugin logs success. Nothing names
the password, which is what made it expensive.

Not Windows-specific: the same user-data is generated for `nocloud`.

Fixed for Cofoundry's own sentinel (`sentinelPassword()` forces an alphanumeric
first character; `tests/verify-clone.test.ts` round-trips the real document
through a YAML parser). Consumers passing user-supplied passwords remain exposed.

**Supersedes the earlier triage of upstream #34**, which blamed the keyboard-layout
problem. That problem is real and separately fixed, but cannot explain #34:
`cipassword-validates` passes in-guest via `LogonUser`, which never touches a
keyboard layout. An unparseable user-data document does explain it.

## 2026-08-27 — 2019 MTUPlugin fails `WinError 10013`

A rebuilt 2019 clone failed `cloudbase-init-completed` with `plugin 'MTUPlugin'
failed with error '[WinError 10013]'`, twice in one verify run (first boot and
post-reboot) — deterministic, not a flake.

Not caused by the RDP change or the Finalize edits landed the same day: 2022 was
rebuilt from the same tree and passes, and the 2026-08-04 2019 artifact passed.
What is unique is 2019 plus three weeks of newer cumulatives. Everything else on
the clone was healthy — 15 of 16 checks passed.

**Diagnosed by probing a live clone, not by guessing.** MTUPlugin queries DHCP
option 26 by binding UDP/68 itself; `Get-NetUDPEndpoint -LocalPort 68` showed
`svchost` — the DHCP Client service — already holding it. Binding a port another
process owns exclusively is WSAEACCES, surfacing as 10013. 2022/2025 pass with the
same MSI, so this is 2019's service start ordering.

Fix: `mtu_use_dhcp_config=false` in both confs. The adapter was already at
`mtu=1500`, so the query never applied anything — the flag costs no behaviour and
removes a guaranteed failure. Verified on the same clone: 0 failure lines, against
a reproducible failure without it. MTUPlugin stays in the plugin lists; the
specialize conf runs it and nothing else precisely because it never requests a
reboot.

## 2026-08-26 — 2022 clears the restart gate; RDP and winget compose

windows-server-2022 rebuilt with the `PackagesPending` fix and cleared the gate
that had killed it twice: sysprep armed on attempt 1/2, `assert-generalized`
reported the image armed, export completed. Its clone passed `cf verify` (928s)
including `rdp-enabled` — so the restart gate, the RDP enablement from #33, and the
winget work all compose on one artifact.

## 2026-08-25/26 — 2022: `PackagesPending` survives the restart gate

2022 failed twice in a row, ~4h into each attempt, at Finalize's pre-sysprep gate:
`servicing still pending before sysprep (CBS RebootPending/PackagesPending)`.
Twice is signal; once would have been flakiness. The gate was right to refuse — the
bug is that the build reached it in that state.

`restart_check` tested CBS `RebootPending` but not `PackagesPending`, while
Finalize's guard tested both. A cumulative can clear the former on the restart that
follows it and still leave the latter set, so packer reported the machine settled
and provisioning continued.

Finalize's own 10-minute wait cannot rescue that: `PackagesPending` is CBS work
that completes *during* a restart, so waiting for it to clear on a running system
waits forever and then throws.

Fix: `restart_check` tests `PackagesPending` in all three recipes; Finalize's guard
becomes a backstop rather than the primary gate. The guard also now names what is
pending — which keys, which entries, the last few Setup-log servicing events —
instead of asserting bare. Two four-hour attempts reported only *that* CBS was
pending, never which package.

## 2026-08-25 — winget missing from shipped 2025 templates (#32)

`Microsoft.DesktopAppInstaller` was absent from 2025 clones. Not a build failure:
every build passed, and the loss was visible only by preserving a VM and looking.

Cause: the deprovision-and-retry fallback in the Appx cleanup. 2025 ships two
coexisting DesktopAppInstaller versions; sysprep rejects the per-user-registered
one, and removing it fails `0x80070032 ERROR_NOT_SUPPORTED` until the sibling's
provisioned entry is dropped. Provisioning is what registers an app into each new
profile, and `remove-build-profile.ps1` deletes the build profile — so every
clone's first logon creates a profile with no winget.

The `provisioned packages: N -> M` reporting added earlier made the loss visible;
it did not stop it.

Fix: after the removal loop, Finalize re-provisions every family whose provisioning
the cleanup dropped, from on-disk payload (`C:\Windows\InboxApps`, then
`%ProgramFiles%\WindowsApps`) — no network. Deliberately generic, not
winget-specific: anything the cleanup drops is something a clone was supposed to
have. Failures are logged, never fatal.

A `winget-present` check asserts `winget.exe` *resolves* on the clone — a template
whose provisioning survived but never registered for the user is the same defect
from the clone's point of view. 2025-only override (`RECIPE_OVERRIDES`): winget is
not inbox on 2019 or 2022.

## 2026-08-19 — shipped templates enable RDP

Windows Server ships with RDP off, and nothing in the build changed that, so a
clone's only first contact was the noVNC console. That path breaks in practice: the
console types against the guest's en-US layout, so a `--cipassword` containing
symbols typed on a non-US client keyboard arrives as different characters.

Observed live 2026-08-18 on a 2025 clone: `=` typed on a Swedish layout never
matched; the Security log filled with `0xC000006A` while the same string passed an
in-guest `LogonUser` type 2. Convoy provisions clones with only `--cipassword`, so
RDP is the expected first door in.

`Finalize.ps1` sets `fDenyTSConnections=0` and enables the inbox Remote Desktop
firewall group in the post-generalize block — same slot as the WU-policy restore,
same reason: writes after `/quit` land in the sealed image, and the RD rules are
disjoint from the WinRM rules the teardown removes.

Verified live on a clone: the listener came up instantly with no TermService
restart, an external connect to 3389 succeeded, `fw-rules-enabled=3` matched.
Untested on a full build as of this date.

## 2026-08-04 — all three recipes build and verify

| Recipe | Build | `cf verify` |
| ------ | ----- | ----------- |
| windows-server-2019 | 1h16m | 15 passed, 1 warned (13m27s) |
| windows-server-2022 | —     | 15 passed, 1 warned |
| windows-server-2025 | 2h54m | 14 passed, 2 warned (17m27s) |

Both warnings are check defects, not template defects — see windows.md's open
issues. `no-critical-service-failures` fires on all three because it classifies
delayed-auto services by a hard-coded name allowlist; on 2019 it named
`cloudbase-init` itself, whose stopped state at that point *is* the success
condition. `rearm-headroom` fires on 2025 only and cannot distinguish a real
0-rearm template from a probe that does not match the release.

**2019's first run failed on its last step, not on the image**: `readBootId` was a
single `guestExec` with no retry, and one agent timeout while the guest was arming
autologon discarded a run that had 12 checks passed. Every other phase of
`src/verify/guest.ts` already assumes Windows guest agents go unresponsive under
load. Fixed in `e6e1a57`; the re-run passed cleanly.

## 2026-08-03 — 2025 verified end to end

First successful 2025 build: 2h54m, 14 passed / 2 warned (17m27s), including
`cipassword-validates`, `generalization-state`, `winrm-not-exposed`,
`hostname-applied`, `system-volume-extended`.

**A 2025 clone takes far longer to settle than a 2022 one.** 2022 answered the
agent in ~90s; the 2025 clone spent several minutes at ~80% CPU across 4 cores with
steady disk I/O, console a blank framebuffer throughout, and still finished inside
the 900s window. Before concluding a clone is wedged, sample `/proc/<pid>/stat` and
`/proc/<pid>/io` for the QEMU process — a working clone is visibly busy.

## 2026-08-03 — 2022 verified end to end

`cf verify windows-server-2022` passed on the `124401b` artifact: 15 passed, 1
warned, including `cipassword-validates`, `winrm-not-exposed`, and
`hostname-applied`. Reached after five consecutive clean builds.

The clone side took five layers, each found by reading the guest's own logs offline
(`qemu-nbd` + mount), never by guessing:

    allow_reboot=true            cloudbase-init self-terminated (ControlService 1062)
    reset_service_password=true  next call died (OpenSCManager 1115)
    SetHostNamePlugin            renamed in specialize; reboot landed mid-OOBE
    (still failed)               guest rebooted ~44s into specialize regardless
    -> removed the command       specialize is now just the profile cleanup

**The lesson worth keeping:** after three fixes to cloudbase-init's specialize
entry each surfaced another failure, deleting the command entirely was what worked.
It was never load-bearing — its only purpose was keeping `SetUserPasswordPlugin`
out of specialize, which removal achieves outright. Prefer removing a fragile step
over repairing it when a later stage already does the work.

## 2026-08-03 — clone specialize aborted by the Cloudbase-Init *service* (solved)

A clone of the `339eccd` artifact settled on its own: agent up at 90s, hostname
applied, cloudbase-init ran to completion and stopped. The event log shows the
designed sequence — winlogon's planned restart at 08:13:23, then a Cloudbase-Init
reboot at 08:16:24 — rather than an abort. The cloudbase-init reboot moved from
~46s to ~2.5 min after boot, which is the delayed auto-start working.

Note the working clone settles (90s) faster than the failing ones took to time out.
The theory that verify's 900s window was simply too short was **wrong**.

**Two earlier readings of this failure were wrong and cost a cycle each:**

1. The randomized `WIN-…` hostname in event 1074 is what **sysprep** assigns on
   generalize. It is *not* evidence that `SetHostNamePlugin` ran. Removing that
   plugin from the specialize conf therefore changed nothing.
2. `allow_reboot=false` **does** work. `init.py` reads
   `if reboot_required and CONF.allow_reboot: osutils.reboot()` — and the clone's
   `cloudbase-init-unattend.log` ends in the else-branch, so the specialize run
   never reboots.

The reboot came from the cloudbase-init **service**, which `Finalize.ps1` sets to
`Automatic`. On a clone's first boot it starts while specialize/OOBE is still
running, uses `cloudbase-init.conf` (which has `SetHostNamePlugin` and no
`allow_reboot=false`), renames the machine, and reboots mid-pass. Corroboration:
the failed clone carries a populated `cloudbase-init.log` from that service run.

Fix: **delayed auto-start for every release**, not just 2019 — the
`BuildNumber <= 17763` gate assumed 2022/2025 reach `GeneralizationState=7` only
after OOBE completes, and they do not. Plus a specialize-pass conf running
`MTUPlugin` only.

Reading the System event log offline (`python-evtx`, in a venv — system pip is
PEP-668 managed) is what settled this. `setupact.log` and CBS only ever showed
TrustedInstaller *reacting* to the shutdown.

## 2026-08-03 — the Appx cleanup manufactured its own generalize blocker

`Finalize.ps1`'s Appx cleanup caused the failure it exists to prevent. The image
entered Finalize with 5 provisioned packages and left with 0. Confirmed on a live
2025 guest preserved with `qm set <vmid> --protection 1`:

1. The WU round installs KB5007651. `Microsoft.SecHealthUI` becomes a Store-signed
   package, registered for the build's Administrator **and correctly provisioned**.
   sysprep is happy.
2. The cleanup sees it registered, does not skip, and calls `Remove-AppxPackage
   -AllUsers`. Windows refuses `0x80070032 ERROR_NOT_SUPPORTED`. (Per-user removal
   is refused too, `0x80073CFA`; `Set-NonRemovableAppsPolicy -NonRemovable 0`
   reports success and changes nothing.) The package is not removable by any route.
3. The failure drives the deprovision fallback, which **removes the provisioning
   while reporting "Removal failed. Please contact your software vendor."** Payload
   stays; provisioning is gone.
4. The package is now registered-but-not-provisioned — the one state generalize
   refuses — and sysprep aborts `0x80073cf2` naming it.

Fixes: skip `$pkg.NonRemovable`, and never deprovision an entry whose `PackageName`
equals the registered `PackageFullName`.

**The blocker-count warning is not a severity signal.** That image listed 41
registered, non-provisioned packages and generalize objected to exactly one — the
only `SignatureKind` `Store` entry. The other 40 were non-removable inbox
SystemApps.

## 2026-08-03 — 2025: DesktopAppInstaller blocks generalize

2025 cleared both WU rounds for the first time, reached sysprep, and failed to arm
— correctly caught and reported rather than silently exported:

    PROVISIONER ERROR: sysprep did not arm the image for OOBE after 2 attempts
    SYSPRP Package Microsoft.DesktopAppInstaller_1.26.510.0_x64__8wekyb3d8bbwe
           was installed for a user, but not provisioned for all users
    SYSPRP Failed to remove apps for the current user: 0x80073cf2

Two versions coexist — 1.26.510.0 (rejected) and 1.29.280.0. 62 packages attempted,
0 recovered, 47 still registered. The deprovision-and-retry fallback added for Edge
never fired on this path.

Cause: the fallback re-queried `Get-AppxProvisionedPackage` *inside* the catch, so a
query returning nothing or throwing made the outer catch log `STILL REGISTERED`
with no `deprovisioning` line — a silent no-op. It now uses the list enumerated once
up front, matches on package **family** so both versions are found, deprovisions
each match with its own error handling, and skips frameworks (`$pkg.IsFramework`),
which can never be removed while dependents remain and only inflate the list.

Note 2022 passes with 32 packages still registered, so "still registered" is not
itself fatal — only packages sysprep names are.

## 2026-08-03 — the 2025 finalize space failure

Two consecutive 2025 attempts died at 3h04m each and produced no usable diagnosis,
for two separate reasons:

- **Attempt 1** threw `There is not enough space on the disk` — raised by whichever
  statement after the zero pass happened to need a write first, so it named neither
  the drive nor the consumer. This is the guest's C:, not the node (which had 400G
  free). Finalize shrinks C: to `final_disk_size` minus 1G before sysprep, so the
  partition is ~31G while sysprep and the Appx work run.
- **Attempt 2** failed the arming gate twice, and the gate's own error told the
  reader to inspect a log on a VM that no longer existed.

**`C:\Windows.old` was investigated and ruled out.** The 2025 checkpoint cumulative
is applied as a full OS re-deploy, so the directory *is* created and looked like the
obvious 2025-only consumer. Measured on the live guest it is an empty stub — 0
files, 0 enumeration errors. Note a naive `Get-ChildItem -Recurse -Force
-ErrorAction SilentlyContinue | Measure-Object Length -Sum` also returns 0 for a
*populated* tree, because ACLs stop the enumeration and the error is silenced;
count the errors before believing the size. Finalize removes it anyway; it reclaims
nothing on this release.

The instrumentation matters more than either fix: a build whose failure mode is
"3 hours, then a sentence" cannot be debugged, only guessed at. Windows provisioner
scripts are now parse-checked by `tests/windows-ps-syntax.test.ts` using `pwsh`,
since a syntax error in `Finalize.ps1` otherwise costs a full rebuild to find.

## 2026-08-02 — `allow_reboot` and `reset_service_password`

Root cause found on an image the export gate had already certified as correctly
generalized and armed. The template was fine; every *clone* failed specialize and
looped on "The computer restarted unexpectedly", so Cloudbase-Init never ran and
verify failed with `Cloudbase-Init did not settle within 900s`.

Chain, from the clone's own logs read offline via qemu-nbd:

    Panther/setupact.log        SETUPUGC.EXE specialize -> process exit code = 3
    Panther/UnattendGC/…        cloudbase-init.exe … && exit 1 || exit 2
                                Process returned with exit code 0x2
    cloudbase-init-unattend.log CRITICAL pywintypes.error: (1062,
                                  'ControlService', 'The service has not been started.')

`SetHostNamePlugin` requests a reboot after renaming. Cloudbase-Init defaults to
`allow_reboot=true`, so it acts on that itself: `terminate()` stops the
cloudbase-init *service* — but during specialize it runs as a console process, the
service is not started, `ControlService` raises 1062 unhandled, the non-zero exit
takes the `|| exit 2` branch, SetupUGC returns 3, and specialize fails every boot.
The reboot is the *unattend's* job: `&& exit 1` is what signals
`WillReboot=OnRequest`, and cloudbase-init must exit 0 for that to happen.

**`allow_reboot=false` alone was not enough.** The next call in the same family
failed: `configure_host()` opens by resetting the cloudbase-init service account
password and respawning as that user —
`pywintypes.error: (1115, 'OpenSCManager', 'A system shutdown is in progress.')`,
`SetupUGC returning with exit code [4]`. Fix: `reset_service_password=false`.

**Both flags ship in the MSI's stock conf** and were lost because `Finalize.ps1`
overwrites that file wholesale. The general lesson: the specialize-pass run is a
*console* invocation, so every service-oriented path in `configure_host()` has to be
disabled by config.

Note what this says about the export gate: a template can be genuinely generalized
and armed and still produce unusable clones. The gate proves the image is armed;
only `cf verify` proves a clone boots.

## 2026-08-02 — pending flags alone are insufficient

A 2022 build rebooted twice after round one, 79 seconds apart, with the CBS/WU
flags clear throughout — captured live from the guest:

    13:21:15  BOOT TIME CHANGED 11:00:10 -> 13:20:44   (packer's restart)
    13:21:29  cbsPending=False wuPending=False servicingRunning=True
    13:22:27  BOOT TIME CHANGED 13:20:44 -> 13:22:03   (second, unsolicited)
    13:24:48  cbsPending=False wuPending=False servicingRunning=False

The registry flags describe work already *queued*; they say nothing about servicing
still executing. `TiWorker`/`TrustedInstaller` running is the signal that another
restart may still be coming. With only the flag checks, packer resumed into that
window and the second reboot destroyed the uploaded provisioner script. The process
check must stay alongside the flags; minimum uptime went 120s → 180s.

## 2026-08-02 — provisioner uploads race the post-update reboots

Even with `restart_check` correctly holding through the double reboot (verified
16:14–16:18Z: it waited past both until `servicingRunning` went False), a
provisioner upload can still fail to land. Three builds were lost this way, each
with a *different* missing file:

    script-<uuid>.ps1              "is not recognized"        (before the gate existed)
    script-<uuid>.ps1              "never arrived within 300s"
    packer-ps-env-vars-<uuid>.ps1  "is not recognized"

`ps_execute` now reports each by name instead of falling through to `. $_v` and
producing a vague "not recognized". The important change is `max_retries = 2` on
every powershell provisioner: a lost upload used to cost the entire ~3h build.
Treat the upload as inherently unreliable in the window after a cumulative rather
than something a wait can fully prevent.

## 2026-08-01 — the round-two reboot is TrustedInstaller, not the Update Orchestrator

Measured directly at 10:12Z by polling the live guest's System log (`wu-capture.sh`,
event 1074 on VM 200107):

    10:08:42 id=1074  The process C:\Windows\servicing\TrustedInstaller.exe
             has initiated the restart … Operating System: Upgrade (Planned)
             Reason Code: 0x80020003

Sequence on that guest, all within ~90 seconds: packer's restart at 10:07:22, event
log back at 10:07:42, then an **unsolicited** TrustedInstaller restart at 10:08:42.
The servicing stack performs its own planned restart to finish committing the
update, one minute after the machine returns from packer's. That second reboot kills
the provisioner.

**This is why none of the update suppression works.** `NoAutoUpdate` governs the AU
agent and the `UpdateOrchestrator\Reboot*` tasks govern USO-initiated restarts.
Neither has authority over TrustedInstaller. Do not re-attempt suppression as a fix.
`4e1e166`'s re-arm works exactly as instrumented and the build **still** died 2.5
min into round two — the fourth identical 2025 failure. Keep the re-arm (a re-armed
orchestrator is its own hazard) but do not expect it to fix this.

The same run showed why 2022 survives where 2025 dies, and it is timing, not a
per-release difference: TrustedInstaller rebooted the 2022 guest *while packer was
still inside its restart-wait loop*, so packer never resumed into a session about to
be killed. On 2025 the same reboot lands after packer has resumed.

Fix: `restart_check` re-keyed off process presence and onto pending reboot state,
plus an uptime floor.

## 2026-08-01 — superseded: the policy-wipe theory (right observation, wrong conclusion)

Installing a cumulative **does** wipe the suppression — measured directly on a live
2022 guest during round one via `qm guest exec`:

    HKLM:\…\WindowsUpdate\AU
      AUOptions = 3            <- Windows' own value
      (NoAutoUpdate and NoAutoRebootWithLoggedOnUsers are GONE)
    UsoSvc  Running/Automatic   Schedule Scan  Ready   Reboot_AC  Disabled

`Install.ps1` writes those values once, at install time, and the round-one
cumulative removes them. That is real, and `WU.ps1` now re-arms the suppression at
the start of each round and after the installs. But it is **not** what kills round
two — see the TrustedInstaller entry above.

An earlier note claiming the suppression was "still present, not a lost fix"
checked the *source*, never the *guest*. That is the recurring mistake in this
whole investigation: the packer log cannot distinguish an orchestrator reboot from
a load-related WinRM drop, which is why the 07-31 investigation stalled on a
concurrency correlation. Capture the guest directly.

## 2026-08-01 — tried and failed: `restart_check` keyed on process presence

Do not re-attempt this check in this form. 2025 ran with it and failed at 1h58m
with the byte-identical round-two signature. Measured effect: the post-round-one
restart took ~8 min with it versus ~7.4 min without — i.e. **it added nothing
beyond its own 180s uptime floor**.

Why: `TiWorker`/`TrustedInstaller` are a **weak busy signal**. Probing a live 2022
guest mid-update showed `TrustedInstaller` `Stopped` and no `TiWorker` process at
all. Those processes are absent for most of the servicing window, so the gate opens
immediately.

The `ps_execute` hardening landed alongside it (wait-for-upload 120s → 300s, and a
named `script never arrived at <path>` failure instead of running the missing path)
is independent and worth keeping.

## 2026-08-01 — the silent non-generalized export: the WinRM firewall teardown

Root cause of the 2026-07-31 silent export, identified 13:26Z. `Finalize.ps1`
restored the stock WinRM firewall exposure *before* the Appx cleanup and sysprep.
The build NIC sits on an unidentified (Public-profile) network, so removing
`WinRM-HTTP` and disabling the Public-profile HTTP-In rule drops packer's live WinRM
session. The script kept running on the guest — sysprep ran, and failed — but its
output and exit code never got back, and **packer read the disconnect as provisioner
success** and went straight to export.

The evidence is the truncation point: the log ends at `==> restore stock WinRM
firewall exposure`, next line is packer's `Stopping VM`, identical across both runs.
The earlier `3094234` diagnosis (stale `$LastExitCode`) was a real weakness but not
this — `ps_execute` never got the chance to return anything.

**Moving only part of it is not enough (21:45Z).** With the firewall rules moved,
Finalize reached the Appx step for the first time and truncated *there* instead,
because the Basic/`AllowUnencrypted` policy unpin was still above sysprep. Packer
connects with Basic auth over unencrypted HTTP, so `winrm set .../auth
@{Basic="false"}` cuts its session exactly as the firewall removal did.

The rule: **nothing above sysprep may touch WinRM auth, its policy keys, or its
firewall rules.** Everything moved together to after generalize.

## 2026-08-01 — a failed sysprep shipped a "successful" template

A 2022 build reported `finished after 3 hours 7 minutes` and published an artifact.
Offline inspection showed it was **never generalized at all**:

| marker | good 2019 template | this 2022 artifact |
| --- | --- | --- |
| `SetupType` | 2 | **0** |
| `CmdLine` | `oobe\windeploy.exe` | **empty** |
| `ImageState` | `…GENERALIZE_RESEAL_TO_OOBE` | **`IMAGE_STATE_COMPLETE`** |
| `Sysprep_succeeded.tag` | present | **absent** |

Facts from the artifact itself: sysprep ran and failed at 23:07:16 in Appx
pre-validation (`Microsoft.MicrosoftEdge.Stable_150…` registered per-user by a WU
round; 2019 is immune because legacy Edge is not an Appx package); the script did
reach sysprep; Finalize's own arming gate never recorded an attempt, so the guest
script was cut off; and **packer never saw a failure**.

**This is most likely the original "Mode B".** Every earlier theory —
post-cumulative CBS corruption, a WMI race, transient generalize corruption — was
inferred from error lines later falsified. This one needs no inference: sysprep
fails, nothing propagates the failure, the unarmed image exports as a success. It
predicts the observed intermittency (whether generalize completes before packer
moves on is timing- and load-dependent) and explains the 2026-07-24 02:43Z template
without appealing to a guest-internal reboot.

Three fixes, each defensive at a different layer:

1. `ps_execute` wraps the script call in `try/catch`. It previously ended `exit
   $LastExitCode`, which reflects the last *native* command, so a thrown error could
   exit with a stale `0`.
2. `recipes/_shared/post/assert-generalized.sh` (new) reads the finished disk **from
   the host** and fails the build unless the image is generalized and armed, dumping
   the guest's `setuperr.log` on failure. No guest-side exit-code plumbing can mask
   it.
3. `Finalize.ps1` unregisters per-user Appx packages not provisioned for all users.

**Gate confirmed working on a live build the same day (13:26Z):**

```
assert-generalized: FAIL Sysprep_succeeded.tag missing — sysprep did not generalize this image
--- guest sysprep setuperr.log (last 20 lines) ---
SYSPRP Package Microsoft.MicrosoftEdge.Stable_150.0.4078.105… was installed for a user…
assert-generalized: REFUSING to export — every clone would stick at GeneralizationState 3
```

The 07-31 silent export, caught loudly, with the culprit named.

**Fix 3 was not sufficient** — it ran and Edge still blocked sysprep, and its
`Remove-AppxPackage -ErrorAction SilentlyContinue` swallowed the reason, so the
build log named nothing and the failure surfaced three hours later as a bare
`0x80073cf2`. Changed so per-package failures print, Edge processes are stopped
first, and survivors are listed by name. Still deliberately non-fatal: sysprep's
pre-validation and the gate remain the authority.

Packer also emits a cosmetic `Error destroying builder artifact: … msgpack decode
error … bad artifact: []` on this path — a plugin quirk when a post-processor
fails, not a separate fault.

Still open: the precise mechanism by which packer concluded success. Not worth
another build cycle, because fix 2 makes the outcome safe either way.

## 2026-08-01 — 2022 Windows Update round-one stall (unexplained)

Distinct from the round-two failure. A 2022 build sat at `install 20%` for 145+
minutes, versus 112 and ~120 min on the two prior runs, with the guest genuinely
idle rather than slow:

- `SoftwareDistribution\Download` frozen at exactly 1,132,977,685 bytes across a
  45-second sample; ~2.5 KB of network received.
- Host-side over 30s: +53 KB disk read, +578 KB disk write, kvm at 8% of one core.
- `TrustedInstaller` `Stopped`, no `TiWorker`, `CBS.log` untouched for 20 minutes
  while WUA still reported `install 20%`.

The bound is `WU.ps1`'s own 3-hour deadline. This run was cancelled before reaching
it, so it is unknown whether the stall self-resolves. Both prior runs *did* break
out of this plateau after ~2 hours, so a long idle stretch is not by itself proof
of a hang.

## 2026-07-31 — node-only experiments recovered; the "corruption signature" falsified

The 2026-07-24 session continued with **uncommitted** `Finalize.ps1` experiments
that survived only in the node's content-addressed build snapshots
(`/var/lib/vz/dump/cofoundry-snapshots/<hash>/` — these record exactly what each
build ran; treat them as ground truth when the working tree has moved on). Eight
2019 builds ran over 07-23/24 in three stages: the repo script with plain
`/shutdown`; a settle gate before sysprep; then `/quit` plus a retry loop keyed on
grepping `setuperr.log` for `Compat-Gentel|re-specialize internal
providers|RunExternalDlls`.

The final 10:24 template was inspected **offline** (decompress, `vma extract`,
ntfs3 loop-mount at the `sgdisk -p` offset, `reged -x`). Findings, evidence at
`/root/win2019-evidence-20260731/`:

- It is **correctly armed**: `SetupType=2`, `CmdLine="oobe\windeploy.exe"`,
  `OOBEInProgress=1`, `ImageState=IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE`.
- Its `setuperr.log` nevertheless contains **every** error previously blamed for
  Mode B — `MRTGeneralize: ERROR: Failed ConnectServer`, `Failed to re-enable
  Compat-Gentel custom trigger`, BCD `c000000d`. **These appear in known-armed
  builds: benign noise, not a corruption signature.** The stage-3 retry heuristic
  flagged this good build "corrupt" on both attempts and shipped it with a false
  warning. The earlier WMI-race reading of `Failed ConnectServer` loses its
  evidence with it.
- `RespecializeCmdLine = sysprep /respecialize /quiet` is present in this armed
  template too — **normal** on a resealed image, not a Mode-B artifact.
- The real Mode-B anomaly reduces to exactly one thing: `SetupType=0`/empty
  `CmdLine`.
- Proxmox task logs show every build, broken and good, was captured with an
  identical `qmshutdown → qmtemplate → qmstop → vzdump` sequence. If a post-sysprep
  boot consumed the arming, it happened guest-internally and is invisible in
  retained host logs. The 02:43 vma was overwritten, so this cannot be settled
  retroactively.

Handling that superseded both node-only experiments: keep the settle gate, run
sysprep `/quit`, **assert the armed markers directly** instead of grepping error
lines, retry once, and fail the build if still unarmed. Move the WU auto-reboot
restore to after generalize. Delete the plaintext-password `cb-sysprep-unattend.xml`
before power-off (the `/quit` flow finally allows this).

Live verify of that armed 10:24 template confirmed the offline prediction end to
end. Two verify-side defects surfaced and were fixed:

- **`--sshkeys` on a Windows clone makes `SetUserSSHPublicKeysPlugin` fail**
  (`[WinError 2]`) because the template ships no OpenSSH. Verify no longer seeds SSH
  keys for Windows clones, and `Finalize.ps1` drops the plugin. See windows.md for
  how to reverse this if key injection is wanted back.
- **`waitForWindowsInit` could declare done before SetHostName's rename reboot**
  ("Plugins execution done" lands pre-reboot), so the check phase raced the reboot.
  The wait now also requires the sentinel hostname to be the active computer name.

## 2026-07-24 — 2019 clone failures: two distinct modes

Run #51's 2019 verify failed with `Cloudbase-Init did not settle within 900s`. Live
characterisation (restore the export, `qm clone`, boot — the failure is at clone
first boot, not build time) found **two** modes, only one of which the earlier
"GeneralizationState sticks at 3" note described.

**Mode A — reaches state 7 but OOBE blocks on the region screen (fixed).**
`GeneralizationState` does reach 7 and Cloudbase-Init runs, but OOBE stops on the
interactive "Hi there" region/language/keyboard screen and never completes, so no
unattended logon happens. The `Hide*` flags do not cover that first screen — only a
`Microsoft-Windows-International-Core` component does, which the per-recipe
`autounattend.xml` has for the build but the clone answer file lacked. Fixes, all
validated live on clones:

- Inject `Microsoft-Windows-International-Core` (en-US) into the clone's oobeSystem
  unattend.
- Set Cloudbase-Init to delayed-auto-start (scoped to 2019 at the time; later
  extended to every release). A 2019 clone hits state 7 while OOBE is still on
  screen, so an Automatic-start service ran plugins before VDS/WMI/user-profile were
  ready, and its SetUserPassword landed *before* oobeSystem re-seeded the
  AdministratorPassword — shipping clones with the build's throwaway password.
- Drop `CreateUserPlugin`: Administrator already exists, and the plugin's only
  effect was opening a logon session that re-created the profile
  `remove-build-profile.ps1` deletes.
- Calibrate verify: `cloudbase-init-completed` asserts "Plugins execution done"
  plus no `plugin '<name>' failed with error`/`CRITICAL`, instead of grepping every
  `ERROR` line — every Proxmox Windows clone logs benign ERRORs ("… is currently not
  supported" for the cipassword cloud-config modules; "Invalid Debian config to
  parse" for the netcfg parser). `waitForWindowsInit` requires the completion
  marker, because a delayed-auto service reads as Stopped before it fires.

**Mode B — stuck at `GeneralizationState=3`, specialize never runs.** The clone
boots straight to the lock screen with no `C:\Windows\Panther\setupact.log` and the
build's `C:\Users\Administrator` intact — the first-boot specialize/OOBE passes
never ran, so no Mode-A fix can help. Per-build and intermittent: two clones of a
template built 02:43 both stuck at 3, while two clones of an earlier template both
reached 7, with the only source diff being a runtime config line that cannot affect
sysprep.

The theory at the time was the Windows-Update servicing state at sysprep time (the
working build's update round *rolled back*; the broken build's cumulative installed
cleanly), with `SetupType=0`/empty `CmdLine` and a failing `sysprep /respecialize
/quiet` (`0x8007001f`) as the signature. **Superseded twice**: the error-line
signature was falsified on 07-31, and the actual mechanism was found on 08-01 —
sysprep failed and nothing propagated the failure.

**Dead ends from this session (do not retry).** A `SetupComplete.cmd` forcing
`GeneralizationState=7` never fires — it is gated on the OOBE completion that never
happens. An AtStartup task forcing 7 is fragile and non-deterministic: it can force
7 mid-setup, so Cloudbase-Init reboots mid-specialize and bricks the clone. Forcing
7 treats a symptom; the Mode-A fix is letting OOBE complete.

## 2026-07-21 — verified defect: the seeded AdministratorPassword overwrites the cipassword

Verified on the first clone (2025, first build of this flow) with a full paper
trail. On first boot:

1. Cloudbase-Init's sysprep-phase run executes the full MAIN plugin stage **during
   specialize**: `cloudbase-init.log` 06:37:08, `Password succesfully updated for
   user Administrator` (the Proxmox `cipassword`).
2. The **oobeSystem pass runs after it**: `Panther\UnattendGC\setupact.log`
   06:37:37, `[Shell Unattend] UserAccounts: Password set for 'Administrator'` —
   applying the seeded build password **29 seconds later**.
3. Cloudbase-Init's plugins are run-once per instance, so nothing re-applies the
   cipassword on later boots.

Net effect: every clone's final Administrator password is the build's per-build
secret, which is deleted with the build workdir. The original design assumed
Cloudbase-Init would overwrite the seeded password seconds into first boot — exactly
backwards.

Workaround at the time: `qm guest exec <vmid> -- net user Administrator <pw>`.

**Fix (2026-07-31), the generalized third direction:** the mechanism is that the
specialize-pass run used the MSI's shipped conf, which runs the **full** plugin
stage — consuming `SetUserPasswordPlugin`'s run-once slot before oobeSystem applies
the seeded password. `Finalize.ps1` overwrites that conf with a restricted one, so
the password is applied by the post-OOBE **service** run, after oobeSystem — the
same ordering delayed-auto start already gave 2019. `cipassword-validates` is the
direct regression check.

Everything else in the rewritten flow verified GOOD on the same clone:
`GeneralizationState=7`, all plugins ran, `C:\Users` contains only `Public`,
`cb-sysprep-unattend.xml` deleted, no WinRM firewall rules, Panther password
scrubbed (`*SENSITIVE*DATA*DELETED*`).

## 2026-07-21 — Windows Update auto-reboot suppression verified

All three recipes built to completion (2025 at 1h28m of provisioning) with both WU
rounds finishing and no mid-round orchestrator reboot killing a provisioner. This
verified the `NoAutoUpdate`/`NoAutoRebootWithLoggedOnUsers` policy plus the
`UpdateOrchestrator\Reboot*` task disables — later found insufficient against
TrustedInstaller (see 08-01) and to be wiped by each cumulative (see the policy-wipe
entry).

**Recurrence 2026-07-31 under concurrent load.** A 2025 build errored after 1h58m
with the exact original signature. The distinguishing condition versus the 07-21
verification was **concurrency**: two Windows builds in parallel, node load ~9.8,
1h58m to reach round two versus 1h28m total on the quiet run. A concurrently
running 2022 build passed straight through the same window, so it was not a blanket
regression. That correlation was a dead end — the cause was TrustedInstaller, found
only by capturing the guest.

## 2026-07-21 — Setup quit-confirmation modal opened by the boot keypress blanket

Observed live on 2025: three identical "Timeout waiting for WinRM" failures at
exactly 46m14s — the 45m `winrm_timeout` plus fixed overhead, so the identical
duration carries no information about *where* the guest stalled. A console
screendump of the fourth attempt showed Setup at "23% complete" with a
**"Windows Server Setup — Are you sure you want to quit?"** modal open, focus on
**No**.

The ~60-second `<enter>` blanket covering the OVMF boot prompt keeps typing after
WinPE's GUI loads. The "Installing Windows Server" screen has a single focusable
Cancel button, so a stray Enter opens the modal; any *following* Enter presses the
modal's default No and closes it — which is why the burst usually gets away with it
— but when the modal opens on the burst's final keystroke, nothing dismisses it.
Whether the race hits depends on how fast WinPE loads, i.e. node I/O load: three
parallel Windows builds reproduced it 3/3, a staggered run the previous day passed.

Live rescue, verified: `qm sendkey <build-vmid> ret` presses the focused No and the
install resumes at once — progress jumped 23% → 56% within seconds, confirming the
modal gates phase transitions. `esc` does **not** close it.

**Applied 2026-08-03 to 2025 only:** the blanket types `<up>` instead. It recurred
that day as the same timeout at 46m17s, so the race is not rare enough to ride out
on retries — each attempt costs ~46 minutes and 07-21 needed four. Deliberately not
applied to 2019/2022, which are verified working; changing a proven recipe on an
untested hypothesis is the wrong trade. The risk is cheap to carry: if OVMF ever
stops honouring the key, the failure is immediate and unmistakable ("no bootable
device" within minutes), not a 46-minute stall.

## 2026-07-21 — gray desktop on a clone: the stale Administrator profile

A cloned VM reached the logon screen, accepted the password, and showed a gray
desktop — no wallpaper, icons, or taskbar, though Ctrl+Alt+Del and Task Manager
worked. Diagnostic signature, confirmed on VM 101 (build 26100.33158):

- `explorer.exe` **is running** and persists; it is not the crasher.
- Application log repeats roughly every 31 seconds: `Faulting application name:
  ShellHost.exe … Faulting module name: ControlCenter.dll … Exception code:
  0xc0000409` (`STATUS_STACK_BUFFER_OVERRUN`, the `__fastfail` path — a deliberate
  abort, not file damage).
- `sfc /verifyonly` reports **no** integrity violations.
- `ControlCenter.dll` and `ShellHost.exe` share a `LastWriteTime`, so they are from
  the same servicing transaction.
- A newly created local account logs into a full working desktop.
- Deleting the profile and logging back in as Administrator produces first-run
  setup and then a working desktop.

The last two are decisive: the image is fine, only the profile is bad.
`sysprep /generalize` does not delete user profiles, so the template shipped
`C:\Users\Administrator` exactly as the build left it, and its per-user shell state
still referred to pre-generalize package identities.

Handling: `remove-build-profile.ps1` injected as a `RunSynchronousCommand` into the
specialize pass, which runs as SYSTEM before any logon loads the profile — the first
point it can be deleted, since `Finalize.ps1` itself is running as Administrator.
Plus `DisablePrivacyExperience=1`, because a fresh profile would newly hit the
per-profile privacy prompt that `SkipUserOOBE` does not cover.

Verified on the first 2025 build of this flow: `C:\Users` contained only `Public`,
and OOBE auto-completed with no operator prompt.

## 2026-07-21 — Cloudbase-Init never runs on a clone (OOBE never completes)

A clone prompted for an Administrator password at first boot and never applied the
cloud-init password, hostname, or volume extension. `cloudbase-init.log` filled with
one line per second, forever:

    INFO cloudbaseinit.osutils.windows Waiting for sysprep completion.
    GeneralizationState: 3

`wait_for_boot_completion` blocks until `GeneralizationState` reaches 7. The shipped
Cloudbase-Init `Unattend.xml` drives OOBE with `<SkipMachineOOBE>`/`<SkipUserOOBE>`,
both deprecated: they suppress the screens without running the completion work that
advances that value.

Confirmed on VM 101 via `qm guest exec`: state read 3 with `ImageState` empty;
setting it to 7 and restarting the service released it, and every plugin ran on the
next poll.

Handling: `Finalize.ps1` rewrites the `oobeSystem` block of the unattend copy it
passes to sysprep — the deprecated skip pair replaced with explicit `Hide*` settings
plus a `UserAccounts/AdministratorPassword`, the combination the per-recipe
`autounattend.xml` already uses. The OOBE node is rebuilt in schema order rather
than appended to; the schema validates its children as an ordered sequence.
