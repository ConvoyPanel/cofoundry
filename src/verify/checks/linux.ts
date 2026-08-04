import type { CheckSuite } from '@/verify/checks/types.ts'

/**
 * The middle field of an OpenSSH public key — the part that is identity, with
 * the type prefix and free-text comment stripped. Matching on the body makes
 * the "no foreign keys" check immune to a differing comment.
 */
export const sshKeyBody = (publicKey: string): string =>
    publicKey.trim().split(/\s+/)[1] ?? publicKey.trim()

/**
 * Poll `systemctl is-system-running` until it settles, then report.
 *
 * `--wait` is not usable: it is a no-op on systemd 239 (el8), which is why this
 * polls instead — see docs/check-upstream-handoff.md #4.
 *
 * On failure it prints the journal for each failed unit, not just the
 * `systemctl --failed` one-liner. A unit name and the word "failed" is not a
 * diagnostic: the 2026-08-04 ubuntu-26.04 failure reported exactly
 * `grub2-common.service loaded failed failed Record successful boot for GRUB`,
 * and identifying the cause needed one line the guest already had —
 * `grub-editenv: error: invalid environment block`. Printing it costs nothing
 * on the passing path, which returns before ever reaching this.
 */
const systemdHealthyScript = `i=0
while :; do
  state=$(systemctl is-system-running 2>/dev/null || true)
  case "$state" in
    running) exit 0 ;;
    initializing|starting|'') ;;
    *) break ;;
  esac
  i=$((i + 1)); [ "$i" -ge 60 ] && break
  sleep 3
done
echo "system state: $state"
systemctl --failed --no-pager --no-legend
for u in $(systemctl --failed --no-pager --no-legend --plain 2>/dev/null | awk '{print $1}'); do
  echo "--- journal: $u ---"
  journalctl -b -u "$u" --no-pager -n 20 2>/dev/null ||
    echo '(journal unavailable)'
done
exit 1`

/**
 * Checks that apply to every Linux recipe (Debian, Ubuntu, AlmaLinux, Rocky).
 * Anything distro-specific belongs in a per-recipe suite, not here.
 *
 * Order matters within a phase: the runner executes sequentially, so
 * `cloud-init-done` gates everything that depends on cloud-init having run.
 */
