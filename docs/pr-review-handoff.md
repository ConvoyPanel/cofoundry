# PR Review Handoff

_Snapshot for resuming the open-PR review/merge work. Refreshed 2026-07-22
against live GitHub + PR branches. Supersedes the 2026-07-19 snapshot (that PR
set, #14–#26, has all closed/merged; the three PRs below are unrelated)._

## TL;DR

- **Three open PRs, all from `gabbelitoV2`:** #28, #29, #30. All fork from the
  same base `b24c7762`; `main` has since advanced 4 commits.
- **#28 is partly landed and should be CLOSED, not merged.** Two of its three
  commits were cherry-picked onto local `main`; the third conflicts and is
  superseded. Details below.
- **#29 and #30 are clean and merge-ready** (verified merge-clean against
  `main`). Not yet actioned.
- **Nothing is pushed.** Local `main` is 4 commits ahead of `origin/main`
  (`c916e99`). Everything this session is local only.
- **One new source fix (ours) is on local `main` but UNVERIFIED on a live
  build** — the Ubuntu root-key-leak fix. See caveats.

## Local `main` state (ahead of `origin/main` by 4 commits — not pushed)

```
443e369  fix(recipes): strip build-time authorized_keys …   (author: gabriel engvall)   ← cherry-picked from #28
b3a2f64  fix(verify): attach qm set values with = …          (author: gabriel engvall)   ← cherry-picked from #28
b76ee2e  Merge: Ubuntu build SSH key injected per-user…      (our source fix, --no-ff)
81de6a7  fix(ubuntu): inject build SSH key per-user, off root
── origin/main ──
c916e99  docs: record #6 diagnostic …
```

The two cherry-picks preserve gabriel engvall as **author** (Eric Wang as
committer — git's normal record for applying another's commits). The Ubuntu fix
lives on branch `fix/ubuntu-no-root-key-leak` (`81de6a7`), merged `--no-ff`.

## Open PRs (ground truth as of this refresh)

| PR  | Title | Status |
|-----|-------|--------|
| #30 | docs(windows): record live-build verification | **Clean, merge-ready.** Docs-only. Records two *unfixed* Windows defects (see below). |
| #29 | fix(update): match uppercase sha256 pins | **Clean, merge-ready.** Preventive (no recipe is currently pinned uppercase). Well-tested. |
| #28 | fix(verify): unbreak post-template smoke tests | **CLOSE, don't merge.** 2 of 3 commits cherry-picked to local `main`; 3rd conflicts + is superseded. |

## What we did to #28 (three file-clean commits, handled individually)

| #28 commit | Files | Disposition |
|------------|-------|-------------|
| `c06cb04a` cloud-init-done exit-2 | `src/verify/checks/linux.ts`, `tests/verify-checks.test.ts` | **DROPPED.** Superseded by `main`'s `d533f00`; test-merge conflicts on `linux.ts`. |
| `9c702893` `qm set` leading-dash `--opt=value` | `src/verify/clone.ts`, `tests/verify-clone.test.ts` | **Cherry-picked** → `b3a2f64`. Clean, self-contained, real Proxmox Getopt bug. |
| `d992ac1b` strip build authorized_keys | `recipes/_shared/cloud-init-cleanup.sh` | **Cherry-picked** → `443e369`. Kept as-is (see `/home/*` note). |

**On the `/home/*` glob in the cleanup commit:** it also strips the `packer`
user's key mid-build, and three provisioners (incl. a `file` upload) still run
after it — works only via SSH per-connection auth reuse, so it's fragile. But it
is NOT redundant: the recipe teardown is `userdel --remove --force packer ||
true`, and the `|| true` means a failed userdel would otherwise ship
`/home/packer`'s key. The `/home/*` strip is the backstop for that path, so it
was **kept**. (Reversed an earlier "trim it" recommendation after finding the
`|| true`.)

**Why #28 must be CLOSED once `main` is pushed:** GitHub will see `9c702893` and
`d992ac1b` as already merged; only the dropped `linux.ts` commit remains. Merging
the PR would try to reintroduce the conflicting/superseded hunk. Close with a
one-line note pointing at `b3a2f64` / `443e369` and `d533f00`.

## Our Ubuntu root-key-leak fix (on local `main`, UNVERIFIED live)

`81de6a7` + merge `b76ee2e`. Rewrites all four `recipes/ubuntu-*/http/user-data`
(kept byte-identical per `recipe-consistency.test.ts`) to stop the build's
ephemeral SSH key leaking into `/root/.ssh/authorized_keys`.

- **Root cause:** Ubuntu was the only family routing the key through cloud-init's
  ssh module (top-level `ssh.authorized-keys` = an *instance* public key), which
  cloud-init also plants in root as a neutered `disable_root` stub. Debian
  (preseed late_command) and Alma/Rocky (kickstart) write the key directly and
  never leak. This is what `no-foreign-authorized-keys` flags on every Ubuntu leg.
- **Fix:** create `packer` at install time via Subiquity `identity:` (locked
  password, deleted before export), install the key + a `NOPASSWD` sudoers file
  in late-commands, add `openssh-server` to `packages:`. Mirrors Debian/Alma.
- **Backstop retained:** #28's `/root` strip in `cloud-init-cleanup.sh` still
  scrubs it on rebuild regardless.
- **UNVERIFIED assumptions (must confirm on next live Ubuntu build; documented in
  `docs/recipes.md#ubuntu-autoinstall`):** (1) Subiquity accepts
  `identity.password: "!"`; (2) `/home/packer` exists when `late-commands` run so
  the key write lands `packer`-owned; (3) Packer's key login succeeds on the
  post-install reboot. An SSH timeout on that build = one of these failed.

## Verification run this session

- `bun test` → **359 pass, 0 fail**; `bun run typecheck` clean; prettier clean;
  `bash -n cloud-init-cleanup.sh` OK; all four Ubuntu `user-data` parse as YAML.
- `recipe-consistency.test.ts` passes (four Ubuntu files byte-identical).

## #30 records two *unfixed* Windows defects (follow-ups, not blockers)

#30 is docs-only and correct to merge, but the defects it documents remain live:
1. **Clone Administrator password is the deleted per-build secret** —
   oobeSystem's seeded `AdministratorPassword` overwrites cloudbase's cipassword;
   clones ship unusable Administrator creds (workaround: `qm guest exec … net
   user`). Needs a real fix (stop seeding a secret / re-arm SetUserPassword /
   move cloudbase out of specialize).
2. **Boot-keypress `<enter>` blanket** can press Setup's Cancel and open a
   quit-modal, stalling ~1-in-N Windows builds until `winrm_timeout`. Candidate
   fix (use `<up>`) noted but not applied.

## Decisions / next steps still open

1. **Push `main`?** (4 commits, incl. the unverified Ubuntu fix.) Nothing pushed
   yet this session.
2. **Merge #29 and #30** (both clean) — via UI or fold into the `main` push.
3. **Close #28** with the explanatory note once its two commits are on
   `origin/main`.
4. **File follow-ups** for the two #30 Windows defects.
5. **Schedule a live Ubuntu build** to verify the `identity`/late-command fix
   before trusting it in production templates.
