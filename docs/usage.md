# Usage

## Build a template

```sh
cf build debian-12
cf build windows-server-2025
cf build debian-12 --skip-artifact-sync
cf build debian-12 --skip-upload
```

The first run for a recipe downloads the ISO to the node's cache automatically. Subsequent builds skip the download. Output lands in `./dist/`:

```
dist/debian-12-amd64.qcow2   # system disk, compressed qcow2
dist/debian-12-amd64.json    # sidecar (disks, hardware profile, minimum)
```

OVMF recipes (every `windows-server-*`) emit a third file, the EFI variable
store, which carries the boot entry and enrolled Secure Boot keys that a freshly
allocated varstore would not have:

```
dist/windows-server-2025-amd64.efivars.raw
```

See [Disk images](disk-images.md) for the sidecar schema and how a consumer
turns these back into a VM.

## List available recipes

```sh
cf list
```

## Cloning a template

Cofoundry templates do not contain a baked-in DNS server. When deploying a
clone, set an explicit nameserver that the VM can reach.

This is especially important when the Proxmox node accepts Tailscale MagicDNS.
Tailscale sets the node's resolver to `100.100.100.100`, and Proxmox uses the
node's resolver as the default for a cloud-init VM without its own nameserver.
A clone that is not on the tailnet cannot reach that resolver, so DNS fails.
This affects the deployed clone, not the Cofoundry build or its GitHub Actions
runner.

On Ubuntu, `/etc/resolv.conf` normally points to the systemd-resolved stub at
`127.0.0.53`; use `resolvectl status` to see the actual upstream resolver.

Either give the clone an explicit reachable nameserver, or keep the Proxmox
node from accepting MagicDNS with `tailscale set --accept-dns=false` and set the
node's resolver in **Datacenter → DNS** (for example, `1.1.1.1`).

## Build everything

Omit recipe names to build everything. Builds are stage-pipelined, continue on
failure, and print a pass/fail summary at the end.

```sh
cf build
cf build --skip-artifact-sync
```

Packer builds run one at a time by default. To opt into parallel builds, set a
maximum concurrency and explicit node-wide RAM and CPU budgets. A recipe starts
only when all three limits have capacity:

```sh
cf build --build-concurrency 4 --build-memory-budget 16G --build-cpu-budget 8
```

The persistent equivalents are `build.concurrency`,
`build.memory_budget_mb`, and `build.cpu_budget` in `cofoundry.toml`. Recipe
resource requirements come directly from each `.pkr.hcl` file's `memory` and
`cores` settings.

The local scheduler coordinates recipes within one command, while heartbeating
leases on the Proxmox node enforce the same RAM and CPU budgets across independent
`cf build` and `cf verify` processes. If budgets are omitted, node-wide admission
uses 80% of physical RAM and all host CPUs. Explicit budgets remain preferable
when other workloads share the node, and are clamped to those physical safety
ceilings if configured higher.

`--skip-artifact-sync` overrides the default artifact download for that command invocation (env equivalent: `CF_SKIP_ARTIFACT_SYNC=1`).

`--skip-upload` disables the configured artifact and sidecar uploads for that
build invocation. It does not disable the default artifact download to
`CF_OUT_DIR`.

## Smoke-test a built artifact

```bash
cf verify ubuntu-24.04
cf verify windows-server-2025 --level quick   # boot + agent ping only
```

`cf verify` rebuilds a VM from the published sidecar onto a scratch VMID — the
same `qm create --import-from` path `coport` installs through — and exercises it
the way a user's clone is exercised, rather than merely booting it:

1. **Cloud-init is actually configured.** A sentinel hostname, user, generated
   password, and generated SSH key are injected, and the disk is grown beyond
   its shipped size. Booting the template untouched leaves the cloud-init drive
   empty, so nothing cloud-init is supposed to apply gets exercised at all.
2. **A battery of in-guest checks runs over `qm guest exec`**, in phases: on the
   first boot, again after a clean reboot, and — on Windows — after an autologon
   has painted a desktop. The guest agent answering is the _entry condition_ for
   these checks, not the result: it starts early and is independent of nearly
   everything a template promises.
3. **The hardware profile is under test, not just the disk.** The VM is built
   from the sidecar's `hardware` block through the shared builder in
   `src/registry/create.ts`, so a profile that no longer describes what its
   images need fails here instead of in a consumer's install.
