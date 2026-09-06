# Changelog

All notable changes to the `coport` installer are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [Unreleased]

## [2.1.0] - 2026-09-06

### Added

- **Preflight checks before the first download.** Every failure listed below
  used to surface only from `qm create` — after multi-gigabyte transfers had
  already finished, and on a multi-template run once per template while the
  rest kept downloading. They are now checked against the finished plan before
  anything is fetched, and a storage passed with `--storage` or set in the
  config file is checked before the template menu even opens. `--dry-run` runs
  the same checks; `--no-preflight` skips them.
- **Storage content type.** The default `local` on a stock node carries
  `iso,vztmpl,backup`, so picking it failed with
  `storage 'local' does not support vm images`, one `400 Parameter
verification failed` per template. coport reads `pvesm status` and refuses a
  plan whose target storage is missing, cannot
  hold VM images, or is offline, naming the storages on the node that would
  have worked.
- **Storage capacity, per backend.** A Windows template is a 7.5 GB download
  that declares a 30 GiB disk, and artifacts ship as compressed qcow2 — a
  622 MB Debian image imports to 1.8 GB — so neither number alone predicts the
  cost. Plain LVM reserves the full virtual size at creation and is refused
  below it; every other backend is refused below the download floor, or warned
  when it clears the floor but not the ceiling. Compressing backends only ever
  warn. The cloud-init and TPM state volumes are counted.
- **`--overwrite` targets.** `installTemplate` runs `qm destroy` best-effort
  and ignores its exit code, so a destroy Proxmox refuses was silent and the
  run died later at `qm create` with `VM N already exists`. coport now refuses
  up front when the occupant is running, locked, an LXC container, or owned by
  another node.
- **Artifact availability.** Every distinct disk URL is HEADed before any is
  fetched, so a registry pointing at an unpublished image fails immediately
  rather than between gigabytes of successful transfers. A `Content-Length`
  that disagrees with the registry warns.
- **Temp space and writability** of `/var/lib/vz/dump/coport-tmp`, measured
  against the run's peak resident images rather than the whole batch.
- **Node tooling** — `qm` on PATH, and running as root. Skipped for
  `--dry-run`, which executes nothing.
- **Bridge existence**, as a warning: Proxmox validates a NIC's bridge when a
  VM starts, not when it is created, so a wrong `--bridge` installs cleanly and
  bites whoever clones the template.
- **Every probe fails open.** If `pvesm`, `/etc/pve`, `/sys/class/net`, or a
  HEAD cannot answer, the checks it feeds are skipped with a warning rather
  than blocking an install. A probe that does not run is not evidence of a
  problem; only one that answers "this will not work" stops a run.
- **The interactive storage prompt is now a picker.** It lists the node's
  storages that actually accept VM images, with their type and free space, so
  the wrong volume is not offerable in the first place. "Other…" still accepts
  a typed name, which goes through the same preflight.

## [2.0.2] - 2026-09-05

### Fixed

- **Install Windows templates on a node older than the one that built them.**
  Every Windows template publishes `ms-cert=2023k` on its EFI varstore, a key
  Proxmox added in PVE 9.1. On PVE 9.0 `qm create` rejects the entire
  invocation over it — `400 Parameter verification failed. efidisk0: ms-cert:
property is not defined in schema` — so the install failed after the download
  and import had already run. coport now asks the node what its `qm create`
  accepts and omits the options it does not document, reporting each omission
  on the template's row. Nothing is lost by the omission: `import-from` writes
  the varstore byte for byte, so the enrolled Secure Boot keys and the
  Microsoft CA arrive either way. The probe fails open — if it cannot run, the
  create is built exactly as the registry describes it.

## [2.0.1] - 2026-09-05

### Fixed

