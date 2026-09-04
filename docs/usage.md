# Usage

## Build a template

```sh
cf build debian-12
cf build windows-server-2025
cf build debian-12 --skip-artifact-sync   # env: CF_SKIP_ARTIFACT_SYNC=1
cf build debian-12 --skip-upload
```

The first run for a recipe downloads its ISO to the node's cache; later builds
reuse it. Output lands in `./dist/`:

```
dist/debian-12-amd64.qcow2   # system disk, compressed qcow2
dist/debian-12-amd64.json    # sidecar (disks, hardware profile, minimum)
```

OVMF recipes (every `windows-server-*`) emit a third file,
`dist/<name>-amd64.efivars.raw` — the EFI variable store, which carries the boot
entry and enrolled Secure Boot keys a freshly allocated varstore would not have.
See [Disk images](disk-images.md) for the sidecar schema and how a consumer turns
these back into a VM.

`--skip-upload` disables the configured artifact and sidecar uploads for that
invocation; it does not disable the artifact download to `CF_OUT_DIR`.

## List available recipes

```sh
cf list
```

## Cloning a template

Cofoundry templates contain no baked-in DNS server. **Give every clone an
explicit reachable nameserver.**

This matters most when the Proxmox node accepts Tailscale MagicDNS. Tailscale
sets the node's resolver to `100.100.100.100`, and Proxmox uses the node's
resolver as the default for a cloud-init VM without its own — so a clone that is
not on the tailnet cannot resolve anything. This affects the deployed clone, not
the build or its CI runner.

The alternative is to keep the node from accepting MagicDNS
(`tailscale set --accept-dns=false`) and set the node's resolver in
**Datacenter → DNS**. On Ubuntu, `/etc/resolv.conf` points at the
systemd-resolved stub `127.0.0.53`; use `resolvectl status` to see the real
upstream.

