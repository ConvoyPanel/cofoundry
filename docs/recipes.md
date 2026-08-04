# Recipes

All current recipes perform an unattended ISO installation on Proxmox and then
export a vzdump artifact. The `# build_vmid` in each HCL file is a stable recipe
base ID. During `cf build`, networked installers use
`base_build_vmid * 100 + slot_index` so parallel builds do not share VM state.

## Supported recipes

| Family         | Recipe                | Base VMID | Build/final disk |
| -------------- | --------------------- | --------: | ---------------: |
| Ubuntu         | `ubuntu-22.04`        |      1002 |               5G |
| Ubuntu         | `ubuntu-24.04`        |      1003 |               5G |
| Ubuntu         | `ubuntu-25.10`        |      1004 |               5G |
| Ubuntu         | `ubuntu-26.04`        |      1005 |               5G |
| Windows Server | `windows-server-2019` |      2000 |       100G / 30G |
| Windows Server | `windows-server-2022` |      2001 |       100G / 30G |
| Windows Server | `windows-server-2025` |      2002 |       100G / 32G |
| Debian         | `debian-11`           |      4000 |               5G |
| Debian         | `debian-12`           |      4001 |               5G |
| Debian         | `debian-13`           |      4002 |               5G |
| Rocky Linux    | `rocky-linux-8`       |      5000 |               5G |
| Rocky Linux    | `rocky-linux-9`       |      5001 |               5G |
| Rocky Linux    | `rocky-linux-10`      |      5002 |               5G |
| AlmaLinux      | `almalinux-8`         |      6000 |               5G |
| AlmaLinux      | `almalinux-9`         |      6001 |               5G |
| AlmaLinux      | `almalinux-10`        |      6002 |               5G |

The Windows build disk is intentionally temporary working space. The guest and
host shrink steps reduce it to `# final_disk_size` before export.

## Adding or updating a recipe

Copy the nearest recipe in the same OS family, then update every piece of
release identity together:

- header metadata: `display`, `group`, `build_vmid`, `iso_url`,
  `iso_target_path`, checksum URL, and filename pattern where present;
- the `build_vmid` default and recipe locals;
- source name, ISO filename, checksum, and unattended-install paths;
- image/edition name and release-specific drivers;
- CPU and memory if the installer genuinely requires different resources.

Choose a unique base VMID in the family's existing range. Do not choose a live
slot-derived ID directly.

Keep disks small. The Linux installers currently fit in 5G. For Windows, retain
the temporary build/final shrink design and change the final size only after
checking the installed minimum and the vzdump sparse-data report:

```text
INFO: backup is sparse: X GiB (Y%) total zero data
```

Run a full build after recipe changes. HCL syntax alone cannot validate an ISO's
image names, boot sequence, driver directories, or unattended installer schema.

### Ubuntu autoinstall

Copy the matching `user-data` and empty `meta-data` files under
`recipes/<recipe>/http/`. Update release-specific package or boot arguments only
when required by that installer.

The build's ephemeral SSH key is installed for the `packer` user in a
`late-command`, **not** through the autoinstall `ssh:` section. Subiquity's
`ssh.authorized-keys` registers the key as an *instance* public key, and
cloud-init then also plants it in `/root/.ssh/authorized_keys` as a neutered
`disable_root` forced-command stub (`command="…Please login as the user…exit
142"`) — the build key leaking into the shipped template, which the
`no-foreign-authorized-keys` verify check flags on every Ubuntu leg. Per-user
keys never propagate to root, so the recipe instead declares `packer` via the
`identity:` block (locked password; `packer` authenticates by key and is deleted
before export) and writes the key + a `NOPASSWD` sudoers file in late-commands,
mirroring the Debian preseed and AlmaLinux/Rocky kickstart flows. Because the
`ssh:` section is gone, `openssh-server` is listed under `packages:` (installing
it enables `ssh.service` via the systemd preset) and the existing
`sshd_config.d/10-cofoundry.conf` late-command carries `PasswordAuthentication`.

**The `identity` user does not exist in the target when `late-commands` run.**
Confirmed on a live 22.04 build (and reproduced for 25.10): Subiquity defers
`identity`-user creation to cloud-init's *first boot* of the installed system,
so at `curtin in-target` time there is no `packer` user or group. The original
`install -d -m 700 -o packer -g packer /home/packer/.ssh` therefore failed with
`install: invalid user 'packer'`, and a failed late-command **aborts the entire
autoinstall** — the installer drops to its error shell with sshd still up, so
Packer sees port 22 open but can never authenticate and times out after 30
minutes. (This is a different failure from the boot-key corruption below, though
both surface as a 30-minute SSH timeout; tell them apart from the serial console
— an aborted install shows `An error occurred. Press enter to start a shell`.)

The recipe now creates the group and user in-target (`groupadd`/`useradd`,
guarded so they no-op where a Subiquity version already made them) *before* the
key-install commands. cloud-init reconciles the pre-existing `packer` user
idempotently on first boot, so its locked password, sudo group, and home are
still applied. Re-run the `no-foreign-authorized-keys` check to confirm root is
clean at the source (the `cloud-init-cleanup.sh` root strip remains as a
belt-and-suspenders backstop regardless).

