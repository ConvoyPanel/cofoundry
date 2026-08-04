# Debugging builds without burning hours

A Windows build takes ~1–3 hours and its provisioners only run at the very end,
so a naive debugging loop costs one hypothesis per three hours. On 2026-08-03
that loop cost **four consecutive failed 2025 builds that produced no
diagnosis at all** — roughly twelve hours to learn nothing.

Everything here exists to attack that. The ordering is deliberate: **shorten the
feedback loop before hunting the bug.** Almost every technique below pays for
itself within one avoided rebuild.

For the automated evidence bundle a failed build leaves behind, see
[diagnostics.md](diagnostics.md). This document is about what to do by hand,
and about writing code that explains itself the next time.

---

## 1. Keep the failing VM alive

Packer deletes the build VM within seconds of a provisioner erroring. Before you
kill a build worth understanding:

```sh
qm set <vmid> --protection 1     # packer's destroy now fails; the VM survives
```

This is the single highest-leverage trick in this document. It converts
"3 hours per hypothesis" into "minutes per hypothesis", because you can test
candidate fixes against the actual failing guest instead of guessing and
rebuilding. The 2026-08-03 Appx root cause was found this way after four blind
rebuilds had failed to find it: three candidate fixes were tried against the
preserved guest in about ten minutes.

Remember to clear it when done, or the VMID cannot be reused:

```sh
qm set <vmid> --protection 0 && qm stop <vmid> && qm destroy <vmid> --purge
```

## 2. Talk to the live guest

```sh
qm guest exec <vmid> --timeout 60 -- powershell -NoProfile -Command '<script>'
```

- There is **no `--output-format` option.** Passing one makes every call fail.
  (Two hours were lost to this once, logging `<agent-unavailable>` throughout.)
- Output is JSON with the guest's stdout in `out-data`. **Parse it with
  `python3`, not `sed`** — the payload contains escaped quotes and CRLFs.
- For anything with quoting, write the script to a file and send it
  base64-encoded, which removes every nested-quoting decision:

  ```sh
  ENC=$(iconv -f UTF-8 -t UTF-16LE /root/probe.ps1 | base64 -w0)
  qm guest exec <vmid> --timeout 120 -- powershell -NoProfile -EncodedCommand "$ENC"
  ```

- **The agent is not a health signal.** It answers while Setup sits at an error
  dialog, and it goes unresponsive for minutes under load. "Agent up" proves
  nothing about whether the guest is progressing.
- **Validate the shape of what comes back.** After a timed-out call, `qm guest
  exec` can return a *different* command's `out-data` — once dumping megabytes
  of CBS log into a disk-usage timeline. Have the script emit a known prefix and
  reject replies that lack it.

## 3. Is the guest hung, or just slow?

A blank console framebuffer is not evidence of a hang — a booting Windows guest
shows one for minutes. Ask the hypervisor whether the VM is doing work:

```sh
P=$(qm list | awk '$1==<vmid>{print $6}')
cat /proc/$P/stat | awk '{print "utime="$14" stime="$15}'   # sample twice, 3s apart
grep -E 'read_bytes|write_bytes' /proc/$P/io                 # sample twice
```

Rising CPU jiffies and rising I/O mean it is grinding, not wedged. A 2025 clone
spent several minutes at ~80% of 4 cores during first-boot specialize with a
black screen throughout, and still finished inside verify's 900s window.

## 4. Parse-check PowerShell locally — it is nearly free

`Finalize.ps1` runs only inside a Windows guest, ~3 hours in, as the last
provisioner before sysprep. A syntax error there is caught by *nothing* else:
packer uploads the file verbatim and the guest fails at parse time. The cost of
finding out used to be a full rebuild.

PowerShell runs on Linux, including arm64. Install once:

```sh
curl -fsSL https://github.com/PowerShell/PowerShell/releases/download/v7.4.6/powershell-7.4.6-linux-arm64.tar.gz \
  -o /tmp/pwsh.tar.gz          # or -linux-x64.tar.gz; check `uname -m` first
sudo mkdir -p /opt/pwsh && sudo tar -xzf /tmp/pwsh.tar.gz -C /opt/pwsh
sudo chmod +x /opt/pwsh/pwsh && sudo ln -sf /opt/pwsh/pwsh /usr/local/bin/pwsh
```

Then a whole-tree check costs milliseconds:

```sh
pwsh -NoProfile -Command '
Get-ChildItem -Recurse -Filter *.ps1 recipes/ | ForEach-Object {
  $e = $null
  [System.Management.Automation.Language.Parser]::ParseFile($_.FullName, [ref]$null, [ref]$e) | Out-Null
  if ($e.Count) { $e | ForEach-Object { "{0} line {1}: {2}" -f $_.Extent.File, $_.Extent.StartLineNumber, $_.Message } }
}'
```

`tests/windows-ps-syntax.test.ts` runs exactly this and **skips cleanly when
`pwsh` is absent**, so it costs nothing on a machine without it. Installing
`pwsh` is strongly recommended for anyone touching `recipes/_shared/windows/`.

`pwsh` is also the fastest way to check what a PowerShell expression actually
does — operator precedence, format strings, `-f` binding, regex behaviour —
without a guest in the loop.

## 5. Make the failure explain itself

The rule: **anything that fails inside a guest must report through the one
channel that outlives the guest — packer's stdout.**