A `--cipassword` has two constraints — it must not begin with a YAML indicator
character, and it must satisfy the guest's password policy. See
[windows.md](windows.md#constraints-on-the-caller); the YAML one applies to Linux
clones too.

## Build everything

Omit recipe names to build everything. Builds are stage-pipelined, continue on
failure, and print a pass/fail summary.

```sh
cf build
cf build --build-concurrency 4 --build-memory-budget 16G --build-cpu-budget 8
```

Packer builds run one at a time by default. Parallel builds require a maximum
concurrency **and** explicit node-wide RAM and CPU budgets; a recipe starts only
when all three have capacity. The persistent equivalents are
`build.concurrency`, `build.memory_budget_mb`, and `build.cpu_budget` in
`cofoundry.toml`. Recipe requirements come from each `.pkr.hcl`'s `memory` and
`cores`.

The local scheduler coordinates recipes within one command; heartbeating leases
on the node enforce the same budgets across independent `cf build` and
`cf verify` processes. Omitted budgets default to 80% of physical RAM and all
host CPUs, and configured budgets are clamped to those ceilings. Explicit
budgets are still preferable when other workloads share the node.

## Smoke-test a built artifact

```sh
cf verify ubuntu-24.04
cf verify windows-server-2025 --level quick   # import + boot + agent ping only
cf verify debian-12 --ci                      # suppress framebuffer captures
```

`cf verify` rebuilds a VM from the **published sidecar** onto a scratch VMID —
the same `qm create --import-from` path `coport` installs through — and exercises
it the way a user's clone is exercised, rather than merely booting it:

1. **Cloud-init is actually configured.** A sentinel hostname, user, generated
   password, and generated SSH key are injected, and the disk is grown beyond its
   shipped size. Booting the template untouched leaves the cloud-init drive empty,
   so nothing cloud-init is supposed to apply gets exercised at all.
2. **In-guest checks run over `qm guest exec`**, in phases: first boot, again
   after a clean reboot, and on Windows after an autologon has painted a desktop.
   The agent answering is the _entry condition_, not the result — it starts early
   and is independent of nearly everything a template promises.
3. **The hardware profile is under test, not just the disk.** The VM is built
   from the sidecar's `hardware` block through the shared builder in
   `src/registry/create.ts`, so a profile that no longer describes what its images
   need fails here rather than in a consumer's install.
4. **The console framebuffer is sampled.** This needs nothing from the guest, so
   it is the only check that can see a kernel panic, a GRUB hang, or a desktop
   that never painted. Outside CI the frame is written to
   `./diagnostics/verify-<recipe>-<arch>-<timestamp>/` as a gzipped PPM — PVE's
   qemu is commonly built without libpng.

Checks are declarative data in `src/verify/checks/`, split into a shared Linux
suite and a Windows suite, with per-recipe overrides keyed by recipe name in
`src/verify/checks/index.ts`. Adding a regression test for a shipped bug is a few
lines there and needs no change to the runner. Each check declares a severity:
`warn` records a finding, `fail` fails the run.

`--ci` exists because framebuffer captures are unredactable images and must never
land in a public repo.

## Check for upstream ISO changes

Fetches `Last-Modified`/`ETag` from each recipe's upstream ISO URL and compares
against `upstream-checksums.json`, which should be committed so CI can track
changes across runs.

```sh
cf check           # all recipes
cf check debian-12 # one recipe
cf check --json    # changed recipe names as JSON, for CI
```

## Publish a manifest

Aggregates sidecars into `./registry.json` for
[downloader](https://github.com/ConvoyPanel/downloader) or
[coport](coport.md).

```sh
cf publish        # local: dist/*.json → registry.json
cf publish --r2   # CI: newest sidecar per template in R2
```

CI uses `--r2` because artifacts are never synced back to the runner.

## Cleanup

### After a build — `cf clean`

A full teardown of Cofoundry state on the node (`prune` is the gentler one — it
spares templates):

- `$PVE_DUMP_DIR/cofoundry-{work,snapshots,cache,tmp,out}`, plus orphaned
  `cofoundry-work.new.*` links and legacy `/tmp/cofoundry/` data;
- uploaded ISOs from ISO storage (`packer*.iso` and hash-named ISOs), and
  interrupted downloads including `*.iso.tmp.<pid>`;
- every `packer-*` build VM and its disks, **including templates** left by
  successful builds;
- disks orphaned in `CF_STORAGE` whose owning VM is gone;
- any legacy `vzdump-qemu-*` archive left in the dump dir, regardless of VMID;
- RRD and backup telemetry belonging to deleted Cofoundry build/verify VMIDs.

Builds and verification runs share a node maintenance lock and can run in
parallel with each other; `clean` takes the exclusive side and waits for them to
finish, so cleanup cannot race ISO prefetch, repository upload, Packer, or
another cleanup. Deletion is verified before the command reports success.

### Weekly — `cf prune`

```sh
cf prune           # orphaned VMs + iso-cache files older than 30 days
cf prune --days 7  # stricter cutoff
```

Removes VMs and scratch owned by expired run leases plus legacy non-template
`packer-*` VMs past the cutoff; unreferenced Packer ISOs and download-cache
entries (the persistent `packer-virtio-win*.iso` cache is preserved and attached
media is never pruned); archives and working data past the cutoff; orphaned
per-build scratch in `cofoundry-tmp` (`build-*`, `repo-*.tar.gz`, `sync-*`) and
half-swapped `cofoundry-work.new.*` links; and unreferenced repository snapshots.

A cron job handles this — see
[Setup → weekly cleanup cron](setup.md#weekly-cleanup-cron).

## CDN upload

Configure `[upload]` in `cofoundry.toml`; every build then uploads the artifacts
and sidecar automatically.

```toml
[upload]
endpoint   = "${R2_ENDPOINT}"   # from env (contains the account id)
bucket     = "${R2_BUCKET}"
layout     = "grouped"          # templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}
public_url = "https://cdn.example.com"
prefix     = "templates/"       # what `cf publish --r2` scans
```

The upload command, sidecar command, and public URL are **generated from the same
key**, so they cannot drift. Both layouts are prune-safe, since each template
gets its own directory:

| `layout`  | object key                                           |
| --------- | ---------------------------------------------------- |
| `grouped` | `templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}` |
| `flat`    | `templates/{{recipe}}-{{arch}}/{{sha256}}`           |

For a custom path set `key` directly instead of `layout` — e.g.
`key = "{{recipe}}/{{recipe}}-{{arch}}-{{sha256}}"`. For a fully hand-written
command, set `command`/`sidecar_command` under `[upload]`.

### The upload hook (`CF_UPLOAD_CMD`)

`[upload]` materializes as three derived values — `CF_UPLOAD_CMD`,
`CF_SIDECAR_UPLOAD_CMD`, and `CF_PUBLIC_URL_TMPL` — which `cf` exports into the
build environment (`cf config` shows them). Setting any of them directly in the
environment or `.env` overrides the derived value; that is the escape hatch for a
custom hook such as the [cluster distribution script](#cluster-template-distribution).

Packer runs on the node, so the post-processor
(`recipes/_shared/post/export-and-cleanup.sh`) executes `CF_UPLOAD_CMD` **on the
node** with `bash -c`, right after each artifact is exported and hashed — any
binary it calls (such as `aws`) must exist there. A recipe emits a system disk
and, on OVMF recipes, an EFI varstore, so the command runs **once per artifact**
with that artifact's own hash and filename.

| Placeholder               | Value                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `{{file}}`                | path of the file being uploaded (the sidecar JSON for `CF_SIDECAR_UPLOAD_CMD`)      |
| `{{recipe}}` / `{{name}}` | recipe name, e.g. `debian-12` (`{{name}}` is a legacy alias)                        |
| `{{arch}}`                | architecture, e.g. `amd64`                                                          |
| `{{group}}`               | OS family                                                                           |
| `{{sha256}}`              | SHA-256 of the artifact being uploaded                                              |
| `{{filename}}`            | `<recipe>-<arch>-<sha256>.qcow2` / `.efivars.raw` (`.json` for the sidecar command) |
| `{{ext}}`                 | extension with the dot: `.qcow2`, `.efivars.raw`, `.json`                           |

`CF_PUBLIC_URL_TMPL` takes the same placeholders except `{{file}}`; the rendered
URL is written into that artifact's `url` field in the sidecar's `disks` array.

The command inherits `R2_ENDPOINT`, `R2_BUCKET`, `R2_PREFIX`, and the `AWS_*`
credentials (so a generated `aws s3 cp` can authenticate on the node), plus
`CF_RECIPE_NAME`, `CF_ARCH`, `CF_GROUP`, `CF_BUILT_VMID` (slot-derived for
networked installers), and `CF_RECIPE_BASE_VMID`. `cf build --skip-upload`
withholds all upload variables; `cf upload [names...]` re-runs the same commands
later for already-built artifacts (with `--remote`, on the node against its
`cofoundry-out` directory).

## Cluster template distribution

`scripts/cf-cluster-templates.sh` is a local convenience — not part of the
upstream recipes — that turns each freshly built template into a clonable
template on **every online node** of a Proxmox cluster. Cluster VMIDs are
globally unique, so each node gets its own copy under its own VMID.

Wire it in as the build node's **sidecar** hook in `.env`:

```sh
CF_SIDECAR_UPLOAD_CMD=bash $PVE_DUMP_DIR/cofoundry-work/scripts/cf-cluster-templates.sh {{file}}
```

**Not `CF_UPLOAD_CMD`.** A template is several images now, and `CF_UPLOAD_CMD`
fires once _per image_ — the script would be handed a bare `.qcow2` with no idea
what else belongs to it. `CF_SIDECAR_UPLOAD_CMD` fires once per template, after
every image is written, and hands over the sidecar that names them all (including
a hash per image, so no separate `{{sha256}}` argument is needed).

For every online node in `/etc/pve/.members`, the script:

1. computes the target VMID as `node_id * OFFSET + BASE_VMID`, where `OFFSET` is
   `CF_TEMPLATE_VMID_OFFSET` (default `10000`) and `BASE_VMID` is
   `CF_RECIPE_BASE_VMID`, falling back to `CF_BUILT_VMID`. With base `4001`:
   node 1 → `14001`, node 2 → `24001`. It refuses to run when the base VMID is
   not below the offset, since adjacent nodes would collide;
2. copies **every** image named by the sidecar into the node's dump dir over
   `scp` (a plain `cp` on the build node itself);
3. verifies each copy against its recorded SHA-256, retrying once. All images
   must land before anything destructive happens — a template whose varstore
   failed to transfer is unbootable, so a node that cannot stage the full set is
   skipped with its existing template intact;
4. picks that node's disk storage in order: `CF_TEMPLATE_STORAGE` (default
   `local-lvm`) if active, then `local-lvm`, then `local-zfs`, then the best
   active images-capable storage — local over shared, VM-native types
   (lvmthin/zfspool/btrfs/rbd/lvm) over directory storage, most free space first;
5. runs `qm create` with the sidecar's hardware profile, importing each image
   from its staged path, then `qm template`. The flags are rendered on the target
   node, since only it knows its own storage name. **That rendering mirrors
   `src/registry/create.ts`** — the builder `coport` and `cf verify` share — and
   the two must be kept in step.

`CF_TEMPLATE_BRIDGE` (default `vmbr0`) sets the NIC bridge, since the profile
records only the model.

A VMID holding a real (non-template) VM is never touched; that node is skipped
with a log line. An existing template at the VMID is stopped, destroyed, and
replaced. A failure on one node is logged (`[fail] <ip>`) and the loop continues.

These knobs are read from the post-processor's environment on the node — `cf`
does not forward them from your workstation — so change one inside the command
itself:

```sh
CF_SIDECAR_UPLOAD_CMD=CF_TEMPLATE_STORAGE=local-zfs bash $PVE_DUMP_DIR/cofoundry-work/scripts/cf-cluster-templates.sh {{file}}
```

This pushes templates to your own cluster at build time. To install templates
from a published registry onto any Proxmox node, see [Coport](coport.md).

## GitHub Actions

Only two workflows are things you start. The rest are `workflow_call`-only
callees, named `[internal] …` so the Actions sidebar — which lists every workflow
file and cannot hide a callee — does not imply four buttons that do not exist.
Their runs nest under whichever workflow called them, which is also why they show
no run history of their own.

**Entry points:**

- **`check-upstream.yml`** ("Check upstream images") — scheduled weekly, also
  dispatchable. Runs changed recipes in a parallel matrix, then publishes once.
  Publishing and the checksum commit tolerate partial failure: successful recipes
  publish and advance their checksums, while a failed recipe keeps its old
  checksum and is retried next run.
- **`build.yml`** ("Build template") — manual one-recipe entry point. A thin
  orchestrator over `build-one.yml`, `publish.yml`, and `prune-node.yml`.

**Called, never dispatched:**

- **`build-one.yml`** — the parallel-safe build and smoke-test worker. It builds
  with `--skip-upload`, then verifies, _then_ uploads. **That order is
  load-bearing.** The upload is normally a side effect of the build itself (the
  node-side post-processor runs `CF_UPLOAD_CMD` as soon as the artifact is
  hashed), which is _before_ the smoke test — so a recipe that built but failed
  verify used to publish anyway, and since `cf publish --r2` advertises the newest
  sidecar per template, a failed artifact could supersede a good one.
- **`publish.yml`** — globally serialized registry writer and R2 finalizer. It
  aggregates whatever sidecars are already in R2 and has no idea which passed
  their smoke test, which is why the gate sits in `build-one.yml`.
- **`prune-node.yml`** — lease-aware node maintenance after a workflow finishes.

Callers resolve these by path (`uses: ./.github/workflows/<file>.yml`), so the
`[internal]` display names are cosmetic; renaming one cannot break a caller.

CI reads the same committed `cofoundry.toml` and supplies only the secrets and
`${VAR}` coordinates. See [Setup](setup.md).
