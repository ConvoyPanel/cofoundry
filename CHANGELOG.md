# Changelog

## v1.3.0

### Added

- Replace the type-the-numbers template picker with an inline `@clack/prompts`
  grouped multiselect: arrow-key navigation, space to toggle, group headers that
  toggle a whole OS family, and `a` to select all.
- Add a VMID review step before install. When a suggested VMID is taken you can now
  **Proceed**, **Edit** the VMID inline (validated as free), or **Skip** the
  template — instead of a silent auto-reassign behind a `[Y/n]`.
- Add a local version cache at `~/.coport/cache.json` recording each installed
  template's VMID, storage, and version (sha256/built_at). `-v, --versions` prints
  it; `-u, --update` reinstalls only templates whose registry version changed,
  reusing the cached VMID so you never re-enter it.
- Add `-a, --all` to install every template (respecting `--group`/`--filter`) with
  suggested/cached VMIDs and no prompts, and `--select <spec>` for explicit
  non-interactive selection (`all`, `1,3-5`, or template names).
- Accept the registry inline or piped: `coport '{…}'` takes a JSON document
  directly, and `coport -` (or any non-TTY stdin) reads it from stdin
  (`cat registry.json | coport -a -`). Interactive prompts reopen `/dev/tty` so the
  TUI still works when stdin carries the registry.

### Fixed

- Build the `coport-linux-x64` release binary with Bun's `bun-linux-x64-baseline`
  target so it runs on pre-Haswell CPUs without AVX2 (e.g. Ivy Bridge Xeon E5 v2).
  Previously the default target emitted AVX2 instructions and crashed immediately
  with `Illegal instruction` on those nodes. coport is I/O-bound, so the baseline
  ISA has no measurable cost.

## v1.2.0

### Added

- Adopt the shared `@cofoundry/ui` renderer used by `cf build` so multi-template installs show a live spinner-driven row per template with phase, elapsed time, and download/restore progress.
- Bound parallelism with `--download-concurrency` (default 4, env `COPORT_DOWNLOAD_CONCURRENCY`) and `--restore-concurrency` (default 2, env `COPORT_RESTORE_CONCURRENCY`) so a `coport <all>` run no longer launches 16 simultaneous fetches and 16 simultaneous `qmrestore` processes against a single node. Waiting templates show `queued → download` / `queued → restore` with their elapsed timer paused.
- Add `--verbose` to force the line-oriented stream output (for CI or copy-paste) over the in-place TUI.

### Fixed

- Delete each downloaded `.vma.zst` as soon as its restore completes instead of holding the whole batch on disk until the end. Peak temp usage now scales with in-flight concurrency, not total template count — `coport <all>` peaked at ~38 GB before and stayed under 20 GB after, preventing mid-run exits when disk space was tight.
- Sweep orphaned `${pid}-${ts}` subdirectories under `/var/lib/vz/dump/coport-tmp/` on startup so crashed runs no longer leak gigabytes of temp archives.
- Bring back the per-template progress bar and align the name / phase / VMID columns to a fixed width so 16 parallel rows scan cleanly instead of jittering between widths.
- Throttle per-chunk progress callbacks to ~120 ms and slow the renderer redraw tick to match, cutting the periodic event-loop stalls users saw when many large downloads were active at once.

## v1.1.0

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

## v1.0.0

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
