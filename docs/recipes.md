# Recipes

Every recipe performs an unattended ISO installation on Proxmox and exports
importable disk images (see [Disk images](disk-images.md)). The `# build_vmid`
in each HCL file is a stable recipe base ID; during `cf build`, networked
installers use `base_build_vmid * 100 + slot_index` so parallel builds do not
share VM state.

## Supported recipes

| Family         | Recipe                | Base VMID | Build/final disk |
| -------------- | --------------------- | --------: | ---------------: |
| Ubuntu         | `ubuntu-22.04`        |      1002 |               5G |
| Ubuntu         | `ubuntu-24.04`        |      1003 |               5G |
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

The Windows build disk is temporary working space; the guest and host shrink
steps reduce it to `# final_disk_size` before export.

## Adding or updating a recipe

Copy the nearest recipe in the same OS family, then update every piece of release
identity **together**:

- header metadata: `display`, `group`, `build_vmid`, `min_cores`, `min_memory`,
  `iso_url`, `iso_target_path`, checksum URL, filename pattern, and the
  checksum's signing key and signature where present (see
  [ISO pins](#iso-pins));
- the `build_vmid` default and recipe locals;
- source name, ISO filename, checksum, and unattended-install paths;
- image/edition name and release-specific drivers;
- CPU and memory, if the installer genuinely requires different resources.

Choose a unique base VMID in the family's existing range — never a live
slot-derived ID.

`# min_cores` and `# min_memory` (MiB) are the **runtime floor** published in the
sidecar's `minimum` block, not the build's shape. They are hand-authored
precisely because the HCL `cores`/`memory` are servicing headroom — Windows
builds at 4/8192 for the `WU.ps1` rounds — and publishing that would floor every
consumer's plan at the build's size. There is deliberately no minimum disk size;
see [Disk images](disk-images.md#sidecar-schema-2).

`# display` and `# notice` are read again at publish time, so changing either
reaches the registry on the next `cf publish` without a rebuild; a sidecar
keeps whatever display name it was built with, but the registry does not.
`# notice` is a one-line warning for anyone choosing the template, such as a
release that no longer receives security updates. It is published as the
template's `description`, and coport prints it before installing. A release at
end of life also says so in its display name, since that is the one field every
consumer shows, and in `/etc/motd`, for whoever logs in to a clone later.

To retire a release outright, delete its recipe along with its entries in
`upstream-checksums.json` and the build-failure issue template. `cf publish`
lists only templates that a recipe still builds, so the next publish drops it
from the registry. Dispatching the **Publish registry** workflow does that
without waiting for a build. Its images stay in R2 until the lifecycle rule
deletes them, or until you delete them by hand. Clones already made from it are
unaffected.

Keep disks small. Linux installers currently fit in 5G. For Windows, retain the
temporary build/final shrink design and change the final size only after checking
the installed minimum with `qemu-img info --output=json` on the exported image,
comparing `actual-size` against `virtual-size`.

## ISO pins

A Linux recipe's `iso_checksum = "sha256:…"` is the hash the build checks the
downloaded ISO against. `cf update` is the only thing that writes it, and only
from a checksum file signed by the vendor's key:

```
# iso_checksum_url: https://download.rockylinux.org/pub/rocky/9/isos/x86_64/CHECKSUM
# iso_filename_re: Rocky-9\.\d+-x86_64-minimal\.iso
# iso_signing_key: rocky-linux-9
# iso_checksum_sig: CHECKSUM.asc
```

`iso_signing_key` names a key under `keys/` (its README lists each fingerprint
and where it was checked). `iso_checksum_sig` is the detached signature's file
name next to the checksum file, or `clearsigned` for AlmaLinux's `CHECKSUM`.
`cf update` refuses a recipe with a checksum URL but no signing key. It builds
the ISO URL from the checksum URL it asked for, never from where a redirect
landed.

Vendors move a point release out of the release directory the day the next one
ships. The prefetch therefore tries the pinned URL and then the vendor's archive
copy of the same file (`cdimage/archive`, `old-releases.ubuntu.com`,
`vault.almalinux.org`, `dl.rockylinux.org/vault`), so a superseded pin keeps
building until someone runs `cf update`. `cf check` still reports the pinned URL
as an error, which is the prompt to do so.

## Finalizing a Linux image

Every Linux recipe ends the same way: upgrade packages, reboot into the new
kernel, upload `recipes/_shared/linux/` to `/tmp/cofoundry`, and run
`finalize.sh` as the last provisioner. Recipes do no cleanup of their own.
`finalize.sh` does what the distros' own cloud-image builds do, and fails the
build if any step does not hold:

- removes every kernel but the running one, and on Debian and Ubuntu the
  bare-metal packages the installers pull in (firmware, microcode, thermald,
  kdump-tools and the like), each only when apt would remove it alone;
- removes what the installers leave: kickstart files, `/var/log/installer`,
  Subiquity's netplan and cloud-init files, d-i's apt and fstab settings, the
  NetworkManager profiles and leases;
- installs `99-pve.cfg` and checks cloud-init is enabled and not told to skip
  networking;
- checks the effective sshd settings with `sshd -T`, not the files that hold
  them;
- strips identity: machine-id, SSH host keys, the random seed, systemd's
  credential secret, chrony state, the iSCSI initiator name, snapd's device
  registration, login databases;
- sets root's password to `*`, removes the build user and its sudo grants, and
  deletes the shadow-utils backups that still list it;
- fails if the build VM's address or gateway appears anywhere under `/etc`,
  `/var/lib` or `/root`;
- stops journald and deletes the journal (truncating a file journald holds
  open ships a corrupt journal, and deleting one it holds keeps its blocks),
  clears logs, `/tmp` and `/var/tmp`, checks dpkg or rpm has nothing half
  done, and trims free space.

It then syncs, remounts every filesystem read-only through SysRq and powers off
from the kernel. A normal shutdown writes after the cleanup has run: systemd
saves a new random seed marked creditable, wtmp records the shutdown, rsyslog,
auditd and chrony write their state. The SysRq power-off leaves nothing for them
to write to. The script remounts read-only, exits 0, and leaves the power-off
to a detached process three seconds later, so Packer gets a real exit status;
the recipes deliberately do not set `expect_disconnect`, which would let a
connection lost halfway through pass as success. Proxmox's shutdown of an
already-stopped VM succeeds, so Packer's own stop races it harmlessly.

**Run a full build after recipe changes.** HCL syntax alone cannot validate an
ISO's image names, boot sequence, driver directories, or unattended installer
schema.

## Ubuntu autoinstall

Copy the matching `user-data` and empty `meta-data` under `recipes/<recipe>/http/`.
Update release-specific package or boot arguments only when that installer
requires it. The Ubuntu family shares one byte-identical `user-data`, enforced by
`tests/recipe-consistency.test.ts`.

**The build's SSH key goes in via `late-command`, not the autoinstall `ssh:`
section.** Subiquity's `ssh.authorized-keys` registers the key as an _instance_
public key, and cloud-init then also plants it in `/root/.ssh/authorized_keys` as
a neutered `disable_root` forced-command stub — the build key leaking into the
shipped template, which `no-foreign-authorized-keys` flags on every Ubuntu leg.
Per-user keys never propagate to root, so the recipe declares `packer` via
`identity:` (locked password; it authenticates by key and is deleted before
export) and writes the key plus a `NOPASSWD` sudoers file in late-commands,
mirroring the Debian preseed and the kickstart flows. With `ssh:` gone,
`openssh-server` is listed under `packages:` (installing it enables `ssh.service`
via the systemd preset) and the `sshd_config.d/10-cofoundry.conf` late-command
carries `PasswordAuthentication`.

**The `identity` user does not exist in the target when `late-commands` run.**
Subiquity defers its creation to cloud-init's _first boot_ of the installed
system, so at `curtin in-target` time there is no `packer` user or group.
`install -d -o packer -g packer …` fails with `install: invalid user 'packer'`,
and a failed late-command **aborts the entire autoinstall** — the installer drops
to its error shell with sshd still up, so Packer sees port 22 open, can never
authenticate, and times out after 30 minutes. The recipe therefore creates the
group and user in-target first (`groupadd`/`useradd`, guarded so they no-op where
a Subiquity version already made them); cloud-init reconciles the pre-existing
user idempotently on first boot.

**Keep `boot_key_interval = "100ms"`.** Proxmox types the boot command through
the QEMU `sendkey` API, and with no interval the guest keyboard buffer
intermittently drops characters. Observed corrupting the initramfs `ip=` netmask
(`…255.255.255.0` arriving as `…255.25.250`), which the installer could not parse
— networking never came up, the user-data was never fetched, and the build failed
with a 30-minute SSH timeout. Diagnosed from a framebuffer screenshot captured by
the diagnostics recorder (see [diagnostics.md](diagnostics.md)).

**Subiquity turns cloud-init off after the installed system's first boot.** It
writes `/etc/cloud/cloud-init.disabled` and leaves `/etc/cloud/clean.d/99-installer`
for `cloud-init clean` to remove that and its other installer configs, one of
which stops cloud-init's `grub_dpkg` from pointing grub-pc at each clone's boot
disk. `finalize.sh` runs that script before its cloud-init checks, which fail the
build if `cloud-init.disabled` survives.

The autoinstall sets `kernel: package: linux-virtual`, the kernel the official
cloud images run: the generic kernel without `linux-modules-extra` and the
~700 MB of firmware `linux-generic` pulls in. 26.04's installer layer ships
`linux-generic` regardless, so `finalize.sh` purges the generic metapackages and
the `linux-firmware*` packages wherever `linux-virtual` is installed; the kernel
recommends the firmware, so autoremove alone keeps it. `apt: geoip: false` keeps the
image on `archive.ubuntu.com` instead of a country mirror picked from wherever
the build node is.

Both failures above surface as the same 30-minute SSH timeout. Tell them apart
from the serial console: an aborted install shows `An error occurred. Press enter
to start a shell`.

### Ubuntu grubenv race

<a id="ubuntu-grubenv-race"></a>

Ubuntu 26.04 renamed `grub-common.service` to `grub2-common.service`, but
`grub-initrd-fallback.service` still ships `After=grub-common.service`. systemd
treats an `After=` naming a nonexistent unit as no ordering constraint at all —
silently — so both units start at `boot-complete.target` in the same second and
both rewrite `/boot/grub/grubenv` with `grub-editenv`. That writes through
`fopen(path, "wb")`, truncating before writing 1024 bytes, so a concurrent reader
landing in the window gets a short block and exits 1 with `invalid environment
block`. `grub2-common.service` then fails, `systemctl is-system-running` reports
`degraded`, and the `systemd-healthy` check fails the leg.

Measured on the shipped 26.04 image: **25 of 200** concurrent `grub-editenv`
pairs failed, against **0 of 400** sequential runs. That per-boot probability is
why it looked intermittent — one run passed `systemd-healthy-first-boot` and then
failed `systemd-healthy` after the reboot.

The recipe restores the ordering with a drop-in at
`/etc/systemd/system/grub-initrd-fallback.service.d/10-cofoundry-grubenv-race.conf`:

```
[Unit]
After=grub-common.service
After=grub2-common.service
```

Both spellings are listed because the family shares one `user-data`. On a release
still using the old name the `grub2-` line is inert, and on 26.04 the `grub-` line
is — the same "After= a unit that isn't there is a no-op" behaviour that caused
the bug, relied on deliberately here. It also means the fix already covers 22.04
and 24.04 when they inherit the rename.

Verified live: with the drop-in, `grub2-common.service` **Finished** before
`grub-initrd-fallback.service` **Starting** on every boot across 20+ reboots, with
no `degraded` state. This is an upstream Ubuntu packaging bug, not a Cofoundry
defect — but it ships in every template built from that image, so the template is
where it is fixed.

## Debian preseed

Copy a nearby `preseed.cfg`. **The committed file must contain
`__PACKER_SSH_PUBLIC_KEY__`, never a real key.** `scripts/inject-placeholders.sh`
generates a fresh ephemeral Ed25519 key per build and replaces either the
placeholder or a previously injected `packer-<recipe>-*` key, so reruns stay safe
without `git clean`. The hostname line uses `__PACKER_RECIPE_NAME__`, replaced by
the same script, so the preseed files stay identical across Debian releases
(enforced by `tests/recipe-consistency.test.ts`). That line has no effect: the
installer fetches the preseed over the network, so it reads the file only after
`netcfg` has already configured the network and picked a hostname, the
installer default `debian`. `finalize.sh` resets it to `localhost` in every
image; clones take theirs from cloud-init.

The network answers are typed on `boot_command` (`netcfg/` keys) for the same
reason, so the installer configures the build NIC with ifupdown and a static
address.

**The image does not keep ifupdown.** The official Debian cloud images use
netplan, systemd-networkd and systemd-resolved, and the images here do too. With
ifupdown, cloud-init's eni renderer writes a clone's nameservers as
`dns-nameservers` lines, which only `resolvconf` acts on, so a clone with a static
address kept whatever `/etc/resolv.conf` the installer wrote: the build's DNS
server. The update provisioner installs `netplan.io` and `systemd-resolved` as its
last step (resolved takes over `/etc/resolv.conf`, and nothing after it may need
DNS), and `finalize.sh` purges ifupdown, deletes `/etc/network/interfaces`, and
enables networkd and resolved. cloud-init then can only render netplan.
Debian's resolved answers LLMNR on `0.0.0.0:5355` by default, handing the
hostname to anyone who can reach the VM; a `resolved.conf.d` drop-in turns LLMNR
and mDNS off, as Ubuntu ships them, and `cf verify` fails a clone listening there.

The install runs with `base-installer/install-recommends false`, which leaves
`00InstallRecommends` behind to turn Recommends off for every later `apt install`;
`finalize.sh` deletes it. That is also why the preseed names `apparmor`, which the
kernel only recommends. `pkgsel/update-policy` installs unattended-upgrades, as
on the official images. The disk is GPT with a 1 MiB BIOS boot partition, so
growpart is not capped at 2 TiB.

An answer that only one release needs goes on that recipe's `boot_command`
instead, where the installer reads it as a preseed value, but only for a key
`preseed.cfg` does not set. The installer loads the file after applying boot
parameters, so the file wins any key both name. `debian-11` passes
`apt-setup/services-select=updates` there: the bullseye-security index still
lists packages whose binaries security.debian.org no longer serves, so
selecting the security suite fails the package step.

The package mirror is a key the preseed does set, so it is a placeholder
instead: `__PACKER_DEBIAN_MIRROR__`, filled by `scripts/inject-placeholders.sh`
from the recipe's `# mirror:` header and defaulting to `deb.debian.org`. A
release Debian has archived sets `# mirror: archive.debian.org`, which keeps
serving it after `deb.debian.org` drops it.

## AlmaLinux and Rocky Linux kickstart

Copy the nearest `ks.cfg` and update repository and release details. These builds
also use the allocated NAT address and ephemeral SSH credentials.

**A kickstart the installer rejects looks like a 35-minute SSH timeout.**
anaconda stops at the parse error on its console and waits. el8's parser, for
one, accepts only `%packages --excludeWeakdeps --instLangs=` and rejects the
`--exclude-weakdeps --inst-langs=` spelling that el9 and el10 take.
`tests/recipe-consistency.test.ts` runs pykickstart's `ksvalidator` against each
file's `#version=RHELn` when it is installed (CI installs it), so run
`pipx install pykickstart` before changing a kickstart.

The kickstarts follow the official GenericCloud ones: SELinux enforcing, no
firewalld, `--exclude-weakdeps`, no firmware packages (el8 keeps
`linux-firmware`, which its kernel requires), `dracut-config-generic`
instead of a host-only initramfs, no rescue kernel, and a GPT disk with a BIOS
boot partition. Root's password is `*`. On el8 `sshd_config` has no `Include`,
so the kickstart writes no drop-in there; the stock file already permits root
and password login, and `finalize.sh` checks the effective values.

RHEL ships `qemu-guest-agent` with the `guest-exec` RPC denied — Debian and
Ubuntu permit it — which fails the smoke test's reboot-and-verify step with
`Command guest-exec has been disabled`. `finalize.sh` runs
`_shared/linux/enable-guest-exec.sh` to permit it. The deny mechanism differs by
release (el8 uses a `BLACKLIST_RPC` block list, el9+ a
`FILTER_RPC_ARGS="--allow-rpcs=..."` allow list) and the script handles both. It
must run **after** `dnf update`, because a guest-agent package refresh can rewrite
`/etc/sysconfig/qemu-ga` back to the shipped defaults.

**Enforcing SELinux confines guest-exec, so the agent's domain is permissive.**
Commands the agent starts run in `virt_qemu_ga_t`, where policy denies even
`systemctl is-system-running` and `journalctl` is "command not found". That
breaks Proxmox's guest-exec and the smoke test. `finalize.sh` loads
`cofoundry-qemu-ga.cil`, which makes that one domain permissive; the rest of the
system enforces. Verified on an AlmaLinux 9 clone: guest-exec, `qm guest passwd`
and a reboot work, and the only denials are the agent domain's. The hypervisor
that can call those RPCs already owns the disk, so this gives nothing away.

## Windows Server

Read [`windows.md`](windows.md) before making any Windows change. In particular:

- look up the current Proxmox `ostype` enum instead of guessing a release-named
  value;
- copy `autounattend.xml` and update the image name plus all VirtIO driver
  directories;
- preserve the shared scripts under `recipes/_shared/windows/`;
- keep 2025-only requirements — TPM, CPU, CompactOS — scoped to the versions that
  need them;
- record every debugging experiment in [`windows-log.md`](windows-log.md).

Microsoft evaluation links sometimes resolve to a registration page instead of an
ISO. If validation reports an HTML download, get the current direct link from the
Microsoft Evaluation Center and update the recipe metadata and cached ISO
filename together.
