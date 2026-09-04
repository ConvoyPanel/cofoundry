# Windows Server recipes

Reference for Windows recipe configuration: what is true now, and which
settings must not be changed without paying for a rebuild.

Dated experiments — including failed ones — go in
[windows-log.md](windows-log.md), never here. When a finding changes what this
document says, edit the statement.

## Load-bearing settings

Each of these was found by a build that cost 1–4 hours. Changing one without
reading its section reintroduces a failure that is expensive to rediscover.

| Setting                                                                    | Where                                    | Breaks if changed                                                                                                         |
| -------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Nothing above sysprep may touch WinRM auth, policy keys, or firewall rules | `Finalize.ps1`                           | Severing WinRM truncates the script silently; packer reads the disconnect as success and exports a broken template        |
| `cf-finalize-complete.tag` written last, after the teardown                | `Finalize.ps1` / `assert-generalized.sh` | The only detector for post-sysprep truncation. Do not move it earlier                                                     |
| `allow_reboot=false`, `reset_service_password=false`                       | `cloudbase-init-unattend.conf`           | Every clone loops on "The computer restarted unexpectedly"                                                                |
| Specialize conf runs **`MTUPlugin` only**                                  | `cloudbase-init-unattend.conf`           | Any plugin that requests a reboot aborts the specialize pass                                                              |
| `mtu_use_dhcp_config=false`                                                | both cloudbase-init confs                | MTUPlugin fails `WinError 10013` on 2019 (UDP/68 is held by the DHCP Client service)                                      |
| `restart_check` tests `PackagesPending` as well as `RebootPending`         | all three `.pkr.hcl`                     | A cumulative can clear `RebootPending` and leave `PackagesPending`; Finalize then refuses at the pre-sysprep gate, ~4h in |
| `max_retries = 2` on every powershell provisioner                          | all three `.pkr.hcl`                     | A lost upload after a cumulative update costs the whole build instead of one provisioner                                  |
| `<Compact>false</Compact>`                                                 | `windows-server-2025` answer file        | Deterministic phase 71 / DISM `0x80071160` during servicing                                                               |
| `ostype` from the Proxmox enum, never from the release name                | all three `.pkr.hcl`                     | There is no `win2k19`/`win2k22`/`win2k25`                                                                                 |

`Finalize.ps1` is the one provisioner deliberately **without** `max_retries`: it
is not idempotent after sysprep, and it retries its own arming step internally.

## Recipe matrix

| Recipe                | Proxmox `ostype` | VirtIO directory | TPM 2.0 | Final disk | Boot blanket | Answer-file exception      |
| --------------------- | ---------------- | ---------------- | ------: | ---------: | ------------ | -------------------------- |
| `windows-server-2019` | `win10`          | `2k19`           |      No |        30G | `<enter>`    | None                       |
| `windows-server-2022` | `win11`          | `2k22`           |     Yes |        30G | `<enter>`    | None                       |
| `windows-server-2025` | `win11`          | `2k25`           |     Yes |        32G | `<up>`       | `<Compact>false</Compact>` |

The ISO URL, image name, and VirtIO directory must match the release. Everything
else stays aligned across the three unless a documented installer requirement
says otherwise.

**The two boot-blanket variants are deliberate.** The ~60s keypress burst that
covers the OVMF "press any key" window keeps typing after WinPE's GUI loads. The
"Installing Windows Server" screen has one focusable Cancel button, so a stray
`<enter>` opens a quit-confirmation modal; if it opens on the burst's last
keystroke nothing dismisses it and setup blocks until `winrm_timeout`. 2025 types
`<up>`, which satisfies OVMF but only moves focus in the GUI. 2019 and 2022 still
type `<enter>` and build reliably — propagating `<up>` is reasonable hardening
that costs a ~3h revalidation each, so it is a follow-up, not a fix.

If the modal is hit live, `qm sendkey <vmid> ret` presses its default **No** and
the install resumes at once. `esc` does not close it.

## Proxmox OS type

Never invent an `ostype` from a Windows release name. Check the Proxmox
`qemu-server` schema. The enum, verified against Proxmox 9.1.18 and upstream
`qemu-server` 9.2.0:

```text
other wxp w2k w2k3 w2k8 wvista win7 win8 win10 win11 l24 l26 solaris
```

