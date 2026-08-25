#!/usr/bin/env bash
# assert-generalized.sh — host-side proof that a Windows build actually sysprep'd.
#
# Sourced by export-and-cleanup.sh, so it reuses that scope's _pve() dispatch
# (local bash vs. ssh to the node) and CF_* environment.
#
# Why this has to be host-side: a guest-side assertion cannot be trusted here.
# On 2026-07-31 a windows-server-2022 build exported a fully NON-generalized
# template while packer reported "Build finished" — sysprep aborted in its Appx
# pre-validation (0x80073cf2), and that failure never reached packer: the
# provisioner returned success while the guest script was still running, and the
# VM was stopped out from under it mid-sysprep. Finalize.ps1's own arming gate
# never even got to write its log. Every clone of such a template sticks at
# GeneralizationState 3 forever, and the only way anyone noticed was inspecting
# the artifact by hand. Reading the finished image from outside the guest is the
# one check no guest-side exit-code plumbing can mask.
#
# Markers asserted (validated against a known-good 2019 template and the broken
# 2022 one, which differed on every single one):
#   Sysprep_succeeded.tag             present — sysprep writes it only on a real
#                                     generalize; its exit code alone is unreliable
#   SetupType=2 + CmdLine=windeploy   the next boot is armed to run specialize/OOBE
#   ImageState=…GENERALIZE_RESEAL_TO_OOBE
# See docs/windows.md ("Mode B").

