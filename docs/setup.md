# Setup

Everything to do once, before the first build.

In production GitHub Actions runs the pipeline: configure the Proxmox node
(part 1), set the repo secrets (part 2), and create the R2 bucket (part 3).
Part 4 is only for running builds by hand from a workstation. The
[appendix](#appendix--manual-node-configuration) shows what part 1 does, for
partial runs and debugging.

## 1. Proxmox node

Prerequisite: passwordless SSH into the node as root (`ssh-copy-id
root@<pve-host>`).

```sh
bun run cf bootstrap
```

Answer the prompts for the target host and API token. Bootstrap probes the node,
shows a checklist of what it will change, asks for confirmation, then applies.
Re-running is safe — already-done steps are detected and skipped.

**The new API token secret is shown once**, immediately after creation and before
package or network setup continues, with an offer to append it to `.env`. It
cannot be retrieved from Proxmox later.

Bootstrap adopts the build bridge's existing IPv4 `/24` (say `vmbr1` on
`10.10.10.0/24`), defaulting to `10.0.0.0/24` for a new bridge. It verifies that
the subnet, dnsmasq configuration, and DNS/DHCP listeners do not conflict with
existing node services, and stops with an actionable error rather than
overwriting an unrecognized configuration. The dnsmasq change is validated before
restart and rolled back if the restart fails.

No subnet environment variable is needed. Set `network.build_bridge` (or
`CF_BUILD_BRIDGE`) only when the bridge is not `vmbr1`; Cofoundry reads its live
gateway and `/24`. Bootstrap prints the selected 50-address slot block, and each
build prints its reserved IP and gateway.

Bootstrap does not alter the node's `/tmp` — build scratch lives under
`PVE_DUMP_DIR/cofoundry-tmp`. An older Cofoundry bootstrap may have added a
`tmpfs /tmp` entry to `/etc/fstab`; remove it manually if it was created only for
Cofoundry. It is not removed automatically because the bootstrapper cannot safely
determine who owns an existing `/tmp` mount.

### Weekly cleanup cron

Keeps ISOs, dump files, and orphaned VMs from accumulating. Only needed if you
build locally — CI runs `cf prune --days 7` after each build workflow.

```
0 3 * * 0 cd /path/to/cofoundry && bun run cf prune --days 30
```

Prune honors active run leases, VM media references, and age cutoffs, so it can
safely overlap a build from another workflow. Run `cf prune --dry-run` first.

## 2. GitHub Actions

### SSH access to the node

