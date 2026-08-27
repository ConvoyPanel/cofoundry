# Setup

Everything you need to do once before running your first build.

In production, GitHub Actions runs the pipeline automatically — you only need to configure the Proxmox node and set the repo secrets. The local workstation section is only needed if you want to run builds manually from your machine.

---

## Part 1 — Proxmox node

### Automated (recommended)

```sh
# one-time, from your workstation:
bun run cf bootstrap
```

Answer the prompts for the target host and API token. The command probes the
node, shows you a checklist of what it will change, asks for confirmation, then
applies. The new API token secret is shown at the end with an offer to append it
to `.env`. Safe to re-run — already-done steps are detected and skipped.

Bootstrap adopts the configured build bridge's existing IPv4 `/24` (for example,
`vmbr1` on `10.10.10.0/24`). For a new bridge it defaults to `10.0.0.0/24`.
It verifies that the subnet, dnsmasq configuration, and DNS/DHCP listeners do
not conflict with existing node services. It stops with an actionable error
instead of overwriting an unrecognized configuration. The dnsmasq change is
validated before restart and rolled back if restart fails.

No subnet environment variable is required. Set `network.build_bridge` (or
`CF_BUILD_BRIDGE`) only when the bridge is not `vmbr1`; Cofoundry reads its live
gateway and `/24`. Bootstrap prints the selected 50-address slot block, and each
build prints its exact reserved IP and gateway.

New Proxmox API token credentials are displayed and optionally written to
`.env` immediately after creation, before package or network setup continues.
The token secret cannot be retrieved from Proxmox later.

Bootstrap does not alter the node's `/tmp`. Build scratch data lives under
`PVE_DUMP_DIR/cofoundry-tmp`. An older Cofoundry bootstrap may have added a
`tmpfs /tmp tmpfs defaults,size=...` entry to `/etc/fstab`; remove that manually
if it was created only for Cofoundry. It is not removed automatically because
the bootstrapper cannot safely determine who owns an existing `/tmp` mount.

Prerequisites: passwordless SSH into the node as root (`ssh-copy-id
root@<pve-host>`).

The remaining steps in this section are preserved as a manual fallback —
useful for partial runs, debugging, or environments where you'd rather see
exactly what's being changed. `cf bootstrap` does all of them for you.

---

### Manual steps (reference)

SSH into the node and run these commands.

### 1. Create an API token

```sh
pveum user token add root@pam cofoundry --privsep=0
```

Copy the token secret (shown once) — you'll need it for the repo secrets or `.env`.

### 2. Install Packer

Packer runs **on the node** so its HTTP server is reachable by build VMs over the bridge.

```sh
wget -O- https://apt.releases.hashicorp.com/gpg \
  | gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] \
  https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
  > /etc/apt/sources.list.d/hashicorp.list
apt-get update && apt-get install -y packer
```

### 3. Install `awscli` (for R2 upload)

> Skip if you're not uploading artifacts to R2 / S3.

The vzdump post-processor runs the upload command derived from `[upload]` on
the node, so the `aws` binary must exist there:

```sh
apt-get install -y awscli
```

`cf build` forwards `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, and `AWS_DEFAULT_REGION` from your local env (or repo secrets in CI) into the remote Packer environment automatically — no config files needed on the node.

### 4. ISO cache directory

Recipes download their boot ISO into `/var/lib/vz/template/iso` (Proxmox's standard ISO storage — already exists on any node). The first build for each recipe downloads its ISO here automatically; subsequent builds skip the download.

### 5. NAT bridge for ISO-installer builds

All current recipes are ISO installers and need this bridge. It can be skipped
only for a custom recipe that boots an already-installed image and does not need
the build-network allocator.

ISO installers can't rely on the qemu-guest-agent for IP discovery and Windows
has no agent during install at all. Cofoundry runs them on a dedicated NAT bridge
(`vmbr1` by default) and allocates a per-build static DHCP reservation from the
bridge's live IPv4 `/24` at build time (see `src/build/netslot.ts`). Existing
bridges and non-overlapping dnsmasq pools are adopted. The allocator selects a
free contiguous 50-address block outside existing DHCP ranges and static hosts.
The manual configuration below shows the default for a new bridge. Up to 50
builds can run in parallel on a single node.

**Add to `/etc/network/interfaces`:**

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

**Apply without rebooting:**

```sh
ifup vmbr1
```

**Install dnsmasq:**

```sh
apt-get install -y dnsmasq
```

**Create `/etc/dnsmasq.d/vmbr1-nat.conf`:**

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

Per-build reservations get written under
`/etc/dnsmasq.d/cofoundry-hosts.d/` during the build and cleaned up afterward —
no manual entries needed.

### 6. Weekly cleanup cron

Prevents ISOs, dump files, and orphaned VMs from accumulating over time.
Everything the old inline shell script did now lives in `cf prune`, so the
cron is just one line. From a workstation that can reach the node:

```
0 3 * * 0 cd /path/to/cofoundry && bun run cf prune --days 30
```

Or on the node itself if you have the repo checked out there. CI also runs
`cf prune --days 7` once after each build workflow. Prune honors active run
leases, VM media references, and age cutoffs, so it can safely overlap a build
from another workflow. The cron is only needed if you build locally.

Run `cf prune --dry-run` first to see what would be removed.

---

## Part 2 — GitHub Actions (production)

### 1. Add an SSH key

GitHub Actions needs to SSH into the node. Generate a dedicated key pair **on your workstation**:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/cofoundry_ci -N ""
```

