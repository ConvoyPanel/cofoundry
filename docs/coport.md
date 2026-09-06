# Coport

`coport` installs published Cofoundry artifacts as clonable VM templates. It
reads a `registry.json` (written by `cf publish`), downloads the disk images,
verifies their SHA-256, and rebuilds each VM with `qm create --import-from`.

Run it **on the Proxmox node** — it calls `qm` and reads
`/etc/pve/qemu-server/` and `/etc/pve/lxc/` directly.

## Install

```sh
# on the Proxmox node. -O matters: without it a re-run saves the new binary as
# coport-linux-x64.1 and the install below silently reinstalls the stale one.
wget -O coport-linux-x64 \
    https://github.com/ConvoyPanel/cofoundry/releases/latest/download/coport-linux-x64
install -m 755 coport-linux-x64 /usr/local/bin/coport
```

Every `vX.Y.Z`
[release](https://github.com/ConvoyPanel/cofoundry/releases) ships
`coport-linux-x64`, `coport-linux-arm64`, and `coport.sha256`. The x64 build
targets baseline x86-64 (no AVX2) so it runs on older Xeon-era nodes.

From a checkout: `bun run --cwd coport dev`, or `bun run build:coport` to
compile `dist/coport`.

## Run

**One command. This is the whole thing:**

```sh
coport
```

Interactive, default registry. Everything below is an _alternative_ to that
line, not a next step.

To use a different registry, pass **one** of these:

| Source      | Example                                              |
| ----------- | ---------------------------------------------------- |
| URL         | `coport https://templates.example.com/registry.json` |
| Local file  | `coport ./registry.json`                             |
| Inline JSON | `coport '{"schema_version":"2", …}'`                 |
| stdin       | `curl -s https://…/registry.json \| coport --all`    |

The interactive flow:

1. **Select** — space toggles a template, a group header toggles the OS family,
   `a` selects everything.
2. **Review VMIDs** — proceed, edit inline (validated as free), or skip.
3. **Storage** — unless configured or passed with `--storage`. The list is
   the node's storages that accept VM images, with type and free space;
   "Other…" takes a typed name.

Downloads and imports then run in parallel with a live progress display.

## Registry sources

With no argument, coport uses the first of:

1. `COPORT_REGISTRY`;
2. piped stdin, when it carries a document (an empty non-TTY stdin — what
   `ssh node coport --all`, cron, and `< /dev/null` give — falls through);
3. `registry` from the config file;
4. `https://cofoundry.cdn.convoypanel.com/registry.json`.

A piped registry occupies stdin, so it can't drive the interactive menu —
coport exits with guidance rather than hanging. Either pass the registry as an
argument (`coport "$(curl -s https://…/registry.json)"`) or add `--all` /
`--select`.

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
| `--no-preflight`             | Skip the pre-download checks (storage content types, free space)                       |
| `--config`                   | Print the resolved config (registry, storage, source file) and exit                    |

`--select` group ids match a group's `id` or `display_name` and expand to the
whole family. Duplicate selections install once.

## Preflight

Everything that can be known before a byte is downloaded is checked before one
is. A multi-gigabyte transfer that ends in `qm create` refusing the storage is
the failure this exists to prevent. `--dry-run` runs the same checks; a storage
given with `--storage` or in the config file is checked before the template
menu even opens. `--no-preflight` skips the lot.

### The node

- **`qm` is on PATH** — coport drives it directly, so it has to run on the
  Proxmox node, not a workstation.
- **Running as root** — `qm create` and `qm destroy` need it.

Both are skipped for `--dry-run`, which executes nothing.

### Storage

From `pvesm status`, for every storage the plan targets:

- **it exists on this node** — a name `pvesm status` does not list;
- **it accepts VM images** — the `images` content type. The stock `local` is
  `iso,vztmpl,backup`, so it is the usual offender: `qm create` rejects it with
  `storage 'local' does not support vm images`, and did so only after every
  download had finished;
- **it is active**;
- **it has room** — see below.

Each refusal names the storages on the node that would have worked.

### Capacity

Artifacts are published as **compressed** qcow2 (`qemu-img convert -c`), so the
download size is not what lands on the storage — measured on us-west, a 622 MB
Debian image imports to 1.8 GB. The registry does not publish the expanded
size, so coport works between two bounds it can know:

- **the download total** — a floor, since the import can never write less;
- **the disks' `virtual_size`** — the ceiling, and exactly what a thick
  allocator reserves at create time.

| Backend                               | Must fit              | Below it |
| ------------------------------------- | --------------------- | -------- |
| `lvm`                                 | the full virtual size | error    |
| `zfspool`, `btrfs`                    | the download floor    | warning  |
| everything else (`dir`, `lvmthin`, …) | the download floor    | error    |

Plain LVM reserves every extent at creation, so a Windows template — a 7.5 GB
download declaring a 30 GiB disk — needs 30 GiB free, not 7.5 GB. Compressing
backends may store the data in less than it occupies, so their shortfalls only
warn. A sparse backend that clears the floor but not the ceiling gets a warning
saying so: it will likely fit, and it can still run out. The cloud-init drive
(4 MiB) and TPM state (4 MiB, where the profile asks for one) are counted.

### VMIDs and `--overwrite`

Every VMID is checked against the range `qm create` accepts (100–999999999).
Where `--overwrite` has to destroy an occupant first, that occupant is checked
too — `installTemplate` runs `qm destroy` best-effort and ignores its exit
code, so a destroy Proxmox refuses is silent and the run instead dies at `qm
create` with `VM N already exists` once the image is on disk. Blocked when the
guest is **running**, **locked**, an **LXC container** (`qm destroy` cannot
remove one), or owned by **another node**.

### Temp space

`/var/lib/vz/dump/coport-tmp` must be writable, and is measured exactly —
these are the very bytes about to be written. Not fitting the largest single
image is an error; not fitting the run's peak (the largest few, bounded by
`--download-concurrency` + `--restore-concurrency`) is a warning.