Generate a dedicated key pair on your workstation and authorize it on the node:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/cofoundry_ci -N ""
ssh-copy-id -i ~/.ssh/cofoundry_ci.pub root@<pve-host>
```

**Using Tailscale SSH? Skip this.** If `SSH_PRIVATE_KEY` is unset the workflow's
key-setup step is skipped and the runner authenticates over Tailscale SSH. That
needs a tailnet ACL `ssh` rule with `action: "accept"` granting `tag:ci` access
as the user `SSH_TARGET` connects as. `action: "check"` rules do not work — they
require interactive reauth.

### Tailscale (optional)

For a node whose public SSH port is closed. The `Connect to Tailscale` step uses
an OAuth client to spin up an ephemeral tagged node per job.

**a. ACL tags and SSH rule** (admin → Access Controls):

```hujson
"tagOwners": {
  "tag:cofoundry": ["autogroup:owner"],
},
"ssh": [
  { "action": "accept", "src": ["tag:cofoundry"], "dst": ["tag:cofoundry"], "users": ["root"] },
],
```

Tag the PVE node `tag:cofoundry` (admin → Machines → node → Edit ACL tags).
Tagging detaches the node from your user — fine for a server, but add a separate
rule if you also want to SSH from your laptop.

**b. OAuth client** (admin → Settings → OAuth clients → Generate):

- Scopes: **`Auth Keys` → Write**. `devices:core` alone is not enough and
  produces a 403.
- Tags: `tag:cofoundry`. The client can only mint keys for tags selected here,
  and this is not editable after creation — recreate the client if you miss one.
- Copy the client ID and secret (shown once).

**c. Point `SSH_TARGET`/`PVE_HOST` at the tailnet address** — a MagicDNS name
(`root@pve.tail-scale.ts.net`) or the 100.x IP.

The tag must match in three places: the `tagOwners` ACL block, the OAuth client's
scope, and the `src` of the SSH rule. A 403 "calling actor does not have enough
permissions" from `Connect to Tailscale` means they are out of sync.

MagicDNS on the node does not affect builds, but it can affect VMs later cloned
from the templates — see [Cloning a template](usage.md#cloning-a-template).

### Registry-writer GitHub App (optional)

The workflows push two generated files to `main`: `registry.json` after a
successful build, and `upstream-checksums.json` after the scheduled upstream
check. By default they use the built-in `GITHUB_TOKEN`, so **skip this section
unless `main` is protected by a branch ruleset** — which that token cannot
bypass.

Create the app (account/org → Settings → Developer settings → GitHub Apps → New):
name it `cofoundry-registry-writer`, disable the webhook, grant **Contents: Read
and write**, and install it on this repository only. Then copy its client ID and
generate a private key (the `.pem` downloads once).

- `REGISTRY_APP_CLIENT_ID` — the client ID (`Iv23li…`), **not** the numeric app ID.
- `REGISTRY_APP_PRIVATE_KEY` — the entire `.pem`, including the
  `-----BEGIN/END RSA PRIVATE KEY-----` lines and every newline. Do not strip the
  header/footer or collapse it to one line:

    ```sh
    gh secret set REGISTRY_APP_PRIVATE_KEY < ~/Downloads/cofoundry-registry-writer.*.private-key.pem
    ```

Then add a bypass entry for the app to the ruleset protecting `main` (repo →
Settings → Rules → Rulesets). Rulesets cannot scope a bypass to specific paths,
so the app can bypass the ruleset for the whole branch; the workflows still stage
only those two files.

The workflows use the App token when both secrets are set and fall back to
`GITHUB_TOKEN` when they are not.

### `cofoundry.toml` and repo secrets

Non-secret deployment config — ports, storage, bridges, upload layout — lives in
the committed **`cofoundry.toml`**, which CI checks out and reads directly. It is
**not** duplicated into repo Variables. Sensitive coordinates in that file use
`${VAR}` and come from the environment below.

Commit a `cofoundry.toml` (see [part 4](#4-local-development-optional), or run
`cf init`). Its `[upload]` block controls the R2 layout; `layout = "grouped"`
produces `templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}{{ext}}`. See
[Usage → CDN upload](usage.md#cdn-upload).

**Secrets** (Settings → Secrets and variables → Actions → Secrets):

| Secret                     | Value                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `PVE_TOKEN_SECRET`         | Token secret from part 1                                                                 |
| `SSH_PRIVATE_KEY`          | Contents of `~/.ssh/cofoundry_ci`. Omit if using Tailscale SSH.                          |
| `TS_OAUTH_CLIENT_ID`       | Tailscale OAuth client ID (Tailscale only)                                               |
| `TS_OAUTH_SECRET`          | Tailscale OAuth secret (Tailscale only)                                                  |
| `R2_ACCESS_KEY_ID`         | R2 API token access key                                                                  |
| `R2_SECRET_ACCESS_KEY`     | R2 API token secret                                                                      |
| `REGISTRY_APP_CLIENT_ID`   | GitHub App client ID. Only if `main` is ruleset-protected; omit to use `GITHUB_TOKEN`.   |
| `REGISTRY_APP_PRIVATE_KEY` | GitHub App private key. Only if `main` is ruleset-protected; omit to use `GITHUB_TOKEN`. |

**Coordinates referenced by `${VAR}` in `cofoundry.toml`.** Set each as a repo
Variable (visible and reviewable) or a Secret if you would rather hide it — the
workflow reads `vars.X || secrets.X`, so set it in one place, not both. If you
inline any of these as a literal in `cofoundry.toml`, drop it here.

| Name           | Value                                                 |
| -------------- | ----------------------------------------------------- |
| `PVE_HOST`     | Proxmox hostname or IP (or tailnet IP)                |
| `SSH_TARGET`   | e.g. `root@pve.example.com` or `root@<tailnet-IP>`    |
| `PVE_NODE`     | Proxmox node name (shown in the web UI sidebar)       |
| `PVE_TOKEN_ID` | `root@pam!cofoundry`                                  |
| `R2_ENDPOINT`  | `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`    |
| `R2_BUCKET`    | R2 bucket name, e.g. `cofoundry-templates`            |
| `TS_TAG`       | Tag the OAuth client is scoped to. Default: `tag:ci`. |

Everything else — `PVE_PORT`, `PVE_DUMP_DIR`, `CF_STORAGE`, `CF_ISO_STORAGE`,
`CF_BRIDGE`, and the whole upload layout — comes from `cofoundry.toml`. Run
`cf config` to see what resolves and from where.

### Parallel builds (optional)

GitHub Actions and the Proxmox node have separate controls. The node budgets are
total node-wide, not per-VM.

| Variable                    | Value                                                               |
| --------------------------- | ------------------------------------------------------------------- |
| `CF_CI_MAX_PARALLEL`        | Maximum GitHub matrix fan-out; defaults to `4`                      |
| `CF_BUILD_MEMORY_BUDGET_MB` | Node-wide build/verify RAM budget; defaults to 80% of RAM           |
| `CF_BUILD_CPU_BUDGET`       | Total concurrent VM vCPUs; defaults to the host's logical CPU count |

With a matrix cap of 4, a memory budget of `16384`, and a CPU budget of `8`,
GitHub starts four recipe jobs and the node admits only the combination whose
declared recipe resources fit in 16 GiB and 8 vCPUs. The node-side lease manager
is the authoritative admission control; duplicate recipes are serialized
separately, and registry/checksum writers share one global publication queue.

For a local `cf build` spanning several recipes, configure it in
`cofoundry.toml` instead — both budgets are required when `concurrency > 1`:

```toml
[build]
concurrency = 4
memory_budget_mb = 16384
cpu_budget = 8
```

`build.concurrency` does not control the GitHub matrix. See
[Usage → Build everything](usage.md#build-everything).

## 3. Cloudflare R2 bucket

1. **Create the bucket** — R2 → Create bucket, default region.
2. **Bind a custom domain** — R2 → Bucket → Settings → Custom Domains → Connect
   Domain. Use a subdomain you control and set it as `[upload].public_url` in
   `cofoundry.toml`.
3. **Create an API token** — R2 → Manage R2 API Tokens → Create API token, scoped
   to object read/write on the bucket. The access key id and secret become
   `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`; the S3 endpoint shown on that page
   is `R2_ENDPOINT`.
4. **Add a lifecycle rule** as a safety net — Settings → Object Lifecycle Rules,
   prefix `templates/`, delete after 60 days. This catches orphans whose recipe
   was deleted; the pipeline's own `cf prune --r2 --keep 5` handles the tight
   per-recipe windows.

With the grouped layout, published URLs look like:

```
https://templates.example.com/templates/<group>/<recipe>-<arch>/<sha256>.qcow2
https://templates.example.com/registry.json
```

`{{ext}}` is what lets one key template serve every file a template ships: the
system disk (`.qcow2`), an EFI varstore on OVMF recipes (`.efivars.raw`), and the
sidecar (`.json`), each content-addressed by its own hash.

### Path scheme

- **Images** — `templates/<name>-<arch>/<sha256>.qcow2` and, on OVMF recipes,
  `…/<sha256>.efivars.raw`. Content-addressed, immutable.
- **Sidecars** — `templates/<name>-<arch>/<sha256>.json`, addressed by the
  **system disk's** hash, so each build publishes a distinct key rather than
  overwriting the last. That history is what `cf publish --r2` picks
  newest-per-template from and what `cf prune --r2` retains N of.
- **Registry** — `registry.json` at the root, short TTL (60s), one canonical
  pointer file. `git log registry.json` is the audit log; rollback is a
  `git revert` and CI re-mirrors.

`--keep` counts **generations**, not objects: a schema-2 template is a sidecar
plus the images it names, so retention reads each sidecar and keeps the images
the newest `keep` of them reference. Images matching no surviving generation are
deleted, including ones orphaned by a half-finished publish; an image two
generations share (an unchanged EFI varstore across rebuilds) survives as long as
either does. Objects that are neither a sidecar nor a recognized image extension
are never touched.

## 4. Local development (optional)

Only needed to run `cf` commands by hand.

**Dependencies:** [Bun](https://bun.sh) 1.x, and the OpenSSH `ssh` client on your
`PATH`. That is the whole list — no local `rsync` or `tar`. Cofoundry avoids both
deliberately: the repository is archived in-process and uploaded over SFTP, so
the CLI behaves the same on every platform. See
[Architecture → Repository snapshots](architecture.md#repository-snapshots-and-platform-support).

```sh
git clone <repo-url> cofoundry && cd cofoundry
bun install
ssh-copy-id root@<pve-host>
ssh root@<pve-host> hostname   # verify: no password prompt
```

Configuration splits in two:

- **`cofoundry.toml`** (committed) — non-secret deployment facts shared by your
  laptop and CI: node coordinates, storage pools, bridges, upload layout.
- **`.env`** (gitignored) — secrets (`PVE_TOKEN_SECRET`, R2 keys) plus any
  coordinate `cofoundry.toml` sources via `${VAR}`.

If the repo already ships a `cofoundry.toml`, just supply the secrets with
`cp .env.example .env`. Starting fresh, scaffold one with `cf init` (or
`cf init --from-env` to fill it from an existing `.env`).

Non-secret per-machine overrides go in **`cofoundry.local.toml`** (gitignored).
Resolution order, highest first:

```
CLI flag  >  env / .env  >  ${VAR}  >  cofoundry.local.toml  >  cofoundry.toml  >  default
```

Then verify:

```sh
cf config    # every resolved value and where it came from
cf doctor    # preflight: SSH, PVE API auth, R2 credentials
cf list      # should print all available recipes
```

**Windows workstations.** `cf` runs natively via Bun — no WSL or Cygwin. Any
`ssh.exe` on `PATH` works, whether from [Git for Windows](https://gitforwindows.org/)
or Windows' built-in OpenSSH. SFTP authenticates through your SSH agent when
`SSH_AUTH_SOCK` is set, otherwise falling back to `~/.ssh/id_ed25519`,
`id_rsa`, `id_ecdsa` — so keep the node key at one of those paths or load it into
an agent. One caveat: `cf upload` without `--remote` runs the upload command
through `bash -c`, so it needs a `bash` on `PATH`.

## Appendix — manual node configuration

`cf bootstrap` does all of this. It is here for partial runs and debugging. Run
it on the node.

**API token.** The secret is shown once.

```sh
pveum user token add root@pam cofoundry --privsep=0
```

**Packer**, which runs _on the node_ so its HTTP server is reachable by build VMs
over the bridge:

```sh
wget -O- https://apt.releases.hashicorp.com/gpg \
  | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] \
  https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
  > /etc/apt/sources.list.d/hashicorp.list