Authorize it on the node:

```sh
ssh-copy-id -i ~/.ssh/cofoundry_ci.pub root@<pve-host>
# or manually: cat ~/.ssh/cofoundry_ci.pub | ssh root@<pve-host> "cat >> ~/.ssh/authorized_keys"
```

> **Using Tailscale SSH?** You can skip this step. If `SSH_PRIVATE_KEY` is
> unset, the workflow's key-setup step is skipped and the runner authenticates
> to the node via Tailscale SSH (the `Connect to Tailscale` step runs first).
> Requires a tailnet ACL `ssh` rule with `action: "accept"` granting `tag:ci`
> access to the node as the user `SSH_TARGET` connects as (e.g. `root`).
> `action: "check"` rules won't work — they require interactive reauth.

### 2. Tailscale (optional)

If the node sits on a tailnet and you've closed its public SSH port, the
workflow can reach it over Tailscale. The `Connect to Tailscale` step uses
an OAuth client to spin up an ephemeral tagged node per job.

**a. ACL tags + SSH rule** (Tailscale admin → **Access Controls**):

```hujson
"tagOwners": {
  "tag:cofoundry": ["autogroup:owner"],
},
"ssh": [
  { "action": "accept", "src": ["tag:cofoundry"], "dst": ["tag:cofoundry"], "users": ["root"] },
],
```

Tag the PVE node `tag:cofoundry` (admin → **Machines** → node → Edit ACL
tags). Tagging detaches the node from your user — fine for a server, but
add a separate rule if you also want to SSH from your laptop via Tailscale
SSH. Must be `action: "accept"` — `"check"` requires interactive reauth and
won't work in CI.

**b. Create the OAuth client** (admin → **Settings → OAuth clients →
Generate**):

- Scopes: **`Auth Keys` → Write** (the action mints an ephemeral auth key per run; `devices:core` alone is not enough and produces a 403).
- Tags: `tag:cofoundry` (the client can only mint keys for tags selected here; not editable after creation — recreate the client if you missed one).
- Copy the client ID and secret (secret is shown once).

**c. Set repo secrets** (Settings → Secrets → Actions):

| Secret               | Value               |
| -------------------- | ------------------- |
| `TS_OAUTH_CLIENT_ID` | OAuth client ID     |
| `TS_OAUTH_SECRET`    | OAuth client secret |

If your tag isn't `tag:ci`, also set a repo **variable** (Settings → Variables → Actions):

| Variable | Value                                                                                |
| -------- | ------------------------------------------------------------------------------------ |
| `TS_TAG` | Tag the OAuth client is scoped to, e.g. `tag:cofoundry`. Default if unset: `tag:ci`. |

The tag here must match (a) the tag in your `tagOwners` ACL block, (b) the tag your OAuth client is scoped to, and (c) the `src` of the SSH rule. A 403 "calling actor does not have enough permissions" from the `Connect to Tailscale` step means these are out of sync.

**d. Point `SSH_TARGET` / `PVE_HOST` at the tailnet address** — MagicDNS
name (`root@pve.tail-scale.ts.net`) or the 100.x IP. With Tailscale SSH
enabled on the node, you can also omit `SSH_PRIVATE_KEY` entirely; the
workflow skips the key-setup step and auth is brokered by the tailnet.