- **Run coport over SSH again.** Registry resolution treated _any_ non-TTY
  stdin as a piped registry, without checking that anything had been piped. So
  `ssh node coport --all`, cron, systemd units, CI steps, and any invocation
  with `< /dev/null` read an empty fd 0 and died with
  `Registry is not valid JSON: Unexpected EOF` — never reaching the config file
  or the built-in default that the run was relying on. stdin is now drained
  once during resolution and used only when it actually carries a document; an
  empty read falls through to the next source. An explicit `-` argument still
  forces stdin, and piping a registry still works.
- **Keep the installs a run has already finished.** `~/.coport/cache.json` was
  written once, after every install settled, so an interrupt partway through a
  multi-template run — Ctrl-C, a crash, a reboot — lost the record of every
  template it had successfully installed. Those templates exist on the node,
  but `--list` and `--upgrade` no longer knew about them and their VMIDs
  stopped being sticky, so the next run reassigned around the very VMIDs its
  own templates occupied. Each successful install is now flushed as it lands.
  Writes are serialised against each other and staged through a temp file that
  is renamed over the cache, since a file written this often can be killed
  mid-write.

## [2.0.0] - 2026-09-04

Cofoundry now publishes importable disk images instead of vzdump archives, and
coport installs them with `qm create --import-from` instead of `qmrestore`. A
`.vma.zst` can only be restored into a VMID, so every node that wanted a
template had to download its own copy and reserve that VMID; an image is just a
file, and the VM is rebuilt around it from the hardware profile the build
recorded. See `docs/disk-images.md`.

**This release is not compatible in either direction.** coport 2.0 rejects a
schema-1 registry and coport 1.x rejects a schema-2 one, so the installer and
the registry have to move together. Templates already installed by 1.x keep
working — they are ordinary Proxmox templates — but see the cache note below.

### Changed

- **Require Proxmox VE 9.** `qm create --import-from` is what makes an image
  installable without an archive; there is no fallback path on PVE 8.
- **Require registry `schema_version: "2"`.** A template is now `disks[]` plus a
  `hardware{}` profile and a `minimum{}` floor, rather than one `url`/`sha256`/
  `size` triple.
- **Install by importing, not restoring.** coport downloads each of a template's
  images, imports them into a freshly created VM built from the recorded
  hardware profile, and marks the result a template. Images are passed to
  `--import-from` by absolute path, so no `import`-content storage has to be
  configured on the node.
- **A template can be several files.** OVMF recipes ship an EFI varstore
  (`.efivars.raw`) alongside the system disk, because the built varstore holds
  the boot entry Windows Setup wrote, the enrolled Secure Boot keys, and any dbx
  revocations from the update rounds — none of which a freshly allocated
  varstore has. Every image is SHA-256 verified before anything is created, and
  the progress row reports against the template's total size.
- **`--overwrite` destroys the occupant first.** `qm create --force` only
  applies to `archive` restores, so overwriting is now an explicit
  `qm destroy --purge --destroy-unreferenced-disks` before the create. This
  removes the VMID from backup and HA configuration as well, which
  `qmrestore -force 1` did not.
- Rename the install phase from "restore" to "import" throughout the TUI.
  `--restore-concurrency` and `COPORT_RESTORE_CONCURRENCY` keep their names and
  now bound parallel imports.
- Name temporary downloads by the artifact's content-addressed filename instead
  of a synthetic `vzdump-qemu-<vmid>-…` name. The old name existed only so
  `qmrestore` could read archive metadata off it, and it collided when two
  templates were in flight for the same VMID.

### Added

- Rebuild the VM from the sidecar's `hardware{}` profile — `ostype`, `bios`,
  `machine`, `scsihw`, `cpu`, `agent`, and anything else the build recorded. The
  profile is captured by denylist over `qm config`, so it cannot drift from what
  was actually built, and fields Proxmox adds in future releases flow through
  rather than being dropped.
- Size the VM from `minimum{}` (falling back to 2 cores / 2048 MB), which is
  hand-authored per recipe rather than captured — the build's 4 cores / 8 GB is
  servicing headroom, not a requirement. There is deliberately no disk floor:
  an imported disk inherits the source's virtual size and `qm disk resize`
  cannot shrink.