4. **The console framebuffer is sampled.** This needs nothing from the guest, so
   it is the only check that can see a kernel panic, a GRUB hang, or a desktop
   that never painted. Outside CI the frame is written to
   `./diagnostics/verify-<recipe>-<arch>-<timestamp>/` as a gzipped PPM (same
   format as the build recorder's frames — PVE's qemu is commonly built without
   libpng).

Checks are declarative data in `src/verify/checks/`, split into a shared Linux
suite and a Windows suite, with per-recipe overrides keyed by recipe name in
`src/verify/checks/index.ts`. Adding a regression test for a shipped bug is a
few lines there and needs no change to the runner. Each check declares a
severity: `warn` records a finding, `fail` fails the run.

`--level quick` imports, boots, and pings the guest agent — the pre-battery
behaviour, for fast local loops. `--ci` suppresses framebuffer captures, which
are unredactable images and must never land in a public repo.

## Check for upstream ISO changes

Fetches `Last-Modified`/`ETag` headers from each recipe's upstream ISO URL and compares against `upstream-checksums.json`. Prints which recipes have a new upstream image.

```sh
cf check           # check all recipes
cf check debian-12 # check one recipe
cf check --json    # output changed recipe names as JSON (for CI)
```

Commit `upstream-checksums.json` so CI can track changes across runs.

## Publish a manifest

