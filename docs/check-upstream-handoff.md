# Check-upstream Smoke-test Handoff

_Snapshot for resuming the "Check upstream images" workflow debugging. Written
2026-07-21 against runs #48–#50 on `main`. The workflow rebuilds every template
from fresh upstream cloud images, then runs the verify smoke test against each
exported artifact._

## TL;DR

The "everything is failing" state was **four stacked, independent bugs**, each
masking the next. Fixing one exposed the following one, so the failing set kept
changing shape between runs. Four are fixed and verified; **one remains open**
(a security-check judgment call on Ubuntu).

| #   | Bug                                                                                                                                | Distros hit                             | Status                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------ |
| 1   | Flaky `Run tests` step: the PowerShell parse test spawned `pwsh` once per check and blew bun's 5s per-test timeout on slow runners | random matrix legs                      | ✅ fixed `6edcff5`             |
| 2   | guest-exec disabled by default on RHEL (el8 block-list)                                                                            | almalinux/rocky 8                       | ✅ fixed `c972f6e`             |
| 3   | guest-exec enabler no-op'd on el9/el10 (allow-list) but reported success                                                           | almalinux/rocky 9, 10                   | ✅ fixed `3be5e0b`             |
| 4   | `systemd-healthy` trusted `is-system-running --wait`, ineffective on systemd 239                                                   | el8 (systemd 239)                       | ✅ fixed `90e2e79`             |
| 5   | `cloud-init-done` failed on cloud-init 24.x "degraded done" (exit 2)                                                               | alma-10, rocky-10, debian-13, ubuntu-\* | ✅ fixed `d718868`             |
| 6   | `no-foreign-authorized-keys` flags an unexpected key in `/root/.ssh/authorized_keys`                                               | **ubuntu 22/24/25/26 only**             | ⏳ **OPEN — diagnostic deployed (`7b35243`), awaiting a run to decide** |

After fixes 1–5, the expected outcome of the next run is: **all Debian, all
AlmaLinux, all Rocky green; Ubuntu still red on #6 only.** (Not yet confirmed by a
run — fixes 3–5 and the fix for 5 landed after run #50.)

## Nothing here is a `main`/`Tests` regression

The push-triggered `Tests` workflow on `main` is and was green throughout. All of
this lives in the manually/scheduled **Check upstream images** workflow, which is
the only thing that rebuilds templates from scratch and thus re-derives these
upstream-default behaviours.

## The open item (#6): Ubuntu `no-foreign-authorized-keys`

**Symptom.** On every Ubuntu leg (and only Ubuntu), the first-boot check
`no-foreign-authorized-keys` fails:

```
✗ no-foreign-authorized-keys — no authorized_keys entry other than the injected key (exit 1)
    unexpected key in /root/.ssh/authorized_keys:
      no-port-forwarding,no-agent-forwarding,no-X11-forwarding,com...   (truncated at 60 chars)
```

**What it is.** That option prefix is cloud-init's **disable-root stub**
(`disable_root_opts`), which forces `command="echo 'Please login as the user
\"ubuntu\"...';...;exit 142"`. cloud-init writes it to root's `authorized_keys`
on every boot when `disable_root: true` (the Ubuntu default). It is **inert** —
the forced command prints a message and exits, so it grants no shell.

**Why the check flags it.** The check (`src/verify/checks/linux.ts`,
`no-foreign-authorized-keys`) allows a line only if it contains the
verify-injected key body. This line was flagged, which means the key in the stub
is **not** the injected key. So one of:

- the stub carries a key baked into the upstream Ubuntu cloud image, or
- cloud-init added a datasource/default-user key that verify did not inject.

Could not confirm which: the CI log truncates the line at 60 chars, and the
uploaded `diagnostics-ubuntu-*` artifact contains only a framebuffer screenshot
(`post-reboot.ppm.gz`), not the file.

**Why it wasn't fixed here.** This check exists to catch a build-time key
surviving into a template as a fleet-wide backdoor. Loosening it is a security
decision that should have a maintainer's sign-off, and the exact provenance of
the key is still unconfirmed. Do not blindly weaken it.

**Status — diagnostic is in place, awaiting the next run.** The 60-char
truncation was self-inflicted: the check itself ran `cut -c1-60` on the
offending line (the runner already surfaces a check's full stdout in the CI
log). A **temporary diagnostic** now replaces that truncation
(`no-foreign-authorized-keys` in `src/verify/checks/linux.ts`, commit below): for
each unexpected line it prints the full untruncated line, classifies whether it
matches cloud-init's inert disable-root stub signature
(`command="...Please login as the user...exit 142"`), and prints the line's key
body next to the injected body (MATCHES / DIFFERS). Provenance is therefore
decidable **from the CI job log alone** — no clone-and-`cat` needed.

**To finish the investigation:**

1. Ask the owner to re-run **Check upstream images** (fixes #3–#5 also still need
   a run to confirm — see below). Read the Ubuntu leg's `no-foreign-authorized-keys`
   output in the job log.