An error message that says "check `C:\...\setuperr.log`" is useless advice when
the VM holding that log is deleted seconds later. Two 3h04m builds died that way
before `Finalize.ps1` was taught to dump `setuperr.log`/`setupact.log` and the
arming registry state into its own output, per failed attempt (dumping only
after the loop loses attempt 1, because attempt 2 overwrites `Panther`).

When a step retries, dump on **each** failure, not once at the end.

## 6. Silence must never be a valid state

If "working normally" and "died" look the same, you cannot tell them apart under
pressure. Two instances of this bit us in one day:

- A `grep` filter that matched only success markers would have stayed silent
  through a crashloop. Monitor filters must match **every terminal state**, so
  widen the alternation rather than narrow it.
- A node-side watcher collapsed repeated "guest agent down" lines into one, so a
  dead watcher and a busy guest produced identical logs. Fixed by heartbeating
  every 15th poll: silence now means only one thing.

## 7. Distrust probes that cannot distinguish the states you care about

Two real examples, both of which produced confident wrong conclusions:

- `Get-ChildItem -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object
  Length -Sum` returns **0 for an ACL-protected populated tree**, identically to
  an empty one, because the errors are silenced. Count enumeration errors before
  believing a size.
- Reading free space *after* deleting a multi-GB file races NTFS's reclaim: the
  same code logged "13.9 GB free" and "1.0 GB free" on consecutive runs. Worse,
  neither value could distinguish "13 GB was zeroed and released" from "nothing
  was written". Report the thing you are responsible for — bytes written.

Before trusting a probe, ask: *what would this print in the failure case?* If the
answer is "the same thing", it is not a probe.

## 8. Guard every fix, and negative-control every guard

A guard that cannot fail is worse than none — it produces false confidence. One
here asserted `toContain('allow_reboot=false')`, which matched a *comment*; the
setting could be deleted and the test still passed.

So after writing a guard, **break the code and watch the test fail**, then
restore:

```sh
cp file file.bak
perl -0pi -e 's/<the line the guard protects>//' file
bun test <the test>        # MUST fail
cp file.bak file
bun test <the test>        # MUST pass
```

For PowerShell and shell assets that have no runtime in the test process, a
static guard over the file's text is legitimate — say so in the test comment, so
nobody mistakes it for a behavioural one.

## 9. Pick the cheapest test that can falsify the hypothesis

Rough costs on this project:

| Method | Cost | Good for |
| --- | --- | --- |
| `bun test` / `pwsh` parse | seconds | syntax, invariants, orderings |
| `qm guest exec` on a preserved VM | seconds | guest state, candidate fixes |
| Offline image inspection (`qemu-nbd` + mount, `reged`) | ~5 min | what a built artifact actually contains |
| Restore + boot + `qm agent ping` | ~10 min | does a clone come up at all |
| `cf verify` | ~15 min | the full check battery |
| Full build | 1–3 h | last resort |

A direct boot test beats `cf verify` for *diagnosis* — it is faster and has no
battery to time out. Use `cf verify` to prove a thing works, not to find out why
it does not.

## 10. Operational traps that cost real time here

- **`pkill -f <pattern>` can kill your own SSH session**, because the session's
  argv contains the pattern you just typed. It happened twice. Match the
  executable and kill by PID:

  ```sh
  ps -eo pid,args --no-headers | awk '$2 ~ /^\/usr\/bin\/packer$/ {print $1}' | xargs -r kill -9
  ```

  Equally, `ps ... | awk '$2 ~ /script\.sh/'` matches nothing when `$2` is
  `/bin/bash` — that silently failed to kill a watcher and a second copy was
  started, interleaving two formats into one log.
- **Track guest VMs by NAME, never VMID** — cf derives the VMID from the netslot,
  so a retry changes it. A capture pinned to a VMID watched the wrong machine
  through five failures.
- **Run one `cf` operation at a time.** Two concurrent runs recycle the same
  scratch VMID, and the first run's delayed cleanup destroys the second's VM.
- **`cf` retries resurrect a killed build** (attempts 2/3, 3/3). A build that
  "reappears" with PPID 1 is usually that, not a stray.
- **Check for another agent/session** before blaming infrastructure:
  `ps -eo args | grep claude`.
- **`scp` to the node fails**; pipe instead: `ssh root@node 'cat > /path' < file`.
- **Do not run `cf clean`** casually — it removes uploaded ISOs, including large
  ones you will wait to re-download.
- The node→local artifact download runs at ~1 MB/s over the tailnet (vs ~12 MB/s
  for the node's own internet fetch). `cf verify` reads the artifact **from the
  node**, so that download never blocks verification; it writes to a `.tmp` and
  resumes.

## 11. Read the guest's own logs, in the right order

- **The System event log is the only thing that names a reboot initiator.**
  `setupact.log` and CBS only ever show TrustedInstaller *reacting*. Extract
  `Windows/System32/winevt/Logs/System.evtx` offline and parse with
  `python-evtx` in a venv (system pip is PEP-668 managed).
- **Read the vendor's source rather than inferring behaviour.** `msiextract` on
  the cached Cloudbase-Init MSI settled two questions that had each cost a build
  cycle.
- **A long warning list is not a severity signal.** One image listed 41
  "blocking" Appx packages and sysprep objected to exactly one of them.