# Read-only inspection of the stopped build disk. Runs before the shrink so a
# failed build costs no export time, and while the GPT is still intact (the
# shrink truncates the backup header away).
assert_generalized() {
  case "$CF_RECIPE_NAME" in
    windows-*) ;;
    *) return 0 ;;
  esac

  local vmid="$CF_BUILT_VMID" volid path script
  volid=$(_pve "qm config '$vmid' | sed -nE 's/^scsi0: ([^,]+).*/\1/p'")
  [ -n "$volid" ] || { echo "assert-generalized: no scsi0 disk on VM $vmid"; return 1; }
  path=$(_pve "pvesm path '$volid' 2>/dev/null")
  [ -n "$path" ] || { echo "assert-generalized: could not resolve a path for $volid"; return 1; }

  echo "==> assert-generalized: inspecting $path"

  script=$(cat <<'EOS'
set -u
DISK="__DISK__"
command -v qemu-nbd >/dev/null 2>&1 || {
  echo "assert-generalized: qemu-nbd not found (install qemu-utils)"; exit 1; }
modprobe nbd max_part=8 2>/dev/null || true

# Connecting is itself the free-device test: a busy nbd device refuses.
NBD=""
for d in /dev/nbd0 /dev/nbd1 /dev/nbd2 /dev/nbd3 /dev/nbd4; do
  [ -e "$d" ] || continue
  if qemu-nbd --read-only --connect="$d" "$DISK" >/dev/null 2>&1; then NBD="$d"; break; fi
done
[ -n "$NBD" ] || { echo "assert-generalized: could not attach $DISK to an nbd device"; exit 1; }

MNT=$(mktemp -d)
LOOP=""
cleanup() {
  umount "$MNT" 2>/dev/null || true
  rmdir "$MNT" 2>/dev/null || true
  [ -n "$LOOP" ] && losetup -d "$LOOP" 2>/dev/null
  qemu-nbd --disconnect "$NBD" >/dev/null 2>&1 || true
}
trap cleanup EXIT

sleep 2

# Map partitions by offset read from the PRIMARY GPT rather than relying on the
# kernel's /dev/nbdXpN nodes. An exported template normally has no valid *backup*
# GPT — the post-export shrink truncates the tail of the disk away — and the
# kernel's partition scanner then refuses the disk entirely, so no pN nodes
# appear. sgdisk still reads the primary table fine. (This is exactly how the
# 2026-07-31 offline inspections had to mount these images by hand; a first cut
# of this script used pN nodes and failed on a known-good template.)
command -v sgdisk >/dev/null 2>&1 || {
  echo "assert-generalized: sgdisk not found (install gdisk)"; exit 1; }

STARTS=$(sgdisk -p "$NBD" 2>/dev/null | awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {print $2}')
[ -n "$STARTS" ] || { echo "assert-generalized: could not read a partition table from $DISK"; exit 1; }

# The Windows volume is whichever partition actually carries \Windows\System32 —
# probed rather than indexed, since the EFI/MSR layout differs by release.
WIN=""
for start in $STARTS; do
  LOOP=$(losetup --find --show --read-only --offset $((start * 512)) "$NBD" 2>/dev/null) || { LOOP=""; continue; }
  if mount -t ntfs3 -o ro "$LOOP" "$MNT" 2>/dev/null; then
    if [ -d "$MNT/Windows/System32" ]; then WIN="sector $start"; break; fi
    umount "$MNT" 2>/dev/null || true
  fi
  losetup -d "$LOOP" 2>/dev/null || true
  LOOP=""
done
[ -n "$WIN" ] || { echo "assert-generalized: no Windows partition found in $DISK"; exit 1; }
echo "assert-generalized: reading Windows volume at $WIN"

FAIL=0
if [ ! -f "$MNT/Windows/System32/Sysprep/Sysprep_succeeded.tag" ]; then
  echo "assert-generalized: FAIL Sysprep_succeeded.tag missing — sysprep did not generalize this image"
  ERRLOG="$MNT/Windows/System32/Sysprep/Panther/setuperr.log"
  if [ -f "$ERRLOG" ]; then
    echo "--- guest sysprep setuperr.log (last 20 lines) ---"
    sed 's/\r//' "$ERRLOG" | tail -20
    echo "--------------------------------------------------"
  fi
  FAIL=1
fi

# The tag alone proves generalize ran; these prove the result is armed for OOBE,
# which is the state a clone's first boot actually depends on.
if command -v reged >/dev/null 2>&1; then
  reged -x "$MNT/Windows/System32/config/SYSTEM" 'HKEY_LOCAL_MACHINE\SYSTEM' \
    '\Setup' /tmp/cf-assert-setup.reg >/dev/null 2>&1 || true
  reged -x "$MNT/Windows/System32/config/SOFTWARE" 'HKEY_LOCAL_MACHINE\SOFTWARE' \
    '\Microsoft\Windows\CurrentVersion\Setup\State' /tmp/cf-assert-state.reg >/dev/null 2>&1 || true
  SETUPTYPE=$(grep -a '"SetupType"' /tmp/cf-assert-setup.reg 2>/dev/null | head -1)
  CMDLINE=$(grep -a '"CmdLine"' /tmp/cf-assert-setup.reg 2>/dev/null | head -1)
  IMAGESTATE=$(grep -a 'ImageState' /tmp/cf-assert-state.reg 2>/dev/null | head -1)
  echo "assert-generalized: ${SETUPTYPE:-<no SetupType>} ${CMDLINE:-<no CmdLine>} ${IMAGESTATE:-<no ImageState>}"
  case "$SETUPTYPE" in *dword:00000002*) ;; *)
    echo "assert-generalized: FAIL SetupType is not 2 — the next boot is not armed to run OOBE"; FAIL=1 ;;
  esac
  case "$CMDLINE" in *windeploy*|*WinDeploy*) ;; *)
    echo "assert-generalized: FAIL CmdLine does not launch windeploy.exe"; FAIL=1 ;;
  esac
  case "$IMAGESTATE" in *IMAGE_STATE_GENERALIZE_RESEAL_TO_OOBE*) ;; *)
    echo "assert-generalized: FAIL ImageState is not GENERALIZE_RESEAL_TO_OOBE"; FAIL=1 ;;
  esac
  rm -f /tmp/cf-assert-setup.reg /tmp/cf-assert-state.reg
else
  echo "assert-generalized: WARN reged (chntpw) not found — asserted the sysprep tag only"
fi

# Finalize.ps1 writes this as its very last act, after the WinRM teardown. Its
# absence means the script stopped early even though generalize itself worked --
# the failure mode where a teardown step severs packer's WinRM session, packer
# reads the disconnect as success, and the template ships with the build's Basic
# auth and open WinRM firewall rule still in place. Generalization checks alone
# cannot see that; this can.
SENTINEL="$MNT/Windows/Setup/cf-finalize-complete.tag"
if [ ! -f "$SENTINEL" ]; then
  echo "assert-generalized: FAIL Finalize.ps1 did not run to completion (no cf-finalize-complete.tag)"
  echo "assert-generalized:      the script stopped early — most likely a step severed the WinRM session,"
  echo "assert-generalized:      so the build's WinRM exposure was never torn down."
  FAIL=1
else
  echo "assert-generalized: finalize sentinel: $(sed 's/\r//' "$SENTINEL" | tr '\n' ' ')"
fi

if [ "$FAIL" != "0" ]; then
  echo "assert-generalized: REFUSING to export — the image is not safe to ship"
  exit 1
fi
echo "assert-generalized: OK — image is generalized and armed for OOBE"
EOS
)
  script=${script//__DISK__/$path}
  _pve "$script"
}
