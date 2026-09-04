# Failure diagnostics

Packer deletes the build VM as soon as a build errors, so there is normally
nothing left to inspect after an SSH/WinRM timeout or a provisioner failure.
Cofoundry preserves evidence by recording the build as it runs and pulling that
record down when a build fails.

The implementation lives in `src/build/diagnostics/`.

## How it works

Each VMID build prepends a **recorder** subshell to the remote build script (a
sibling of `buildVmWatchdog`). While the build runs, the recorder:

- **Screendumps the emulated framebuffer** every few seconds into a ring buffer.
- **Snapshots the recipe's in-guest log area** through the QEMU guest agent —
  cloud-init/subiquity on Linux, Panther/CBS on Windows.

On failure, `cf` pulls the ring buffer down to a local bundle at
`./diagnostics/<recipe>-<arch>-<ts>/` — the same path locally and in CI (see
[CI and secrets](#ci-and-secrets)). Only the most recent 10 run dirs are kept.

## Where the files land

Each failed build produces one bundle directory:

```
diagnostics/<recipe>-<arch>-<ts>/
├── manifest.json        # recipe, arch, vmid, os, attempt, error, what was collected
├── logs/                # scrubbed in-guest logs, one <name>.log per capture
├── frames/              # gzipped framebuffer screenshots — LOCAL RUNS ONLY
└── packer-console.log   # Packer's full durable console output, scrubbed
```

`manifest.json` records exactly what was collected, so `screenshots` reads
`"omitted (CI, public repo)"` on CI runs and a frame count locally.

## Screenshots

The HMP screendump format is `screendump FILE [-f FORMAT]`. PVE's `pve-qemu` is
commonly built without libpng, so the recorder probes PNG once and otherwise
captures PPM.

Raw PPM is ~3 MB/frame, but a text-mode installer console gzips ~70x (~40
KB/frame observed), so PPM frames are gzipped in the ring.

## In-guest logs

Log capture is genuinely useful on Windows, where `qemu-ga` runs during the
update/finalize phases.

During a Linux _autoinstall_ the guest agent isn't up yet — it lives in the
installed system, not the live installer — so those captures are empty and the
screenshots carry the diagnosis instead.

## Storage and safety

- **RAM-backed tmpfs.** The recorder writes to `/run/cofoundry-diag/<vmid>`,
  never to VM storage under `PVE_DUMP_DIR`, so it cannot fill the filesystem
  that holds guest disks and PVE state.
- **Bounded four ways:** an orphan check, a max-lifetime backstop, a free-space
  guard, and a fixed-size ring buffer.
- **Cleaned up** with the per-build secret tree on success, signals, and (after
  collection) failure; a start-of-build sweep reaps anything a SIGKILL left
  behind.

## CI and secrets

The bundle is written to the same `./diagnostics/<recipe>-<arch>-<ts>/` path in
CI, and the `build-one.yml` workflow uploads the `diagnostics/` directory as a
`diagnostics-<recipe>` artifact (7-day retention) on failure. Download it from
the failed workflow run's **Artifacts** section.

**`frames/` never reaches a CI artifact.** Screenshots are unredactable images
and the repository is public. The recorder is not CI-aware — it still screendumps
into the node's tmpfs, and the collector still pulls the whole tree down to the
runner — but in CI the collector deletes the local `frames/` directory before the
manifest is written and the artifact is uploaded. Only the in-guest logs and
Packer console survive, after exact-value scrubbing of the ephemeral build
password. Nothing screenshot-related persists: the node copy is RAM-backed tmpfs
wiped by teardown, and the runner is ephemeral.

Disable the whole feature with `CF_DIAGNOSTICS=0`.