Tailscale MagicDNS on the Proxmox node does not affect Cofoundry builds, but it
can affect VMs later cloned from the templates. See
[Cloning a template](usage.md#cloning-a-template).

### 3. Create a registry-writer GitHub App (optional)

The workflows update two generated files on `main`:

- `registry.json` after a successful template build
- `upstream-checksums.json` after the scheduled upstream check

By default they push these with the built-in `GITHUB_TOKEN`, so **you can skip
this section entirely** unless `main` is protected by a branch ruleset — a
ruleset the default `GITHUB_TOKEN` cannot bypass. In that case, create a
dedicated GitHub App and add it to the ruleset bypass list; the workflows use
the App token when `REGISTRY_APP_CLIENT_ID` / `REGISTRY_APP_PRIVATE_KEY` are set
and fall back to `GITHUB_TOKEN` when they are not.

**Create the app** (GitHub account/org → **Settings → Developer settings → GitHub Apps → New GitHub App**):

- Name: `cofoundry-registry-writer`
- Webhook: disabled
- Repository permissions: **Contents: Read and write**
- Install it on this repository only

After creating the app, copy its client ID and generate a private key. Generating
the key downloads a `.pem` file to your machine (GitHub shows it only once — if
you lose it, generate a new one). Add both as repo secrets in the next step:

- `REGISTRY_APP_CLIENT_ID` — the client ID (e.g. `Iv23li...`) shown on the app's
  settings page. Note this is **not** the numeric app ID.
- `REGISTRY_APP_PRIVATE_KEY` — the **entire contents** of the downloaded
  `.pem` file, including the `-----BEGIN RSA PRIVATE KEY-----` and
  `-----END RSA PRIVATE KEY-----` lines and every newline between them. Paste
  it verbatim; do not strip the header/footer or collapse it to one line. On
  the command line you can pipe it straight in:

    ```sh
    gh secret set REGISTRY_APP_PRIVATE_KEY < ~/Downloads/cofoundry-registry-writer.*.private-key.pem
    ```

**Allow it through the branch ruleset** (repo → **Settings → Rules → Rulesets**):

- Open the branch ruleset that protects `main`
- Add a bypass entry for the `cofoundry-registry-writer` integration
- Save the ruleset

GitHub rulesets cannot allow bypass for only specific paths, so this app can
bypass the branch ruleset for the whole branch. The workflows still stage only
`registry.json` or `upstream-checksums.json` before pushing.

### 4. Commit `cofoundry.toml`, then set repo secrets

Non-secret deployment config (ports, storage, bridges, upload layout) lives in
the committed **`cofoundry.toml`** — CI checks it out and reads it directly, so
it is **not** duplicated into repo Variables. Sensitive coordinates in that file
use `${VAR}` and are supplied from the environment below.

Commit a `cofoundry.toml` (see [Part 3](#part-3--local-development-optional) or
run `cf init`). Its `[upload]` block controls the R2 layout — `layout = "grouped"`
produces `templates/{{group}}/{{recipe}}-{{arch}}/{{sha256}}{{ext}}`; see
[Usage → CDN upload](usage.md#cdn-upload).

Then go to **Settings → Secrets and variables → Actions**.

**Secrets** (Secrets tab):

| Secret                     | Value                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `PVE_TOKEN_SECRET`         | Token secret from Part 1 step 1                                                                                                             |
| `SSH_PRIVATE_KEY`          | Contents of `~/.ssh/cofoundry_ci`. Omit if using Tailscale SSH.                                                                             |
| `TS_OAUTH_CLIENT_ID`       | Tailscale OAuth client ID (only if using Tailscale)                                                                                         |
| `TS_OAUTH_SECRET`          | Tailscale OAuth secret (only if using Tailscale)                                                                                            |
| `R2_ACCESS_KEY_ID`         | R2 API token access key                                                                                                                     |
| `R2_SECRET_ACCESS_KEY`     | R2 API token secret                                                                                                                         |
| `REGISTRY_APP_CLIENT_ID`   | Client ID for the `cofoundry-registry-writer` GitHub App. Only if `main` is ruleset-protected (see §3); omit to push with `GITHUB_TOKEN`.   |
| `REGISTRY_APP_PRIVATE_KEY` | Private key for the `cofoundry-registry-writer` GitHub App. Only if `main` is ruleset-protected (see §3); omit to push with `GITHUB_TOKEN`. |

**Coordinates referenced by `${VAR}` in `cofoundry.toml`.** Set each as a repo
**Variable** (visible/reviewable) or a **Secret** if you'd rather hide it — the
workflow reads `vars.X || secrets.X`, so set it in one place, not both:

| Name           | Value                                              |
| -------------- | -------------------------------------------------- |
| `PVE_HOST`     | Proxmox hostname or IP (or tailnet IP)             |
| `SSH_TARGET`   | e.g. `root@pve.example.com` or `root@<tailnet-IP>` |
| `PVE_NODE`     | Proxmox node name (shown in the web UI sidebar)    |
| `PVE_TOKEN_ID` | `root@pam!cofoundry`                               |
| `R2_ENDPOINT`  | `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `R2_BUCKET`    | R2 bucket name, e.g. `cofoundry-templates`         |

> These are only the fields your `cofoundry.toml` writes as `${VAR}`. If you
> inline any of them as a literal in `cofoundry.toml` instead, drop it here.

**Parallel builds (optional).** GitHub Actions and the Proxmox node have
separate controls:

- `CF_CI_MAX_PARALLEL` limits how many recipe jobs GitHub starts at once.
- The memory and CPU budgets limit how many of those jobs the Proxmox node
  admits at once. They are total node-wide budgets, not per-VM allocations.

Set these in the repo **Variables** tab:

| Name                        | Value                                                               |
| --------------------------- | ------------------------------------------------------------------- |
| `CF_CI_MAX_PARALLEL`        | Maximum GitHub matrix fan-out; defaults to `4`                      |
| `CF_BUILD_MEMORY_BUDGET_MB` | Node-wide build/verify RAM budget; defaults to 80% of RAM           |
| `CF_BUILD_CPU_BUDGET`       | Total concurrent VM vCPUs; defaults to the host's logical CPU count |

For example, a matrix cap of `4`, a memory budget of `16384`, and a CPU budget
of `8` allow GitHub to start four recipe jobs while the node admits only the
combination whose declared recipe resources fit within 16 GiB and 8 virtual
CPUs. If the budgets are unset, Cofoundry uses 80% of physical RAM and all host
CPUs. The node-side lease manager remains the authoritative admission control;
duplicate recipes are serialized separately, and registry/checksum writers
share one global publication queue.

For a local `cf build` containing multiple recipes, configure parallelism in
`cofoundry.toml` instead:

```toml
[build]
concurrency = 4
memory_budget_mb = 16384
cpu_budget = 8
```

Both budgets are required when local `concurrency` is greater than `1`. The
equivalent one-off command is:

```sh
cf build --build-concurrency 4 --build-memory-budget 16G --build-cpu-budget 8
```

`build.concurrency` does not control the GitHub matrix; use
`CF_CI_MAX_PARALLEL` for that. See [Usage → Build everything](usage.md#build-everything)
for the complete runtime behavior.

**Tailscale** (only if using Tailscale — Variables tab):

| Variable | Value                                                          |
| -------- | -------------------------------------------------------------- |
| `TS_TAG` | Tag the OAuth client is scoped to. Default if unset: `tag:ci`. |

Everything else — `PVE_PORT`, `PVE_DUMP_DIR`, `CF_STORAGE`, `CF_ISO_STORAGE`,
`CF_BRIDGE`, and the entire upload layout — now comes from `cofoundry.toml`. Run
`cf config` locally to see exactly what resolves and from where.

---

## Part 2.5 — Cloudflare R2 bucket

### 1. Create the bucket

In the Cloudflare dashboard: **R2 → Create bucket**, name it (e.g. `cofoundry-templates`), default region.

### 2. Bind a custom domain

**R2 → Bucket → Settings → Custom Domains → Connect Domain.** Use a subdomain
you control, e.g. `templates.example.com`, and set it as `[upload].public_url`
in `cofoundry.toml`. With the grouped layout, final artifact URLs look like:

```
https://templates.example.com/templates/<group>/<recipe>-<arch>/<sha256>.qcow2
https://templates.example.com/registry.json
```

`{{ext}}` is what makes one key template serve every file a template ships: a
system disk (`.qcow2`), an EFI varstore on OVMF recipes (`.efivars.raw`), and
the sidecar (`.json`), each content-addressed by its own hash.

### 3. Create an R2 API token

**R2 → Manage R2 API Tokens → Create API token.** Scope: object read/write on the bucket. Save the access key id + secret as `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`. The S3 endpoint shown on that page is your `R2_ENDPOINT`.

### 4. Configure a lifecycle rule (safety net)

**R2 → Bucket → Settings → Object Lifecycle Rules → Add rule:** prefix `templates/`, delete after 60 days. This catches orphans whose recipe was deleted. The build pipeline also runs `cf prune --r2 --keep 5` for tight per-recipe windows.

`--keep` counts **generations**, not objects: a schema-2 template is a sidecar
plus the images it names, so retention reads each sidecar and keeps the images
the newest `keep` of them reference. Images matching no surviving generation are
deleted, including ones orphaned by a half-finished publish; an image two
generations still share (an unchanged EFI varstore across rebuilds) survives as
long as either does. Objects that are neither a sidecar nor a recognized image
extension are never touched.

### 5. Path scheme

- Images: `s3://<bucket>/templates/<name>-<arch>/<sha256>.qcow2` and, on OVMF recipes, `…/<sha256>.efivars.raw` — content-addressed, immutable.
- Sidecars: `s3://<bucket>/templates/<name>-<arch>/<sha256>.json`, addressed by the **system disk's** hash so each build publishes a distinct key rather than overwriting the last. That history is what `cf publish --r2` picks newest-per-template from and what `cf prune --r2` retains N of.
- Registry: `s3://<bucket>/registry.json` — short TTL (60s), one canonical pointer file. `git log registry.json` is the audit log; rollback = `git revert` the commit, CI re-mirrors.

---

## Part 3 — Local development (optional)

Only needed if you want to run `cf` commands manually from your machine.

### 1. Install dependencies

- [Bun](https://bun.sh) 1.x
- The OpenSSH `ssh` client on your `PATH` (pre-installed on macOS/Linux)

That is the whole list — no local `rsync` or `tar`. Cofoundry intentionally
avoids both: the repository is archived in-process and uploaded to the node
over SFTP, so the CLI works the same on every platform. See
[Architecture → Repository snapshots](architecture.md#repository-snapshots-and-platform-support).

**Windows workstations.** `cf` runs natively on Windows via Bun — no WSL or
Cygwin required. Any `ssh.exe` on `PATH` works: the one bundled with
[Git for Windows](https://gitforwindows.org/) or Windows' built-in OpenSSH
client. SFTP transfers authenticate through your SSH agent when
`SSH_AUTH_SOCK` is set and otherwise fall back to the default key files
(`~/.ssh/id_ed25519`, `~/.ssh/id_rsa`, `~/.ssh/id_ecdsa`), so keep the node
key at one of those paths or load it into an agent that exports
`SSH_AUTH_SOCK` (e.g. `ssh-agent` in Git Bash). One caveat: `cf upload`
without `--remote` runs the upload command through `bash -c`, so it needs a
`bash` on `PATH` (Git for Windows provides one).

### 2. Clone and install

```sh
git clone <repo-url> cofoundry
cd cofoundry
bun install
```

### 3. Set up passwordless SSH

```sh
ssh-copy-id root@<pve-host>
ssh root@<pve-host> hostname   # verify: no password prompt
```

On Windows, run `ssh-copy-id` from Git Bash, or append the key manually:

```sh
cat ~/.ssh/id_ed25519.pub | ssh root@<pve-host> "cat >> ~/.ssh/authorized_keys"
```

### 4. Configure

Configuration splits into two files:

- **`cofoundry.toml`** (committed) — non-secret deployment facts: node
  coordinates, storage pools, bridges, upload layout. This is the single source
  of truth shared by your laptop and CI.
- **`.env`** (gitignored) — secrets (`PVE_TOKEN_SECRET`, R2 keys) plus any
  coordinate the committed `cofoundry.toml` sources via `${VAR}`.

If the repo already ships a `cofoundry.toml`, just supply the secrets:

```sh
cp .env.example .env      # then fill in PVE_TOKEN_SECRET etc.
```

Starting fresh? Scaffold the config file:

```sh
cf init            # writes a commented cofoundry.toml template
cf init --from-env # or fill it from an existing .env
```

Non-secret per-machine overrides go in **`cofoundry.local.toml`** (gitignored),
which layers on top of `cofoundry.toml`. Resolution order (highest wins):

```
CLI flag  >  env / .env  >  ${VAR}  >  cofoundry.local.toml  >  cofoundry.toml  >  default
```

### 5. Verify

```sh
cf config    # show every resolved value and where it came from
cf doctor    # preflight: SSH, PVE API auth, R2 credentials
cf list      # should print all available recipes
```