### Artifacts

Every distinct disk URL gets a HEAD before any of them is fetched, so a
registry pointing at a moved or unpublished image fails immediately instead of
one template at a time between gigabytes of successful transfers. A 4xx/5xx
blocks; a refused HEAD (405/501), a transport error, or a `Content-Length` that
disagrees with the registry only warns — caches answer HEAD badly, and SHA-256
verification still guards the bytes.

### Bridge

`--bridge` is checked against `/sys/class/net`. Warning only: Proxmox validates
the bridge when a VM starts, not when it is created, so a wrong one installs
fine and bites whoever clones the template.

### Failing open

Every probe fails open. If `pvesm` cannot be run — not a Proxmox node, or a
stalled storage hitting the 20s cap — the storage checks are skipped with a
warning rather than blocking the install. Same for `/etc/pve` being unreadable,
`/sys/class/net` being absent, or a HEAD that never completes. A probe that
does not run is not evidence of a problem; only a probe that answers "this will
not work" stops a run.

## VMIDs

A template prefers its cached VMID, then the registry's `suggested_vmid`. If
that's taken, coport counts up from `--vmid-start` for a free one — or destroys
and replaces the occupant with `--overwrite`.

Interactive runs show every assignment in the review step before installing;
non-interactive runs log a warning per reassignment.

## Upgrades and the install cache

Installs are recorded in `~/.coport/cache.json` (name, label, VMID, storage,
`sha256` + `built_at`, install time) as each one finishes, so an interrupted
run keeps what it already installed. That gives you:

- `coport --list` — what's installed, where, and when;
- `coport --upgrade` — reinstall only templates whose `sha256` or `built_at`
  changed, in place at their cached VMID and storage;
- sticky VMIDs — the cached VMID wins over the registry's suggestion.

## Configuration

`~/.config/coport/config.toml` (legacy `~/.coport/config.json` still read as a
fallback):

```toml
registry = "https://templates.example.com/registry.json"
storage  = "local-zfs"
```

Both support `${VAR}` interpolation; an unresolved variable is an error, not an
empty string. `coport --config` prints the resolved values and their source.

## How it works

- **A template is images plus a hardware profile**, not one archive — see
  [Disk images](disk-images.md). `import-from` takes an absolute path, so
  images stay in the temp directory and the node needs no `import`-content
  storage.
- **TPM state and cloud-init drives are allocated fresh.** The images are
  generalized, and a shared varstore would give every VM the same endorsement
  key.
- **The cached `sha256` is the system disk's** — the varstore is tiny and
  derived, so only the system disk changing makes an install stale.
- **`--overwrite` destroys and recreates**; `qm create --force` covers archive
  restores only.
- **Temp files** live in `/var/lib/vz/dump/coport-tmp/<pid>-<ts>`, named by
  content hash so concurrent runs can't collide. Images are deleted as soon as
  their import finishes or fails, so peak usage scales with concurrency, not
  template count. The directory is removed at exit (including Ctrl-C), and
  orphans from dead processes are swept at startup.
- **Releases:** `coport/` is a Bun workspace versioned independently of `cf`;
  `CHANGELOG.md` tracks it.
