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
3. **Storage** — unless configured or passed with `--storage`.

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
| `--config`                   | Print the resolved config (registry, storage, source file) and exit                    |

`--select` group ids match a group's `id` or `display_name` and expand to the
whole family. Duplicate selections install once.

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