Keep `boot_key_interval = "100ms"`. Proxmox types the boot command through the
QEMU `sendkey` API; with no interval the guest keyboard buffer intermittently
drops characters. This was observed corrupting the initramfs `ip=` netmask
(`…255.255.255.0` arriving as `…255.25.250`), which the installer could not
parse — networking never came up, the autoinstall user-data was never fetched,
and the build failed with a 30-minute SSH timeout. The failure was diagnosed
from a framebuffer screenshot captured by the build diagnostics recorder (see
[diagnostics.md](diagnostics.md)); spacing the keystrokes
resolves it.

#### Ubuntu grubenv race

<a id="ubuntu-grubenv-race"></a>

Ubuntu 26.04 renamed `grub-common.service` to `grub2-common.service`, but
`grub-initrd-fallback.service` still ships `After=grub-common.service`. systemd
treats an `After=` naming a unit that does not exist as no ordering constraint
at all — silently — so on 26.04 the two units both start at
`boot-complete.target` in the same second, and both rewrite
`/boot/grub/grubenv` with `grub-editenv`. `grub-editenv` writes through
`fopen(path, "wb")`, which truncates before it writes 1024 bytes; a concurrent
reader landing in that window gets a short block and exits 1 with
`grub-editenv: error: invalid environment block`. `grub2-common.service` then
fails, `systemctl is-system-running` reports `degraded`, and the `systemd-healthy`
verify check fails the leg.

Measured directly on the shipped 26.04 image (VMID 9501 restored from the
failing artifact of run `30868276107`):

| concurrent `grub-editenv` pairs | sequential runs |
| ------------------------------- | --------------- |
| 25 / 200 failed                 | 0 / 400 failed  |

That per-boot probability is why the failure looked intermittent — run
`30868276107` passed `systemd-healthy-first-boot` and then failed
`systemd-healthy` after the reboot.

The recipe restores the ordering with a drop-in:

```
/etc/systemd/system/grub-initrd-fallback.service.d/10-cofoundry-grubenv-race.conf
[Unit]
After=grub-common.service
After=grub2-common.service
```

Both spellings are listed because the Ubuntu family shares one byte-identical
`user-data` (enforced by `tests/recipe-consistency.test.ts`). On a release still
using the old name the `grub2-` line is inert, and on 26.04 the `grub-` line is
— the same "After= a unit that isn't there is a no-op" behaviour that caused the
bug, relied on deliberately here. It also means the fix already covers 22.04,
24.04 and 25.10 when they inherit the rename.

Verified live: with the drop-in in place, `grub2-common.service` **Finished**
before `grub-initrd-fallback.service` **Starting** on every boot, across 20+
reboots with no `degraded` state. Without it, both logged `Starting` in the same
second.

This is an upstream Ubuntu packaging bug, not a Cofoundry defect — but it ships
in every template built from that image, so the template is where it is fixed.

### Debian preseed

Copy a nearby `preseed.cfg`. The committed file must contain
`__PACKER_SSH_PUBLIC_KEY__`, not a real key. `scripts/inject-placeholders.sh`
generates a fresh ephemeral Ed25519 key for each build and replaces either the
placeholder or a previously injected `packer-<recipe>-*` key, so reruns remain
safe even without `git clean`. The hostname line uses
`__PACKER_RECIPE_NAME__`, which the same script replaces with the recipe name,
so the preseed files stay identical across Debian releases
(`tests/recipe-consistency.test.ts` enforces this).

### AlmaLinux and Rocky Linux kickstart

Copy the nearest `ks.cfg` and update repository/release details. These builds
also use the allocated NAT address and ephemeral SSH credentials.

RHEL ships `qemu-guest-agent` with the `guest-exec` RPC denied (Debian and
Ubuntu permit it), which fails the build smoke test's reboot-and-verify step
(`src/verify/guest.ts`) with `Command guest-exec has been disabled`. Every
almalinux/rocky recipe runs `_shared/post/enable-guest-exec.sh` to permit it.
The deny mechanism differs by release — el8 uses a `BLACKLIST_RPC` block list,
el9+ a `FILTER_RPC_ARGS="--allow-rpcs=..."` allow list — and the script handles
both. It must run **after** `dnf update`, because a guest-agent package refresh
can rewrite `/etc/sysconfig/qemu-ga` back to the shipped defaults.

### Windows Server

Read [`windows.md`](windows.md) before making any Windows change.
In particular:

- look up the current Proxmox `ostype` enum instead of guessing a release-named
  value;
- copy `autounattend.xml` and update the image name plus all VirtIO driver
  directories;
- preserve the shared scripts under `recipes/_shared/windows/`;
- keep 2025-only requirements, including TPM/CPU/CompactOS behavior, scoped to
  the versions that need them;
- record every debugging experiment in [`windows.md`](windows.md).

Microsoft evaluation links sometimes resolve to a registration page instead of
an ISO. If validation reports an HTML download, obtain the current direct link
from the Microsoft Evaluation Center and update the recipe metadata and cached
ISO filename together.