- Add `--bridge <name>` (env `COPORT_BRIDGE`, default `vmbr0`). The profile
  records only the NIC model; the bridge and MAC address are the consumer's.
- Allocate the TPM fresh on OVMF recipes instead of shipping one. The image is
  generalized so nothing is sealed to it, and a shipped varstore would give
  every installed VM the same endorsement key.
- Attach the cloud-init drive at `ide2` on every recipe. Windows builds strand
  it on `ide3` because `ide0`-`ide2` hold the boot, virtio, and answer-file
  ISOs; Cloudbase-Init finds the drive by label, not slot.

### Fixed

- Delete a template's downloaded images as soon as it fails, not when the whole
  run ends. A failed multi-gigabyte download previously sat in the temp
  directory until every remaining template had finished, which is exactly when
  the space was needed.
- Treat the **system** disk's hash as a template's identity for `--upgrade` and
  `--list`. Note that this reinstalls everything once: records written by 1.x
  store the `.vma.zst` hash, which no longer matches anything.

## [1.3.0] - 2026-07-20

### Added

- Replace the type-the-numbers template picker with an inline `@clack/prompts`
  grouped multiselect: arrow-key navigation, space to toggle, group headers that
  toggle a whole OS family, and `a` to select all.
- Add a VMID review step before install. When a suggested VMID is taken you can now
  **Proceed**, **Edit** the VMID inline (validated as free), or **Skip** the
  template — instead of a silent auto-reassign behind a `[Y/n]`.
- Add a local version cache at `~/.coport/cache.json` recording each installed
  template's VMID, storage, and version (sha256/built_at). `-l, --list` prints it;
  `--upgrade` re-pulls only templates whose registry version changed, reusing the
  cached VMID so you never re-enter it.
- Add `-a, --all` to install every template (respecting `--group`/`--filter`) with
  suggested/cached VMIDs and no prompts, and `--select <spec>` for explicit
  non-interactive selection (`all`, `1,3-5`, template names, or group ids — a
  group id expands to its whole family).
- Accept the registry inline or piped: `coport '{…}'` takes a JSON document
  directly, and `coport -` (or any non-TTY stdin) reads it from stdin
  (`cat registry.json | coport -a -`). Interactive prompts reopen `/dev/tty` so the
  TUI still works when stdin carries the registry.
- Read consumer defaults from `~/.config/coport/config.toml`, including
  `${VAR}` interpolation, while retaining `~/.coport/config.json` support for
  existing installations.
- Add `coport --config` to show the resolved registry, storage, source, and
  config file without starting an installation.

### Fixed

- Detect VMID collisions cluster-wide. `/etc/pve/qemu-server` and `/etc/pve/lxc`
  are symlinks to the local node, so a VMID already in use by a guest on another
  node looked free and the install only failed at `qmrestore` — after
  downloading the multi-GB artifact. The cluster-wide `/etc/pve/.vmlist` is now
  the primary source, falling back to scanning
  `/etc/pve/nodes/*/{qemu-server,lxc}/*.conf` when it is missing or malformed.
- Abort instead of assigning a VMID when cluster state is unreadable. If
  `/etc/pve` itself could not be read (e.g. pmxcfs unmounted during a
  `pve-cluster` restart), both the `.vmlist` read and the directory scan came
  back empty and coport treated that as an empty cluster. A parseable `.vmlist`
  stays authoritative, but an empty scan is now only trusted when at least one
  guest-config directory is readable.
- Continue using the storage default from the config file when the registry is
  supplied as a command-line argument, environment variable, or stdin stream.
- Report malformed config and unresolved `${VAR}` references explicitly instead
  of silently treating them as empty settings.
- Build the `coport-linux-x64` release binary with Bun's `bun-linux-x64-baseline`
  target so it runs on pre-Haswell CPUs without AVX2 (e.g. Ivy Bridge Xeon E5 v2).
  Previously the default target emitted AVX2 instructions and crashed immediately
  with `Illegal instruction` on those nodes. coport is I/O-bound, so the baseline
  ISA has no measurable cost.