2. Decide from the `classified:` / `key-body:` lines:
   - `disable-root stub` + `DIFFERS` → inert upstream stub; apply the recommended
     carve-out below.
   - `NOT the disable-root stub` → a genuinely foreign baked-in key; fix the
     recipe/image, not the check.
3. Once decided, **revert the temporary diagnostic** back to a one-line
   `unexpected key in $f` message — a full key body in the log is only wanted
   while investigating.

**Candidate fixes, once provenance is known:**

- _If it is the inert disable-root stub_ (most likely): scope the check to skip a
  line that is the disable-root stub — match the forced
  `command="...Please login as the user...exit 142"` signature — while still
  failing on any real (optionless or shell-granting) foreign key. Narrow, keeps
  the check's teeth. **Recommended if provenance confirms the stub.**
- _If it is a genuinely foreign baked-in key_: the check is doing its job — fix
  the Ubuntu recipe/source image instead of the check.
- _Do not_ set `disable_root: false` to dodge it — that re-enables root SSH and
  is a security reduction.

## What changed (all on `main`, committed directly per the owner's instruction)

| Commit    | File(s)                                                                                                                      | Change                                                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `6edcff5` | `tests/verify-checks.test.ts`                                                                                                | Batch the PowerShell parse check into one `pwsh` invocation (base64 per script; failing id echoed back). Suite time ~5.1s → ~0.2s.                                                                              |
| `c972f6e` | `recipes/_shared/post/enable-guest-exec.sh` (new), 6 RHEL `*.pkr.hcl`, `docs/recipes.md`, `tests/recipe-consistency.test.ts` | Enable guest-exec on RHEL, run after `dnf update`. el8 block-list + el9/el10 allow-list.                                                                                                                        |
| `3be5e0b` | `recipes/_shared/post/enable-guest-exec.sh`                                                                                  | Fix the el9/el10 branch: scope the RPC membership/verify greps to the active `FILTER_RPC_ARGS=` line, not the whole file (a commented-out example line was matching, so the append was skipped yet "verified"). |
| `90e2e79` | `src/verify/checks/linux.ts`                                                                                                 | Poll `is-system-running` instead of trusting `--wait` (which only waits on systemd ≥ 240; el8 ships 239).                                                                                                       |
| `7b35243` | `src/verify/checks/linux.ts`                                                                                                | **Temporary diagnostic for #6.** Drop the check's own `cut -c1-60`; print the full offending line, a disable-root-stub classification, and a key-body MATCHES/DIFFERS comparison. Revert once #6 is decided.    |
| `d718868` | `src/verify/checks/linux.ts`                                                                                                 | Accept cloud-init "degraded done" (exit 2) in `cloud-init-done`; fail only on fatal (exit 1) / non-done.                                                                                                        |

## Verification methodology (how the above were proven without CI cycles)

Each 15-minute CI leg makes blind iteration expensive, so the guest-side changes
were validated locally with Docker and a real `pwsh`:

- **guest-exec (el8/9/10):** `docker run almalinux:9` / `:10`, install
  `qemu-guest-agent`, apply `enable-guest-exec.sh`, launch `qemu-ga` on a unix
  socket with the edited `FILTER_RPC_ARGS`, and probe it with
  `{"execute":"guest-exec",...}`. Before fix `3be5e0b`: `Command guest-exec has
been disabled`. After: `{"return":{"pid":...}}`. This is also how the
  comment-matching bug (#3) was found — the "before" grep false-matched the
  file's own comments.
- **systemd `--wait` (#4):** confirmed via `systemctl is-system-running --help`
  across `almalinux:8` (239, help covers only "(re)start"), `almalinux:9` (252,
  help explicitly covers is-system-running), so `--wait` is a no-op on el8.
- **PowerShell test (#1):** downloaded PowerShell 7.4.6 (no apt package) to
  un-skip and actually run the test; confirmed it passes (~0.2s) and still
  fails on a deliberately broken script.
- **cloud-init-done (#5):** exercised the new script against a fake `cloud-init`
  returning exit 0/1/2 with various status strings.

Version facts worth keeping: guest-exec RPC filter is `BLACKLIST_RPC` (block) on
el8 and `FILTER_RPC_ARGS="--allow-rpcs=..."` (allow) on el9/el10; the shipped
el9/el10 file documents guest-exec in a commented `--block-rpcs` example, which
is the comment that fooled the first enabler.

## Runs referenced

- #48 `29787769675`, #49 `29794208396`, #50 `29795817527` (repo
  `ConvoyPanel/cofoundry`). #50 is the last full data point; fixes #3–#5 postdate
  it, so trigger a fresh run to confirm.

## How to re-run / confirm

The workflow is `workflow_dispatch` + schedule; it cannot be triggered from the
sandbox. Ask the owner to re-run **Check upstream images**, then re-read the
matrix with:

```
gh run view <run-id> --json jobs   # per-leg conclusions + failing steps
gh api repos/ConvoyPanel/cofoundry/actions/jobs/<job-id>/logs   # full log (works on cancelled runs)
```

Fetch failing-check detail with the `→ ✗` / `✗ <id> — <desc> (exit N)` lines and
the indented captured output.