Proxmox maps Server 2019 to `win10`, and Server 2022 and 2025 to `win11`. The
[upstream definition](https://github.com/proxmox/qemu-server/blob/b69480d6110c005b9eb936c55c0438607d10975b/src/PVE/QemuServer.pm#L365-L387)
is the source of truth — the Packer plugin's generated field description has
historically lagged it.

## Shared configuration

All three recipes share OVMF, Q35, host CPU, 4 cores, 8 GiB RAM; VirtIO SCSI with
discard and an I/O thread; a 100G temporary build disk; the NAT build network with
a per-build DHCP slot and slot-derived VMID; the wide OVMF boot-key window; WinRM
on the allocated IP with a 45-minute initial timeout; and the shared install,
update, pre-finalize, finalize, shrink, and export scripts.

`cpu_type = "host"` is required so setup can see SSE4.1/4.2. `winrm_host` is set
to the allocated build IP because Windows has no QEMU agent during setup and
packer would otherwise wait on IP discovery.

The temporary disk is reduced before export: `Finalize.ps1` shrinks the Windows
partition, then the host-side post-processor truncates the virtual disk to the
declared final size. The `# final_disk_size` metadata and `local.final_disk_size`
must match.

For networked builds `cf` derives the live VMID as
`base_build_vmid * 100 + slot_index`; the HCL base is only the default for a
manual Packer invocation. Find failed builds by `packer-<recipe>` name rather
than assuming a fixed VMID.

### CompactOS on Server 2025

The 2025 ISO selects a compact apply whenever the answer file omits
`<Compact>false</Compact>`, and that apply then fails deterministically during
servicing with phase 71 / DISM `0x80071160`. A 64G disk does not change the
policy decision. `Install.ps1` also runs `Compact.exe /CompactOS:never` as a
post-boot safety check.

Do not add CompactOS commands to `windowsPE` or `specialize` — every variant
tried either crashed early WinPE, was ineffective, or hit the same DISM
filesystem-limitation failure.

## Terminology: the four things called "specialize"

Conflating these has confused every reader of `Finalize.ps1`'s unattend-rewriting
block, including its authors — the commit that did the work is titled "drop
cloudbase-init's specialize command entirely", which reads as though the pass
itself was removed. It was not.

| #   | Thing                          | What it is                                                                                                                                                                      | Do we touch it?                                                                                                                         |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | the specialize **pass**        | Windows boot phase on a generalized image. Generates the new SID and machine identity, re-enumerates drivers. Launched by `windeploy.exe`, which `SetupType=2` + `CmdLine` arm. | **No.** Never. It is what the export gate certifies is armed.                                                                           |
| 2   | the `RunSynchronous` **list**  | Commands the answer file asks that pass to run.                                                                                                                                 | Yes — we rewrite its contents.                                                                                                          |
| 3   | cloudbase-init's **command**   | One entry in that list, shipped by the MSI.                                                                                                                                     | **Deleted** (`3208b0c`), replaced with our own profile-cleanup command.                                                                 |
| 4   | `cloudbase-init-unattend.conf` | The config file entry 3 ran with.                                                                                                                                               | Still written. Unused by our clones once 3 is gone, but live for anyone re-sysprepping with the vendor's untouched `conf\Unattend.xml`. |

The same key is repeated inline at the top of the deletion block in
`recipes/_shared/windows/Finalize.ps1`.

## Build flow

1. `autounattend.xml` loads the release-matched VirtIO storage and network drivers
   and installs the Datacenter image.
2. First-logon commands enable WinRM Basic authentication and unencrypted HTTP for
   the Packer session.
3. `Install.ps1` disables CompactOS, installs VirtIO guest tools, verifies QEMU-GA,
   and pins WinRM through the update reboots.
4. Two Windows Update rounds run as a SYSTEM scheduled task. Packer performs a
   conditional reboot after each round.
5. `PreFinalize.ps1` disables hibernation and the pagefile for compaction.
6. `Finalize.ps1` cleans the component store, installs Cloudbase-Init, shrinks the
   partition, zeros free space, runs sysprep, then tears down WinRM.
7. The host asserts the image is generalized and armed, truncates the disk, exports
   the artifact, and destroys the build VM.

Cloudbase-Init is installed **after** Windows Update on purpose: a 2025 checkpoint
cumulative can perform a near-full OS redeploy, and the late install guarantees
Cloudbase-Init is present immediately before export.

### Windows Update: what the build controls, and what it cannot

`WU.ps1` installs every update explicitly through the WUA COM API and signals
`RebootRequired` back to Packer, which owns every restart through
`windows-restart`.

- **The AU policy is suppressed for the build's duration** (`NoAutoUpdate=1`,
  `NoAutoRebootWithLoggedOnUsers=1`, plus the `UpdateOrchestrator\Reboot*` tasks
  disabled). A cumulative update **wipes those values**, so `WU.ps1` re-arms them
  at the start of each round and again after the installs. `Finalize.ps1` deletes
  the whole AU key before sysprep, so the shipped template keeps Windows' defaults.