## [1.2.0] - 2026-06-04

### Added

- Adopt the shared `@cofoundry/ui` renderer used by `cf build` so multi-template installs show a live spinner-driven row per template with phase, elapsed time, and download/restore progress.
- Bound parallelism with `--download-concurrency` (default 4, env `COPORT_DOWNLOAD_CONCURRENCY`) and `--restore-concurrency` (default 2, env `COPORT_RESTORE_CONCURRENCY`) so a `coport <all>` run no longer launches 16 simultaneous fetches and 16 simultaneous `qmrestore` processes against a single node. Waiting templates show `queued → download` / `queued → restore` with their elapsed timer paused.
- Add `--verbose` to force the line-oriented stream output (for CI or copy-paste) over the in-place TUI.

### Fixed

- Delete each downloaded `.vma.zst` as soon as its restore completes instead of holding the whole batch on disk until the end. Peak temp usage now scales with in-flight concurrency, not total template count — `coport <all>` peaked at ~38 GB before and stayed under 20 GB after, preventing mid-run exits when disk space was tight.
- Sweep orphaned `${pid}-${ts}` subdirectories under `/var/lib/vz/dump/coport-tmp/` on startup so crashed runs no longer leak gigabytes of temp archives.
- Bring back the per-template progress bar and align the name / phase / VMID columns to a fixed width so 16 parallel rows scan cleanly instead of jittering between widths.
- Throttle per-chunk progress callbacks to ~120 ms and slow the renderer redraw tick to match, cutting the periodic event-loop stalls users saw when many large downloads were active at once.

## [1.1.0] - 2026-06-03

### Added

- Add a `log-update` based multi-template progress view for concurrent downloads and restores.
- Show elapsed time, downloaded size, total size, and transfer speed in the install progress view.
- Bake registry recipe names such as `ubuntu-22.04` into template archives instead of keeping archived `packer-*` names.

### Fixed

- Keep parallel progress output readable when installing multiple templates at once.
- Re-prompt after empty or invalid template selections instead of exiting immediately.
- Preserve piped answers across repeated prompts for scripted usage.
- Close prompt handles after completion so `coport` exits cleanly.
- Handle Ctrl-C by aborting active downloads, terminating active `qmrestore` processes, and removing temporary archives.
- Store downloads in a per-run directory under `/var/lib/vz/dump/coport-tmp` and remove it after completion to avoid accumulated large archives.

## [1.0.0] - 2026-06-02

Initial coport release.

### Added

- Add `coport`, a Proxmox-side installer for Cofoundry VM templates.
- Add template selection from the Cofoundry registry.
- Add SHA-256 verification before restore.
- Add Linux x64 and arm64 release binaries.
- Add `--overwrite` to restore into an existing suggested VMID with `qmrestore -force 1`.

### Fixed

- Use `https://cofoundry.cdn.convoypanel.com/registry.json` as the default registry.
- Use Proxmox-compatible `vzdump-qemu-...vma.zst` temporary filenames so `qmrestore` can detect archive metadata.
- Reduce progress log spam in non-TTY sessions.
- Clarify VMID reassignment prompts so free fallback VMIDs are not presented as conflicts.

[unreleased]: https://github.com/ConvoyPanel/cofoundry/compare/v2.1.0...HEAD
[2.1.0]: https://github.com/ConvoyPanel/cofoundry/compare/v2.0.2...v2.1.0
[2.0.2]: https://github.com/ConvoyPanel/cofoundry/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/ConvoyPanel/cofoundry/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/ConvoyPanel/cofoundry/compare/v1.3.0...v2.0.0
[1.3.0]: https://github.com/ConvoyPanel/cofoundry/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/ConvoyPanel/cofoundry/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/ConvoyPanel/cofoundry/releases/tag/v1.1.0
[1.0.0]: https://github.com/ConvoyPanel/cofoundry/releases/tag/v1.0.0