apt-get update && apt-get install -y packer
```

**`awscli`**, if uploading to R2/S3. The export post-processor runs the upload
command derived from `[upload]` on the node, so the binary must exist there:
`apt-get install -y awscli`. `cf build` forwards `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, and `AWS_DEFAULT_REGION` from your
local env (or repo secrets in CI) into the remote Packer environment — no config
files on the node.

**ISO cache.** Recipes download their boot ISO into `/var/lib/vz/template/iso`,
Proxmox's standard ISO storage, which already exists. The first build per recipe
downloads; the rest reuse it.

**NAT bridge.** Every current recipe is an ISO installer and needs this. ISO
installers cannot rely on the qemu-guest-agent for IP discovery, and Windows has
no agent during install at all, so builds run on a dedicated NAT bridge with a
per-build static DHCP reservation allocated from the bridge's live `/24` (see
`src/build/netslot.ts`). Existing bridges and non-overlapping dnsmasq pools are
adopted; the allocator picks a free contiguous 50-address block outside existing
DHCP ranges and static hosts, so up to 50 builds can run in parallel per node.

Add to `/etc/network/interfaces`, then `ifup vmbr1`:

```
auto vmbr1
iface vmbr1 inet static
    address 10.0.0.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up   iptables -t nat -A POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s 10.0.0.0/24 -o vmbr0 -j MASQUERADE
```

Then `apt-get install -y dnsmasq` and create `/etc/dnsmasq.d/vmbr1-nat.conf`:

```
# Managed by Cofoundry.
interface=vmbr1
bind-interfaces
dhcp-range=10.0.0.200,10.0.0.250,12h
dhcp-option=3,10.0.0.1
dhcp-option=6,1.1.1.1
dhcp-option=option:router,10.0.0.1
dhcp-hostsfile=/etc/dnsmasq.d/cofoundry-hosts.d
```

```sh
mkdir -p /etc/dnsmasq.d/cofoundry-hosts.d /var/lib/cofoundry
dnsmasq --test
systemctl restart dnsmasq
```

Per-build reservations are written under `/etc/dnsmasq.d/cofoundry-hosts.d/`
during a build and cleaned up afterward — no manual entries.