- **TrustedInstaller's own restart cannot be suppressed.** The servicing stack
  performs a planned restart to finish committing an update, typically ~60s after
  the machine returns from packer's restart. `NoAutoUpdate` governs the AU agent
  and the orchestrator tasks govern USO restarts; neither has authority here. The
  reboot is legitimate and must be waited out, not blocked.
- **`restart_check` is what waits it out.** It gates on pending-servicing state —
  CBS `RebootPending` and `PackagesPending`, WindowsUpdate `RebootRequired`,
  `PendingFileRenameOperations` — plus no `TiWorker`/`TrustedInstaller` process
  and a 180s uptime floor. The flags alone are insufficient: they describe work
  already _queued_ and say nothing about servicing still executing. The process
  check alone is also insufficient: those processes are absent for most of the
  servicing window. Both are needed.
- **Uploads still race the post-update window.** Packer's powershell provisioner
  uploads an env-vars file and a script, and either can fail to land. `ps_execute`
  waits for both by name (300s) and reports `script never arrived at <path>`
  rather than falling through to a vague "is not recognized". `max_retries = 2`
  makes a lost upload cost one provisioner instead of a whole build. Treat the
  upload as inherently unreliable after a cumulative rather than something a wait
  can fully prevent.

`WU.ps1` reports download/install progress by polling the asynchronous
`BeginDownload`/`BeginInstall` COM jobs, logging each 5% step to `tb-wu.log`; if
the callback types fail to compile it falls back to the synchronous batch call, so
a callback problem can only lose the progress readout, never fail a build. It also
registers its SYSTEM task at priority 4 (normal, versus Task Scheduler's default 7)
and selects the High performance power scheme, restoring the prior scheme in a
`finally` block. Do not raise `TiWorker`, `TrustedInstaller`, or the update task to
High/Realtime: that starves storage, RPC, QEMU-GA, and WinRM without accelerating
serialized work.

## Sysprep and the export gate

Sysprep runs with `/quit`, so the machine stays up and registry writes still land
in the sealed image. Two things depend on that: the WU-policy restore, and the RDP
enablement, both of which sit in the post-generalize block.

`Finalize.ps1` then asserts the arming markers directly — `SetupType=2`, a
`CmdLine` launching `windeploy.exe`, and
`ImageState=IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE` — retries once, and **fails the
build** if still unarmed. An unarmed template is broken on every clone; never ship
one. On a failed attempt it dumps `setuperr.log`, `setupact.log`, and the arming
registry state to packer's stdout, because packer deletes the VM seconds later.

`recipes/_shared/post/assert-generalized.sh` repeats the check **from the host**,
reading the finished disk before the shrink, and refuses the export if the image is
not generalized and armed or if `cf-finalize-complete.tag` is missing. This is the
backstop no guest-side exit-code plumbing can mask.

Do not grep `setuperr.log` for a corruption signature. `MRTGeneralize: ERROR:
Failed ConnectServer`, `Failed to re-enable Compat-Gentel custom trigger`, BCD
`c000000d`, and a present `RespecializeCmdLine` all appear in verified-armed
templates. The arming markers are the only real signal.

### Appx packages that block generalize

Generalize refuses any package that is registered for a user but not provisioned
for all users (`0x80073cf2`), so `Finalize.ps1` unregisters per-user,
non-provisioned packages before sysprep. The rules that make that cleanup safe,
each learned from a build it broke:

- **Skip only packages with no per-user registration** (`PackageUserInformation`
  with `InstallState = Installed`). Skipping anything merely present in
  `Get-AppxProvisionedPackage` misses Edge, which appears there under the very full
  name sysprep rejects.
- **Skip `$pkg.IsFramework` and `$pkg.NonRemovable`.** Frameworks can never be
  removed while dependents remain, and non-removable packages refuse every route.
- **Never deprovision an entry whose `PackageName` equals the registered
  `PackageFullName`.** Deprovisioning a non-removable package strips its
  provisioning while leaving the payload — manufacturing the exact
  registered-but-not-provisioned state generalize refuses.
- **Stop Edge processes first** (`msedge`, `msedgewebview2`, `MicrosoftEdgeUpdate`);
  the package cannot be unregistered while they run.
- **Match on the package family**, not the full name, so coexisting versions (2025
  ships two `DesktopAppInstaller` builds) are both found.
- **Re-provision afterwards** from the payload Server keeps on disk
  (`C:\Windows\InboxApps`, then `%ProgramFiles%\WindowsApps` — no network), for
  every family whose provisioning the cleanup dropped. Provisioning is what
  registers an app into each new user profile, and `remove-build-profile.ps1`
  deletes the build profile, so anything left unprovisioned is missing from every
  clone. Failures are logged, never fatal: a template without winget is a defect,
  one that never generalizes is useless.

**A long "still registered" warning list is normal.** One image listed 41
registered, non-provisioned packages and generalize objected to exactly one — the
only `SignatureKind` `Store` entry. The other 40 were non-removable inbox
SystemApps, which sysprep tolerates. The count says nothing about whether sysprep
will pass; only the packages sysprep names matter.

## The clone's first boot

A clone boots the armed image, runs specialize, completes OOBE, and then the
Cloudbase-Init **service** applies the cloud-init metadata.

- **Cloudbase-Init is delayed-auto-start on every release**
  (`sc.exe config cloudbase-init start= delayed-auto`). An Automatic-start service
  runs plugins before VDS/WMI/user profiles are ready, and can start while
  specialize is still running — where it renames the machine, reboots mid-pass, and
  strands the clone on "The computer restarted unexpectedly". The
  `BuildNumber <= 17763` gate that once scoped this to 2019 was wrong: 2022 and
  2025 do not reach `GeneralizationState=7` only after OOBE completes.
- **The specialize-pass conf runs `MTUPlugin` and nothing else.** MTUPlugin never
  requests a reboot. Do not remove it — an empty plugin list is not the goal; a
  reboot-free one is.
- **The hostname lands post-OOBE**, applied by `SetHostNamePlugin` in the service
  run, where a reboot is normal. A clone is therefore briefly reachable under the
  random `WIN-XXXXXXX` name sysprep gave it before being renamed (~2 min, with a
  reboot). This is why `cf verify`'s `hostname-applied` check runs in the
  `post-reboot` phase rather than `first-boot`.
- **`CreateUserPlugin` is dropped.** Administrator already exists; the plugin's
  only effect was opening a logon session that re-created the
  `C:\Users\Administrator` profile the specialize command had just deleted.
  `SetUserPasswordPlugin` sets the password on its own.
- **`SetUserSSHPublicKeysPlugin` is dropped**, and `cf verify` no longer seeds
  `--sshkeys` for Windows clones. The template ships no OpenSSH, so the plugin
  failed `[WinError 2]` on every init run. See "Restoring SSH key injection" below.

### OOBE must actually complete

Cloudbase-Init blocks until `GeneralizationState` reaches 7. The Cloudbase-Init
MSI's `Unattend.xml` drives OOBE with `<SkipMachineOOBE>`/`<SkipUserOOBE>`, both
deprecated: they suppress the screens without running the completion work that
advances that value, so the clone sits at state 3 forever and no plugin ever runs.

`Finalize.ps1` rewrites the `oobeSystem` block of the unattend it passes to
sysprep — the deprecated skip pair is replaced with the explicit `Hide*` settings
plus a `UserAccounts/AdministratorPassword`, and a
`Microsoft-Windows-International-Core` component (en-US) is injected, because the
`Hide*` flags do not cover OOBE's first region/language/keyboard screen. The OOBE
node is rebuilt in schema order rather than appended to; the unattend schema
validates its children as an ordered sequence.

Do not try to force `GeneralizationState=7`. A `SetupComplete.cmd` never fires (it
is gated on the OOBE completion that never happens), and an AtStartup task can
force 7 mid-setup, rebooting Cloudbase-Init into a bricked clone. Letting OOBE
complete is the fix.

### The stale build profile

`sysprep /generalize` does not delete user profiles. Shipping the build's
`C:\Users\Administrator` gives a clone a **gray desktop** — no wallpaper, icons, or
taskbar, though Ctrl+Alt+Del and Task Manager work. The profile's per-user shell
state refers to pre-generalize package identities, and `ShellHost.exe` (which
composes the desktop surfaces on 2025, separately from `explorer.exe`) crash-loops
on it with `0xc0000409` in `ControlCenter.dll` roughly every 31 seconds.

`Finalize.ps1` writes `C:\Windows\Setup\Scripts\remove-build-profile.ps1` and
injects a `RunSynchronousCommand` calling it into the **specialize** pass. That is
the first point the profile can be deleted — `Finalize.ps1` itself cannot, because
Packer is logged in as Administrator at that moment. The command takes `Order` 1.

Every clone therefore creates a fresh Administrator profile on first logon, which
would expose the per-profile privacy prompt (`SkipUserOOBE` does not cover it — it
is first-run, not OOBE). `Finalize.ps1` sets `DisablePrivacyExperience=1` to keep
first logon non-interactive.

`DisablePrivacyExperience` skips the prompt and accepts Windows' defaults; it does
**not** reduce collection. Telemetry is minimized separately with
`AllowTelemetry=0` ("Security", honored on Server SKUs). `ProtectYourPC` stays at
`1` — it gates Defender, SmartScreen, and automatic updates, not telemetry, so
lowering it would weaken security for no privacy gain. Do not conflate the two.

## What ships in a template

**RDP is enabled.** `Finalize.ps1` sets `fDenyTSConnections=0` and enables the
inbox Remote Desktop firewall group (matched by its locale-independent id
`@FirewallAPI.dll,-28752`, not the DisplayGroup string) in the post-generalize
block. NLA stays at its Server default, so nothing is reachable pre-auth.

The tradeoff is deliberate: every clone exposes 3389 on whatever network it lands
on, guarded by NLA plus the strength of `--cipassword`. The alternative was
console-only first contact, which locks out any operator whose keyboard layout
disagrees with the image about symbol placement — noVNC types against the guest's
en-US layout, so a `--cipassword` containing symbols arrives as different
characters. The `rdp-enabled` verify check asserts enabled, listening on 3389, and
NLA on.

**The build's WinRM password is in the image until first boot.** The seeded
`AdministratorPassword` comes from `CF_ADMIN_PASSWORD` (each recipe's
`var.winrm_password`), so nothing is hardcoded in the repo, but it is a real
plaintext exposure:

- `C:\Windows\Panther\unattend.xml` — Windows scrubs this to
  `*SENSITIVE*DATA*DELETED*`.
- `C:\Windows\Temp\cb-sysprep-unattend.xml` — the copy passed to sysprep.
  `Finalize.ps1` deletes it before power-off (the `/quit` flow is what makes that
  possible), so it no longer ships. The specialize-script delete remains as a
  backstop for templates built before 2026-07-31.

`cf verify`'s `no-plaintext-build-password` check greps the answer files and
Panther logs for the recovered build password on every Windows build, so a
regression surfaces as a failing verify rather than a manual probe.

## Constraints on the caller

**A `--cipassword` must not start with a YAML indicator character.** Proxmox
interpolates it into its generated cloud-init user-data **unquoted**, and YAML
forbids a plain scalar from beginning with `@ ! # % * -`. The whole document
becomes unparseable, Cloudbase-Init aborts `UserDataPlugin`, and the clone comes up
with no hostname and no password — while every earlier plugin logs success. No
error names the password. This is not Windows-specific: the same user-data is
generated for `nocloud`, so a Linux clone fails identically.

Cofoundry's `sentinelPassword()` forces an alphanumeric first character, and
`tests/verify-clone.test.ts` round-trips the real user-data document through a YAML
parser. That covers Cofoundry's own sentinel only — **consumers passing
user-supplied passwords (Convoy, coport) are still exposed**, and the constraint
belongs at the point the password is accepted: reject a leading indicator at input
validation, or quote the value before it reaches `qm set`.

**A `--cipassword` must satisfy the guest password policy.** The template ships
Windows' default `PasswordComplexity = 1`: three of four character classes, at
least six characters. `SetUserPasswordPlugin` otherwise fails with `Set user
password failed: The password does not meet the password policy requirements`.
This is a caller-side constraint — do not relax the guest policy to work around it.

## Debugging workflow

> **Read [debugging.md](debugging.md) first.** It covers what decides how long a
> session takes: preserving the failing VM with `qm set <vmid> --protection 1`,
> querying the live guest, parse-checking PowerShell locally with `pwsh`, and
> picking the cheapest test that can falsify the hypothesis. What follows is the
> Windows-specific triage on top of it.

Before changing HCL, an answer file, or a provisioner:

1. Search the failure reference below, then [windows-log.md](windows-log.md), for
   the symptom or error code.
2. Find the live VM by name — `qm list | grep 'packer-windows-server'`.
3. Identify the failure stage before proposing a fix:
    - no partitions: setup rejected input before disk configuration;
    - partitions but no Panther logs: early WinPE failure;
    - `$Windows.~BT/Sources/Panther`: apply or WinPE logs;
    - `Windows/Panther`: specialize or installed-OS logs;
    - negligible disk writes plus an OVMF message: boot-prompt timing.
4. Record the symptom, the change, and the result in
   [windows-log.md](windows-log.md).

**Query the live guest; do not infer from packer's log.** Several multi-hour
investigations stalled on correlations that a single guest probe would have
settled:

```sh
qm guest exec <vmid> --timeout 60 -- powershell -NoProfile -Command '<script>'
```

It emits JSON with the guest's stdout in `out-data` — parse with `python3`, not
`sed`, since the payload carries escaped quotes and CRLFs. There is **no
`--output-format` option**; passing one makes every call fail to parse. `cf`'s
`collectDiagnostics` cannot substitute: it runs only after all `CF_BUILD_ATTEMPTS`
are exhausted, by which point packer has run `Deleting VM`, and `windowsGuestLogs`
collects Panther and CBS but not the System event log.

For the System event log specifically, extract
`Windows/System32/winevt/Logs/System.evtx` offline and parse it with `python-evtx`
(a venv is required — system pip is PEP-668 managed). Reading it is what settled
the clone-reboot investigation after two wrong fixes; `setupact.log` and CBS only
ever showed TrustedInstaller _reacting_ to a shutdown.

### Inspecting a template offline

An exported template's arming can be verified without booting it, which replaces a
900s clone-verify with a couple of minutes:

```sh
# decompress, extract, then loop-mount the NTFS partition read-only.
# Compute the offset with `sgdisk -p`: the primary GPT is valid but the backup
# header is truncated away by the 100G->30G shrink, so the kernel will not
# auto-partition the image.
mount -t ntfs3 -o ro,loop,offset=$((239616*512)) <raw> /mnt
reged -x /mnt/Windows/System32/config/SYSTEM '\HKEY_LOCAL_MACHINE\SYSTEM' '\Setup' out.reg
```

`chntpw`/`reged` and ntfs3 are installed on the build node. Check `SetupType`,
`CmdLine`, `ImageState`, and `GeneralizationState`.

To confirm driver directories on the actual VirtIO ISO:

```sh
mount -o loop /var/lib/vz/template/iso/packer-virtio-win-<version>.iso /tmp/vm
ls /tmp/vm/vioscsi/
```

### The node records what each build actually ran

`/var/lib/vz/dump/cofoundry-snapshots/<hash>/` holds content-addressed copies of
the recipe tree exactly as each build ran it. Treat those as ground truth when the
working tree has moved on — they are how a set of uncommitted `Finalize.ps1`
experiments was recovered after the fact.

## Failure reference

| Symptom                                                                                               | Cause or diagnostic                                                                                                                                 | Current handling                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Proxmox rejects `ostype`                                                                              | A release-derived value was invented                                                                                                                | Read the Proxmox enum: `win10` for 2019, `win11` for 2022/2025                                                                    |
| APIPA address or unreachable WinRM                                                                    | VM is on the wrong bridge or lacks its DHCP reservation                                                                                             | Use the NAT build bridge and allocated IP/MAC slot                                                                                |
| Packer waits for IP discovery                                                                         | Windows has no QEMU agent during setup                                                                                                              | Set `winrm_host` to the allocated build IP                                                                                        |
| OVMF reports no bootable device                                                                       | Boot-from-CD keypress missed on a loaded node                                                                                                       | Keep the two-second wait and ~60-second keypress blanket                                                                          |
| WinRM HTTP 401 during initial setup                                                                   | Basic auth or unencrypted service access not applied                                                                                                | Keep the four separate first-logon commands and exact `cmd.exe /c winrm set ... @{...="true"}` quoting                            |
| WinRM HTTP 401 just after reboot                                                                      | `winrm quickconfig` in the keepalive task reset the service                                                                                         | Keepalive reapplies only the two `winrm set` commands; post-reboot provisioners wait 30s                                          |
| Cloudbase-Init download fails in the VM                                                               | Older Windows TLS stack cannot fetch the GitHub asset                                                                                               | Download on the host; attach the MSI to the answer-files ISO                                                                      |
| Windows Update COM returns access denied                                                              | WinRM has a network token                                                                                                                           | Run update work as a SYSTEM scheduled task                                                                                        |
| Temp PowerShell script missing after update reboot                                                    | WinRM reconnects before the filesystem settles                                                                                                      | Retain `pause_before = "30s"` after reboots                                                                                       |
| `packer-ps-env-vars-*.ps1` not recognized after WU reboot                                             | `ps_execute` waited only for `{{.Path}}`, then dot-sourced `{{.Vars}}` before it landed                                                             | `ps_execute` waits for both, by name, and fails with `script never arrived at <path>`                                             |
| WinRM timeout at exactly `winrm_timeout` + overhead; Setup GUI shows "Are you sure you want to quit?" | The `<enter>` boot blanket outlives WinPE load; a stray Enter presses Setup's Cancel                                                                | `qm sendkey <vmid> ret` dismisses it live (`esc` does not); 2025 types `<up>` in the blanket                                      |
| Server 2025 disk invisible in WinPE                                                                   | Wrong VirtIO directory                                                                                                                              | Use `2k25`, not `2k22`                                                                                                            |
| Setup fails before partitioning                                                                       | Invalid answer/setup input, including invalid CompactOS syntax                                                                                      | Inspect the attached answer files; do not revive the `setupconfig.ini` experiment                                                 |
| Setup fails near 11 GB written with `0x80071160`                                                      | Compact WOF apply cannot be serviced from WinPE                                                                                                     | Retain `<Compact>false</Compact>`                                                                                                 |
| Specialize fails `ERROR_BADDB` / `0x800703f9`                                                         | Intermittent corrupt `COMPONENTS` hive transaction state                                                                                            | Retain retries; investigate host RAM or storage integrity, not CompactOS permutations                                             |
| WU round-two provisioner exits 1 after ~4 min, no artifact                                            | TrustedInstaller restarts the guest to commit servicing, killing the provisioner                                                                    | `restart_check` holds packer across it; `WU.ps1` re-arms the AU suppression each round                                            |
| `servicing still pending before sysprep (CBS RebootPending/PackagesPending)`                          | A cumulative cleared `RebootPending` but left `PackagesPending`; packer resumed anyway                                                              | `restart_check` tests both; the guard names which keys and packages are pending                                                   |
| Two builds interfere, or an orphan controls the slot                                                  | Stale remote Packer/watchdog or fixed VMID state                                                                                                    | Slot-derived VMIDs, stale process cleanup, orphan VM eviction, name-based pruning                                                 |
| Clone boots to a gray desktop with no taskbar                                                         | Template shipped the build's `C:\Users\Administrator`; pre-generalize shell state crash-loops `ShellHost.exe` (`0xc0000409` in `ControlCenter.dll`) | `Finalize.ps1` deletes that profile from the specialize pass                                                                      |
| Clone asks for an Administrator password; cloud-init never applies                                    | Deprecated `SkipMachineOOBE`/`SkipUserOOBE` leave `GeneralizationState` at 3                                                                        | `Finalize.ps1` rewrites the OOBE block to `Hide*` + `AdministratorPassword` + International-Core                                  |
| Clone loops "The computer restarted unexpectedly"                                                     | Cloudbase-Init requested a reboot during the specialize pass                                                                                        | `allow_reboot=false`, `reset_service_password=false`, and `MTUPlugin` alone in the specialize conf                                |
| `Set user password failed: ... password policy requirements`                                          | `cipassword` violates the guest's `PasswordComplexity = 1`                                                                                          | Caller must supply a compliant password; the seeded `AdministratorPassword` keeps the clone reachable                             |
| Clone comes up with no hostname and no password, every plugin logging success                         | `cipassword` starts with a YAML indicator, so Proxmox's user-data does not parse                                                                    | Reject a leading `@ ! # % * -` at the point the password is accepted                                                              |
| Clone stuck at `GeneralizationState=3`, no `Windows\Panther\setupact.log`, build profile intact       | Template exported with `SetupType=0`/empty `CmdLine` — reseal arming missing                                                                        | `Finalize.ps1` asserts the arming markers and fails the build; `assert-generalized.sh` repeats it host-side                       |
| Build reports success but every clone is unarmed                                                      | sysprep failed or was cut off and the failure never reached packer                                                                                  | `assert-generalized.sh` fails the build before export; `ps_execute` propagates thrown errors                                      |
| Sysprep aborts `0x80073cf2` — "installed for a user, but not provisioned for all users"               | WU registered an Appx package (typically Edge) for the build user                                                                                   | `Finalize.ps1` unregisters per-user, non-provisioned packages before sysprep                                                      |
| `PROVISIONER ERROR: There is not enough space on the disk.` after the sysprep step header             | The zero pass wrote to `ERROR_DISK_FULL` and its `SilentlyContinue` delete failed, carrying a full volume into sysprep                              | The zero pass stops at a 1 GB reserve and throws if the fill file survives; a free-space gate lists the largest directories on C: |
| `sysprep did not arm the image for OOBE after 2 attempts`, no detail                                  | The message pointed at a log on a VM packer deletes seconds later                                                                                   | `Finalize.ps1` dumps `setuperr.log`/`setupact.log` and the arming registry state to packer's stdout                               |
| MTUPlugin fails `[WinError 10013]`                                                                    | The plugin binds UDP/68 to read DHCP option 26; the DHCP Client service already owns it                                                             | `mtu_use_dhcp_config=false` in both confs                                                                                         |
| `winget` missing from a 2025 clone                                                                    | The Appx cleanup dropped `DesktopAppInstaller`'s provisioning, so fresh profiles never get it                                                       | Finalize re-provisions dropped families from on-disk payload; `winget-present` verify check (2025 only)                           |

## Rejected approaches — do not retry

- `win2k19`, `win2k22`, `win2k25` are not Proxmox enum values.
- A fixed `10.0.0.100` address and MAC caused stale-lease and concurrency problems.
- A short OVMF keypress burst missed the boot prompt under node load.
- `winrm quickconfig -force` in the startup keepalive raced Packer after reboot.
- Downloading Cloudbase-Init inside the VM failed on older TLS stacks.
- Reusing `2k22` VirtIO drivers for 2025 failed disk discovery.
- `setupconfig.ini` with `CompactOS=disable` was invalid; `CompactOS=Never` was
  ignored from the answer-files media.
- WinPE or specialize-pass CompactOS commands were ineffective, crashed setup, or
  caused DISM `0x80071160`. Removing `<Compact>false</Compact>` produced the
  deterministic phase 71 failure, and a 64G disk did not change the policy.
- Removing `Windows.old` reclaims nothing — it is an empty stub even after a 2025
  checkpoint cumulative's OS redeploy. `Finalize.ps1` removes it anyway; that is
  not a fix for anything. (When measuring it, count enumeration errors before
  believing a size: ACLs stop the walk and `SilentlyContinue` reports 0 for a
  populated tree.)
- Removing `/ResetBase` from `Finalize.ps1` was proposed for the gray desktop and
  disproved — `sfc` found no integrity violations and the shell binaries share one
  timestamp. (`/ResetBase` does leave `DISM /RestoreHealth` with no local payload,
  so repairs on a clone need Windows Update or fail `0x800f081f`.)
- Disk truncation was ruled out for the same symptom by arithmetic: `qemu-img
resize --shrink ... 32G` is GiB, and `Shrink-SystemPartition` targets 32GiB−1GiB.
- `SkipMachineOOBE`/`SkipUserOOBE` are deprecated and do not complete OOBE.
- Grepping `setuperr.log` for `Compat-Gentel` / `MRTGeneralize Failed
ConnectServer` / `RunExternalDlls` as a generalize-corruption signal was
  falsified: an offline-verified armed template carries all of them.
- Suppressing Windows Update policy to stop the round-two reboot: the restarter is
  TrustedInstaller, which those policies do not govern.
- `TiWorker`/`TrustedInstaller` process presence **alone** as a servicing-readiness
  gate: a live guest mid-update showed `TrustedInstaller` `Stopped` with no
  `TiWorker`, so the gate opens immediately.
- Forcing `GeneralizationState=7` from `SetupComplete.cmd` (never fires) or an
  AtStartup task (bricks the clone mid-setup).
- Blaming `cf verify`'s 900s settle window for clone failures: a healthy clone
  settles in ~90s, so a timeout is the real defect, not the window.

## Open issues

- **`no-critical-service-failures` warns on every build.** The check lists
  Automatic services not yet running, minus a hard-coded _name_ allowlist, because
  `Get-Service` does not expose `DelayedAutoStart`. Every release trips it —
  including on `cloudbase-init`, whose stopped state at that point is the success
  condition. Reading
  `HKLM\SYSTEM\CurrentControlSet\Services\<name>\DelayedAutostart` (or `sc.exe qc`)
  would classify these properly. Warning on every build trains readers to ignore
  warnings.
- **`rearm-headroom` warns on 2025, passes on 2019 and 2022.** It cannot yet
  distinguish "0 rearms left" (a real defect for anyone sysprepping a clone) from
  "could not read the count from `slmgr /dlv`" (a probe that does not match this
  release). All three builds ran sysprep once, so a mismatched probe is much the
  likelier explanation. Verify now prints warning output (`200a11d`); resolve on
  the next 2025 verify.
- **Intermittent `ERROR_BADDB` during specialize** reproduced with verified install
  media, adequate free space, and no competing build. Treat host RAM or the storage
  path as the leading untested hypothesis — not a reason to revisit CompactOS.
- **A 2026-08-01 build reported success after a failed sysprep** and the precise
  mechanism by which packer concluded success was never pinned down. It was not
  worth a build cycle, because `assert-generalized.sh` makes the outcome safe
  either way. Do not "explain" it here without evidence.
- **`WU.ps1`'s async progress reporting and throughput mode are unconfirmed on a
  live build.** Confirm the log shows download/install percentages rather than the
  `async ... unavailable ... using synchronous batch` fallback, and that it contains
  both `throughput mode enabled` and `restored power scheme`.

### Restoring SSH key injection

Dropping `SetUserSSHPublicKeysPlugin` is a capability removal, not just a verify
fix: `--sshkeys` is now inert on Windows clones and stays inert even if an operator
installs OpenSSH afterwards, because nothing in the image writes `authorized_keys`.

To bring it back, fix the cause rather than re-adding the plugin — it failed
precisely _because_ there was no OpenSSH to write into. Add the inbox capability in
`Install.ps1` (no download needed):

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

then restore the plugin to the `plugins=` line of `cloudbase-init.conf` in
`Finalize.ps1`, and drop the `remoteKeyPath` omission in `src/verify/clone.ts`.
Costs a ~3h revalidation per recipe, a slightly larger image, and opens port 22 on
the template. Decide whether that is wanted first.
