# sbx kits

Provisioning for running a coding agent in a [Docker Sandbox](https://docs.docker.com/ai/sandboxes/)
(`sbx`) against this repo. sbx has no auto-detection for repo-local kits, so a kit
is just a committed directory you reference explicitly with `--kit`.

## `dev/` — Cofoundry dev environment

Installs [Bun](https://bun.sh) and the tools `cf` shells out to (ssh, rsync, git),
then warms the dependency cache. Cofoundry is a Bun + TypeScript CLI — there's no
local web server, database, or browser; `cf` drives Packer *remotely* on a Proxmox
node over SSH and the Proxmox API.

```sh
sbx run --kit .sbx/dev claude
```

The first run installs Bun and pulls dependencies (slow, once). To make later
starts instant, snapshot the provisioned sandbox into a template:

```sh
sbx template save cofoundry-dev
sbx run -t cofoundry-dev --kit .sbx/dev claude   # Bun install is baked in; startup only re-syncs bun.lock
```

Inside the sandbox (see the kit's `agentContext`, or `.sbx/dev/spec.yaml`):

```sh
bun run cf list                       # list recipes (no node needed)
bun test                              # test suite
bun run typecheck                     # tsc --noEmit
bun run prettier --write src/ tests/  # format before committing
```

Read-only commands (`cf list`) work standalone. Anything that talks to the node
(`cf build`, `cf bootstrap`, `cf prune`) needs a populated `.env` **and** network +
SSH reach to the Proxmox node, which the sandbox does not provide on its own.

## Boundaries

- **Secrets** (`PVE_TOKEN_SECRET`, R2/`AWS_*` keys, etc.) live in the gitignored
  `.env`, mounted into the sandbox — never in a kit.
- **Notifications** and any personal network setup come from global kits in the
  operator's own dotfiles, injected automatically by their `sbx` wrapper; `.sbx/dev`
  is project provisioning only. Multiple `--kit` refs compose, so they layer cleanly.