export const linuxSuite: CheckSuite = {
    shell: 'sh',
    // A Linux console at a login prompt is overwhelmingly background pixels, so
    // only a truly uniform frame is meaningful here — and even then the console
    // may legitimately have blanked. Advisory only; the guest-exec checks carry
    // the weight on Linux.
    screenUniformThreshold: 0.9995,
    screenSeverity: 'warn',
    checks: [
        {
            id: 'cloud-init-done',
            description: 'cloud-init reached the done state',
            // --wait blocks until a terminal state. Newer cloud-init (24.x, on
            // el10/debian-13/ubuntu) exits 2 for a recoverable ("degraded")
            // error even when the boot still reached done, where older releases
            // exit 0. `cloud-init-no-errors` is the real error gate, so accept a
            // done/degraded-done outcome and fail only on a fatal error (exit 1)
            // or a status that never reached done.
            script: `out=$(cloud-init status --wait 2>/dev/null); rc=$?
printf '%s\\n' "$out"
[ "$rc" = 1 ] && { echo 'cloud-init reported a fatal error'; exit 1; }
case "$out" in
  *'status: done'*|*'status: degraded done'*) exit 0 ;;
esac
echo 'cloud-init did not reach a done state'
exit 1`,
            severity: 'fail',
            phase: 'first-boot',
            timeoutS: 300,
        },
        {
            id: 'cloud-init-no-errors',
            description: 'no error-level records from any cloud-init unit',
            script: `out=$(journalctl -p err --no-pager --quiet \\
  -u cloud-init-local -u cloud-init -u cloud-config -u cloud-final 2>/dev/null)
[ -z "$out" ] || { printf '%s\\n' "$out"; exit 1; }`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            id: 'hostname-applied',
            description: 'cloud-init applied the injected hostname',
            script: ctx => `want=${ctx.hostname}
got=$(hostname)
[ "$got" = "$want" ] || { echo "hostname=$got want=$want"; exit 1; }`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            id: 'ci-user-exists',
            description: 'cloud-init created the injected user',
            script: ctx => `id ${ctx.ciUser}`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            id: 'ci-sshkey-injected',
            description:
                "injected SSH key landed in the user's authorized_keys",
            script: ctx => `home=$(getent passwd ${ctx.ciUser} | cut -d: -f6)
[ -n "$home" ] || { echo "no home for ${ctx.ciUser}"; exit 1; }
grep -qF '${sshKeyBody(ctx.sshPublicKey)}' "$home/.ssh/authorized_keys"`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            // A build-time key surviving into the template is a fleet-wide
            // backdoor: every VM ever cloned from it accepts the same key. The
            // only key present after cloud-init should be the one verify just
            // injected.
            id: 'no-foreign-authorized-keys',
            description: 'no authorized_keys entry other than the injected key',
            // TEMPORARY DIAGNOSTIC (docs/check-upstream-handoff.md #6): every
            // Ubuntu leg flags a line here whose provenance is unconfirmed
            // because the previous log truncated it at 60 chars. This block
            // emits the full offending line, classifies whether it is
            // cloud-init's inert disable-root stub, and prints the line's key
            // body next to the injected body so the CI log alone decides the
            // fix. Revert to a one-line `unexpected key in $f` once #6 is
            // resolved — a full key body in the log is only wanted while
            // investigating.
            script: ctx => `injected='${sshKeyBody(ctx.sshPublicKey)}'
rc=0
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -f "$f" ] || continue
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
      *"$injected"*) continue ;;
    esac
    echo "unexpected key in $f:"
    echo "  full: $line"
    case "$line" in
      *'command="'*'Please login as the user'*'exit 142'*)
        echo "  classified: cloud-init disable-root stub (inert forced command)" ;;
      *) echo "  classified: NOT the disable-root stub" ;;
    esac
    body=$(printf '%s\\n' "$line" | awk '{for(i=1;i<NF;i++) if($i ~ /^(ssh-|ecdsa-|sk-)/){print $(i+1); exit}}')
    if [ -n "$body" ]; then
      [ "$body" = "$injected" ] && echo "  key-body: MATCHES injected key" \\
                                || echo "  key-body: DIFFERS from injected: $body"
    else
      echo "  key-body: could not parse a key type from the line"
    fi
    rc=1
  done < "$f"
done
exit $rc`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            // The recipes create a throwaway `packer` build user and tear it
            // down with `userdel --remove --force packer || true` — the
            // `|| true` means a failed userdel would silently ship the user,
            // its home (holding the build's authorized key), and its NOPASSWD
            // sudoers grant to every clone. This asserts the teardown actually
            // happened rather than merely not erroring.
            id: 'no-build-user',
            description: 'the throwaway packer build user was fully removed',
            script: `rc=0
if getent passwd packer >/dev/null 2>&1; then
  echo "build user 'packer' still in /etc/passwd"
  rc=1
fi
if [ -e /home/packer ]; then
  echo '/home/packer left behind'
  ls -la /home/packer 2>/dev/null
  rc=1
fi
left=$(grep -rl packer /etc/sudoers.d/ 2>/dev/null)
if [ -n "$left" ]; then
  printf 'packer sudoers entry left behind: %s\\n' "$left"
  rc=1
fi
exit $rc`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            // Verify grows the disk beyond its shipped size before boot, so
            // leftover unallocated space proves growpart did not run.
            //
            // This deliberately measures the *partition table*, not the root
            // filesystem. Asserting that root reaches the disk size only holds
            // for a single-partition layout: debian-12 installs LVM with the
            // `multi` recipe, where root is one LV beside /home, /var and
            // /tmp, so a root-sized assertion fails even when growth works
            // perfectly. Consuming the disk is the part every layout shares,
            // and it is exactly cloud-init's growpart contract. How the freed
            // space is then distributed across LVs is a recipe decision.
            id: 'disk-fully-partitioned',
            description: 'cloud-init grew the partition table to fill the disk',
            script: `disk=$(lsblk -rno NAME,TYPE | awk '$2=="disk"{print $1; exit}')
[ -n "$disk" ] || { echo 'no disk found'; lsblk; exit 1; }
total=$(lsblk -bdno SIZE "/dev/$disk")
# %.0f, not print or %d. Bare print uses awk's %.6g default, which renders a
# multi-gigabyte byte count as 5.36556e+09; and mawk (Debian's awk) computes
# %d in 32 bits, so a sum past 2GiB saturates at 2147483647. Both were observed
# against a real guest, and both silently corrupt the comparison below.
used=$(lsblk -brno TYPE,SIZE "/dev/$disk" | awk '$1=="part"{s+=$2} END{printf "%.0f\\n", s+0}')
free=$((total - used))
echo "disk=/dev/$disk total=$total partitioned=$used unallocated=$free"
# Generous: alignment and a BIOS boot partition leave a little slack, while a
# grow that never happened leaves the whole amount verify added.
[ "$free" -lt 1073741824 ] || {
    echo "unallocated tail exceeds 1GiB — growpart did not extend the last partition"
    lsblk "/dev/$disk"
    command -v pvs >/dev/null && pvs 2>/dev/null
    command -v vgs >/dev/null && vgs 2>/dev/null
    df -h /
    exit 1
}`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            // A template that ships its build host keys makes every clone
            // impersonatable by any other clone. cloud-init's cleanup removes
            // them so they regenerate on first boot; this proves it happened.
            id: 'ssh-host-keys-regenerated',
            description: 'SSH host keys were regenerated on this boot',
            script: `boot=$(uptime -s)
n=$(find /etc/ssh -maxdepth 1 -name 'ssh_host_*_key' -newermt "$boot" 2>/dev/null | wc -l)
[ "$n" -ge 1 ] || {
  echo "no host key newer than boot ($boot) — keys came from the image"
  ls -l /etc/ssh/ssh_host_*_key 2>/dev/null
  exit 1
}`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            id: 'machine-id-valid',
            description: '/etc/machine-id is present and well-formed',
            script: `id=$(cat /etc/machine-id 2>/dev/null || true)
[ -n "$id" ] || { echo 'machine-id is empty'; exit 1; }
echo "$id" | grep -qE '^[0-9a-f]{32}$' || { echo "malformed machine-id: $id"; exit 1; }`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            // Advisory: a shared machine-id breaks DHCP leases and systemd
            // journal identity across clones, but images that regenerate it via
            // systemd-firstboot rather than cloud-init can legitimately fail the
            // mtime heuristic.
            id: 'machine-id-regenerated',
            description: 'machine-id was regenerated on this boot',
            script: `boot=$(uptime -s)
[ -n "$(find /etc/machine-id -newermt "$boot" 2>/dev/null)" ] || {
  echo "machine-id predates boot ($boot) — may be inherited from the image"
  exit 1
}`,
            severity: 'warn',
            phase: 'first-boot',
        },
        {
            // Debian ships qemu-guest-agent.service as `static`: it has no
            // [Install] section and is started by a udev rule when the virtio
            // port appears, so there is no enable symlink and `is-enabled`
            // never reports "enabled". Measured against a real debian-12
            // template, which answered `static` while the agent was plainly
            // working — every other check in this suite had just run through
            // it. Only disabled/masked means a clone comes up without an agent.
            id: 'guest-agent-not-disabled',
            description: 'qemu-guest-agent is not disabled or masked',
            script: `state=$(systemctl is-enabled qemu-guest-agent 2>/dev/null || true)
echo "is-enabled=$state"
case "$state" in
    enabled|enabled-runtime|static|indirect|generated) exit 0 ;;
esac
systemctl status qemu-guest-agent --no-pager 2>&1 | head -5
exit 1`,
            severity: 'fail',
            phase: 'first-boot',
        },
        {
            // First boot does real work (growpart, key regeneration), so a
            // transiently degraded state here is noise. After a clean reboot it
            // is a defect.
            //
            // Poll is-system-running rather than trusting `--wait`: that flag
            // only waits for is-system-running on systemd >= 240, and el8 ships
            // 239, where it is silently ignored and the command returns
            // "starting" immediately — failing the post-reboot check on a guest
            // that was merely still booting.
            id: 'systemd-healthy-first-boot',
            description: 'system reached a running state on first boot',
            script: systemdHealthyScript,
            severity: 'warn',
            phase: 'first-boot',
            timeoutS: 240,
        },
        {
            id: 'systemd-healthy',
            description: 'no failed units after a clean reboot',
            script: systemdHealthyScript,
            severity: 'fail',
            phase: 'post-reboot',
            timeoutS: 240,
        },
        {
            id: 'hostname-persists',
            description: 'hostname survived a reboot',
            script: ctx => `want=${ctx.hostname}
got=$(hostname)
[ "$got" = "$want" ] || { echo "hostname=$got want=$want"; exit 1; }`,
            severity: 'fail',
            phase: 'post-reboot',
        },
        {
            // Advisory: the verify VM sits on CF_BRIDGE with DHCP and the node's
            // network may not route to the internet, so a failure here is not
            // necessarily an image defect.
            id: 'dns-resolves',
            description: 'DNS resolution works from the guest',
            script: `getent hosts example.com >/dev/null 2>&1 ||
getent hosts cloudflare.com >/dev/null 2>&1 ||
{ echo 'no name resolution'; cat /etc/resolv.conf 2>/dev/null; exit 1; }`,
            severity: 'warn',
            phase: 'post-reboot',
        },
    ],
}
