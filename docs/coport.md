# Coport

`coport` is the consumer-side installer: a standalone CLI that runs **on a
Proxmox node** and turns published Cofoundry artifacts into clonable VM
templates. It reads a `registry.json` (the file `cf publish` writes), lets you
pick templates, downloads each template's disk images from their `url`s,
verifies their SHA-256, rebuilds a VM around them with `qm create
--import-from`, and marks it a template with `qm template`.

A template is one or more images plus a hardware profile rather than a single
archive — see [Disk images](disk-images.md). Because `import-from` accepts an
absolute path, images stay in coport's temp directory and the node needs no
`import`-content storage configured. The TPM state volume and the cloud-init
drive are allocated fresh rather than downloaded: the images are generalized,
so nothing is sealed to the TPM, and a shared varstore would give every VM the
same endorsement key.

It lives in `coport/` as a Bun workspace and is versioned and released
independently of `cf` — the repository's `CHANGELOG.md` tracks coport
releases. It must run on the node itself: it invokes `qm` and checks
`/etc/pve/qemu-server/` and `/etc/pve/lxc/` for VMID conflicts directly.

## Install

Each `vX.Y.Z` tag publishes a
[GitHub release](https://github.com/ConvoyPanel/cofoundry/releases) with two
static Linux binaries and a `coport.sha256` checksum file:

- `coport-linux-x64` — compiled against the baseline x86-64 ISA (no AVX2) so
  it also runs on older Xeon-era Proxmox nodes instead of crashing with
  `Illegal instruction`
- `coport-linux-arm64`

```sh
# on the Proxmox node:
wget https://github.com/ConvoyPanel/cofoundry/releases/latest/download/coport-linux-x64
install -m 755 coport-linux-x64 /usr/local/bin/coport
```

From a repo checkout instead: `bun run --cwd coport dev` runs it directly, and
`bun run build:coport` at the repo root compiles `dist/coport`.

## Run

```sh
coport                                            # interactive, default registry
coport https://templates.example.com/registry.json
coport ./registry.json                            # local file
coport '{"schema_version":"2", …}'                # inline JSON document
curl -s https://…/registry.json | coport --all --storage local-zfs
```

The interactive flow is a grouped multiselect (space toggles a template, a
group header toggles the whole OS family, `a` selects everything), followed by
a VMID review step — per template you can proceed, edit the VMID inline
(validated as free), or skip it — and a storage prompt unless a storage is
configured or passed with `--storage`. Downloads and imports run in parallel
with a live progress display, and a template's images are deleted as soon as
its import finishes, so peak temp usage scales with concurrency, not with the
number of templates.

## Registry sources

The registry argument may be a URL, a file path, an inline JSON document, or
`-` for stdin. When the argument is omitted, resolution order is:

1. the `COPORT_REGISTRY` environment variable (same forms as the argument);
2. piped stdin — any non-TTY stdin is read as the registry document;
3. `registry` from the config file;
4. the built-in default,
   `https://cofoundry.cdn.convoypanel.com/registry.json`.

A piped registry occupies stdin, so it cannot be combined with the interactive
menu; coport exits with guidance instead of hanging on a dead keyboard. Pass
the registry as an argument to stay interactive
(`coport "$(curl -s https://…/registry.json)"`), or add `--all` / `--select`
to stay piped.

## Options

| Option                       | Description                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------- |
| `-s, --storage <name>`       | Proxmox storage volume (skips the prompt)                                              |
| `-g, --group <id>`           | Only show/install templates from this group                                            |
| `-f, --filter <tag>`         | Only show/install templates with this tag                                              |
| `-a, --all`                  | Install every template with suggested/cached VMIDs, no prompts                         |
| `--select <spec>`            | Non-interactive selection: `all`, index ranges (`1,3-5`), template names, or group ids |
| `--upgrade`                  | Reinstall installed templates whose registry version changed (reuses their VMIDs)      |
| `-l, --list`                 | List installed templates (name, VMID, storage, version) and exit                       |
| `--vmid-start <n>`           | Auto-VMID range start for conflicts (default `9000`)                                   |
| `--dry-run`                  | Show what would be installed; skip downloads                                           |
| `--overwrite`                | Overwrite existing VMs when a suggested VMID is already taken                          |
| `--no-verify`                | Skip SHA-256 verification after download                                               |
| `--download-concurrency <n>` | Parallel downloads (default `4`; env `COPORT_DOWNLOAD_CONCURRENCY`)                    |
| `--restore-concurrency <n>`  | Parallel verifies + imports (default `2`; env `COPORT_RESTORE_CONCURRENCY`)            |
| `--bridge <name>`            | Bridge for installed templates (default `vmbr0`; env `COPORT_BRIDGE`)                  |
| `--verbose`                  | Stream per-event logs instead of the in-place TUI                                      |
| `--config`                   | Print the resolved config (registry, storage, source file) and exit                    |

`--select` group ids match either the registry group's `id` or its
`display_name`, and a group token expands to every template in that family.
Duplicate selections are installed once.

## VMIDs

Each template prefers a VMID: the one it was installed at last time (from the
cache) or, failing that, the registry's `suggested_vmid`. If that VMID is
taken — an existing config in `/etc/pve/qemu-server/` or `/etc/pve/lxc/` —
coport assigns the next free VMID counting up from `--vmid-start`, or destroys
and replaces the occupant when `--overwrite` is given (`qm create --force`
applies only to archive restores, so an overwrite cannot be a flag on create). Interactive runs surface every
assignment in the review step before anything is installed; non-interactive
runs log a warning for each reassignment.

## Upgrades and the install cache

Successful installs are recorded in `~/.coport/cache.json`: template name,
display label, VMID, storage, version identity (`sha256` + `built_at`), and
install time. The cache powers:

- `coport --list` — print what is installed, where, and when;
- `coport --upgrade` — reinstall only the templates whose registry `sha256`
  or `built_at` changed, into their cached VMID and storage, overwriting in
  place. The recorded `sha256` is the **system disk's**: a template is several
  images, but the varstore is tiny and derived, so the system disk changing is
  what makes an install stale;
- VMID stickiness — later installs prefer the cached VMID over the registry's
  suggestion.

## Configuration

Consumer defaults live in `~/.config/coport/config.toml` (the legacy
`~/.coport/config.json` is still read as a fallback):

```toml
registry = "https://templates.example.com/registry.json"
storage  = "local-zfs"
```

Both values support `${VAR}` interpolation from the environment; an unresolved
variable is an error rather than an empty string. `coport --config` prints the
resolved registry, storage, and which file they came from without starting an
installation.

## Temporary files

Downloads land in a per-run directory `/var/lib/vz/dump/coport-tmp/<pid>-<ts>`,
named by each artifact's content-addressed filename so concurrent installs
cannot collide. A template's images are removed as soon as its import finishes
— and also when a download or import fails partway, since these are
multi-gigabyte files and the run may have templates still to go. The directory
is removed at exit (including Ctrl-C), and orphaned directories left by dead
processes are swept at startup.