Aggregates `./dist/*.json` sidecars into `./registry.json` at the repo root, for consumption by [downloader](https://github.com/ConvoyPanel/downloader) or [coport](coport.md), the node-side template installer. In CI, use `cf publish --r2` to source sidecars from R2 instead (artifacts are never synced back to the runner).

```sh
cf publish        # local: dist/*.json → registry.json
cf publish --r2   # CI: lists newest sidecar per template in R2
```

## Cleanup

### After a build (free space on the node)

```sh
cf clean
```

Removes from the Proxmox node:

- `$PVE_DUMP_DIR/cofoundry-work`, `cofoundry-snapshots`, `cofoundry-cache`,
  `cofoundry-tmp`, and `cofoundry-out` (plus orphaned `cofoundry-work.new.*` links)
- legacy `/tmp/cofoundry/` data, if present
- Uploaded ISOs from Proxmox ISO storage (`packer*.iso` and hash-named ISOs)
- Every `vzdump-qemu-*` archive left in the dump dir, regardless of VMID
- Every `packer-*` build VM and its disks, **including templates** left by
  successful builds (`clean` is a full teardown; `prune` spares templates)
- Disks orphaned in the `CF_STORAGE` pool whose owning VM is already gone
- Interrupted ISO downloads, including PID-suffixed `*.iso.tmp.<pid>` files
- RRD and vzdump telemetry belonging to deleted Cofoundry build/verify VMIDs

Builds and verification runs share a node maintenance lock. They can still run
in parallel with each other, while `clean` takes the exclusive side and waits
for them to finish before tearing down state. A second `clean` also waits, so
cleanup cannot race ISO prefetch, repository upload, Packer, or another cleanup.
Deletion is verified before the command reports success.

### Weekly maintenance

```sh
cf prune           # orphaned VMs + iso-cache files older than 30 days
cf prune --days 7  # stricter cache cutoff
```

Removes:

- VMs and scratch explicitly owned by expired run leases, plus legacy
  non-template `packer-*` VMs older than the cutoff;
- old, unreferenced Packer ISO files and download-cache entries (the persistent
  `packer-virtio-win*.iso` cache is preserved and attached media is never pruned);
- vzdump archives and working data older than the selected cutoff;
- orphaned per-build scratch in `cofoundry-tmp` (`build-*`, `repo-*.tar.gz`,
  `sync-*`) and half-swapped `cofoundry-work.new.*` links older than the cutoff;
- unreferenced repository snapshots older than the selected cutoff.

A cron job on the node handles this automatically — see
[Setup: weekly cleanup cron](setup.md#6-weekly-cleanup-cron).

## CDN upload

Configure the `[upload]` block in `cofoundry.toml`; every build then uploads the
artifact and its sidecar automatically:

```toml
[upload]
endpoint   = "${R2_ENDPOINT}"   # from env (contains the account id)
bucket     = "${R2_BUCKET}"
layout     = "grouped"          # templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}
public_url = "https://cdn.example.com"
prefix     = "templates/"       # what `cf publish --r2` scans
```

The upload command, sidecar command, and public URL are all **generated from the
same key**, so they can never drift. Pick a layout:

| `layout`  | object key                                           |
| --------- | ---------------------------------------------------- |
| `grouped` | `templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}` |
| `flat`    | `templates/{{recipe}}-{{arch}}/{{sha256}}`           |

Both are prune-safe (each template gets its own directory). For a custom path,
set `key` directly instead of `layout`:

```toml
key = "{{recipe}}/{{recipe}}-{{arch}}-{{sha256}}"
```

Placeholders: `{{recipe}}` (recipe name), `{{arch}}`, `{{group}}` (OS family),
`{{sha256}}`. For a fully hand-written command, set `command` /
`sidecar_command` under `[upload]` (they accept the same placeholders plus
`{{file}}`, the local path). `cf publish --r2` scans `prefix`.

### The upload hook (`CF_UPLOAD_CMD`)

The `[upload]` block materializes as three derived values —
`CF_UPLOAD_CMD`, `CF_SIDECAR_UPLOAD_CMD`, and `CF_PUBLIC_URL_TMPL` — that
`cf` exports into the build environment (run `cf config` to see them).
Setting any of them directly in the environment or `.env` overrides the
derived value; that is the escape hatch used to wire in a fully custom hook
such as the [cluster distribution script](#cluster-template-distribution).

Packer runs on the Proxmox node, so its shell-local post-processor
(`recipes/_shared/post/export-and-cleanup.sh`) executes `CF_UPLOAD_CMD` **on
the node** with `bash -c`, right after each artifact is exported and hashed —
any binary the command calls (such as `aws`) must exist there. A recipe emits
a system disk and, on OVMF recipes, an EFI varstore, so the command runs
**once per artifact** with that artifact's own `{{sha256}}` and `{{filename}}`
(see [Disk images](disk-images.md)). These placeholders are substituted first:

| Placeholder               | Value                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `{{file}}`                | path of the file being uploaded (the artifact; the sidecar JSON for `CF_SIDECAR_UPLOAD_CMD`) |
| `{{recipe}}` / `{{name}}` | recipe name, e.g. `debian-12` (`{{name}}` is a legacy alias)                                 |
| `{{arch}}`                | architecture, e.g. `amd64`                                                                   |
| `{{group}}`               | OS family                                                                                    |
| `{{sha256}}`              | SHA-256 of the artifact being uploaded                                                       |
| `{{filename}}`            | `<recipe>-<arch>-<sha256>.qcow2` / `.efivars.raw` (`.json` for the sidecar command)          |
| `{{ext}}`                 | extension of the artifact being uploaded, with the dot: `.qcow2`, `.efivars.raw`, `.json`    |

`CF_PUBLIC_URL_TMPL` accepts the same placeholders except `{{file}}`; the
rendered URL is written into that artifact's `url` field in the sidecar's
`disks` array.

The command also inherits useful build environment: `R2_ENDPOINT`,
`R2_BUCKET`, `R2_PREFIX`, and the `AWS_*` credentials (so the generated
`aws s3 cp` can authenticate on the node), plus `CF_RECIPE_NAME`, `CF_ARCH`,
`CF_GROUP`, `CF_BUILT_VMID` (the built VM's id — slot-derived for networked
installers), and `CF_RECIPE_BASE_VMID` (the recipe's stable base VMID).
`cf build --skip-upload` withholds all upload variables for that invocation,
and `cf upload [names...]` re-runs the same commands later for already-built
artifacts (with `--remote` they execute on the node against its
`cofoundry-out` directory).

## Cluster template distribution

`scripts/cf-cluster-templates.sh` is a local/cluster convenience — not part of
the upstream recipes — that turns each freshly built template into a clonable
template on **every online node** of a Proxmox cluster. Cluster VMIDs are
globally unique, so each node gets its own copy under its own VMID.

Wire it in as the build node's **sidecar** hook in `.env`:

```sh
CF_SIDECAR_UPLOAD_CMD=bash $PVE_DUMP_DIR/cofoundry-work/scripts/cf-cluster-templates.sh {{file}}
```

Not `CF_UPLOAD_CMD`. A template is several images now (a system disk and, on
OVMF recipes, an EFI varstore), and `CF_UPLOAD_CMD` fires once **per image** —
the script would be handed a bare `.qcow2` with no idea what else belongs to
it. `CF_SIDECAR_UPLOAD_CMD` fires once per template, after every image has been
written, and hands over the sidecar that names them all. No separate
`{{sha256}}` argument is needed: the sidecar records a hash per image.

For every online node listed in `/etc/pve/.members`, the script:

1. computes the target VMID as `node_id * OFFSET + BASE_VMID`. `OFFSET` is
   `CF_TEMPLATE_VMID_OFFSET` (default `10000`) and `BASE_VMID` is
   `CF_RECIPE_BASE_VMID`, falling back to `CF_BUILT_VMID`. With base `4001`:
   node 1 → `14001`, node 2 → `24001`, node 3 → `34001`. The script refuses
   to run when the base VMID is not below the offset, since adjacent nodes
   would collide;
2. copies **every** image named by the sidecar into the node's dump dir over
   `scp` (a plain `cp` when the target is the build node itself);
3. verifies each copy against that image's recorded SHA-256, retrying once on
   a mismatch. All images must land before anything destructive happens — a
   template whose varstore failed to transfer is unbootable, so a node that
   cannot stage the full set is skipped with its existing template intact;
4. picks that node's disk storage, in order: `CF_TEMPLATE_STORAGE` (default
   `local-lvm`) if active, then `local-lvm`, then `local-zfs`, and as a last
   resort the best active images-capable storage — local over shared,
   VM-native types (lvmthin/zfspool/btrfs/rbd/lvm) over directory storage,
   most free space first;
5. runs `qm create` with the sidecar's hardware profile, importing each image
   from its staged path, then `qm template`. The flags are rendered on the
   target node, since only it knows its own storage name; that rendering
   mirrors `src/registry/create.ts`, the builder `coport` and `cf verify`
   share, and the two must be kept in step.

`CF_TEMPLATE_BRIDGE` (default `vmbr0`) sets the NIC bridge, since the profile
records only the model.

A VMID holding a real (non-template) VM is never touched — that node is
skipped with a log line. An existing template at the VMID is stopped,
destroyed, and replaced. A failure on one node is logged (`[fail] <ip>`) and
the loop continues with the remaining nodes.

The knobs are read from the post-processor's environment on the node; `cf`
does not forward them from your workstation. To change one, set it inside the
command itself:

```sh
CF_SIDECAR_UPLOAD_CMD=CF_TEMPLATE_STORAGE=local-zfs bash $PVE_DUMP_DIR/cofoundry-work/scripts/cf-cluster-templates.sh {{file}}
```

This flow pushes templates to the nodes of your own cluster at build time.
For installing templates from a published registry onto any Proxmox node, see
[Coport](coport.md).

## GitHub Actions

Only two of these are things you start. The rest are `workflow_call`-only
callees, named `[internal] …` so the Actions sidebar — which lists every
workflow file and cannot hide a callee — does not imply four buttons that do
not exist. Their runs are nested under whichever workflow called them, which is
also why they show no run history of their own.

Entry points:

- **`check-upstream.yml`** ("Check upstream images") — scheduled weekly, also
  dispatchable. Runs changed recipes in a parallel matrix, then publishes once.
  Publishing and the checksum commit tolerate a partial failure: successful
  recipes are published and get their checksums advanced, while a failed recipe
  keeps its old checksum and is retried next run.
- **`build.yml`** ("Build template") — manual one-recipe entry point. A thin
  orchestrator: calls `build-one.yml`, then `publish.yml` and `prune-node.yml`.

Called, never dispatched:

- **`build-one.yml`** — parallel-safe build and smoke-test worker; where a
  recipe is actually built and verified. Called by `build.yml` (once) and
  `check-upstream.yml` (once per changed recipe).
- **`publish.yml`** — globally serialized registry writer and R2 finalizer.
- **`prune-node.yml`** — lease-aware node maintenance after a workflow finishes.

Callers resolve these by path (`uses: ./.github/workflows/<file>.yml`), so the
`[internal]` display names are cosmetic; renaming one cannot break a caller.

CI reads the same committed `cofoundry.toml`; it supplies only the secrets and
the `${VAR}` coordinates. See [Setup](setup.md).
