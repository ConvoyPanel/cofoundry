#!/usr/bin/env bash
# shrink-disk.sh — shrink the OS (scsi0) disk to CF_FINAL_DISK_SIZE before vzdump.
#
# Sourced by export-and-cleanup.sh, so it reuses that scope's _pve() dispatch
# (local bash vs. ssh to the node), CF_BUILT_VMID, and CF_FINAL_DISK_SIZE.
# Only invoked when CF_FINAL_DISK_SIZE is set.
#
# This only shrinks the qcow2 *virtual* size — it does not move partitions. The
# guest (Finalize.ps1 on Windows) must already have shrunk its filesystem so the
# last partition ends below CF_FINAL_DISK_SIZE. Fails closed (set -e in the
# caller) so a bad shrink can never publish a corrupt template.
#
# First pass: file-backed qcow2 on `dir` storage only. Anything else aborts.

shrink_disk() {
  local vmid="$CF_BUILT_VMID"
  local target="$CF_FINAL_DISK_SIZE"

  echo "==> shrink: ensuring VM $vmid is stopped before resizing"
  _pve "qm stop '$vmid' --skiplock 1 >/dev/null 2>&1 || true"
  # qemu can hold the image open briefly after stop; wait for 'stopped' so
  # qemu-img isn't fighting a live writer.
  local i
  for i in $(seq 1 30); do
    if _pve "qm status '$vmid' 2>/dev/null | grep -q 'status: stopped'"; then
      break
    fi
    sleep 2
  done

  echo "==> shrink: resolving scsi0 disk for VM $vmid"
  local volid path
  volid=$(_pve "qm config '$vmid' | sed -nE 's/^scsi0: ([^,]+).*/\1/p'")
  [ -n "$volid" ] || { echo "shrink: no scsi0 disk on VM $vmid"; return 1; }
  path=$(_pve "pvesm path '$volid' 2>/dev/null")
  [ -n "$path" ] || { echo "shrink: could not resolve a path for $volid"; return 1; }
  echo "==> shrink: $volid -> $path"

  # Guard: only a regular qcow2 file is safe for `qemu-img resize --shrink`.
  if ! _pve "test -f '$path'"; then
    echo "shrink: $path is not a regular file — refusing to shrink"; return 1
  fi
  if ! _pve "qemu-img info --output=json '$path' 2>/dev/null | grep -q '\"format\": \"qcow2\"'"; then
    echo "shrink: $path is not qcow2 — refusing to shrink"; return 1
  fi

  # Packer converts the VM to a template before this post-processor runs, and
  # Proxmox sets the immutable bit (chattr +i) on template disks — so qemu-img
  # opens the file read-only fine (the guard above) but the resize write fails
  # with "Operation not permitted". Clear it, resize, then restore it so the
  # template is left in its normal protected state. (Same dance as verify.ts.)
  echo "==> shrink: clearing immutable bit before resize"
  _pve "chattr -i '$path' 2>/dev/null || true"

  echo "==> shrink: qemu-img resize --shrink $path $target"
  if ! _pve "qemu-img resize --shrink '$path' '$target'"; then
    _pve "chattr +i '$path' 2>/dev/null || true"
    echo "shrink: qemu-img resize failed"; return 1
  fi

  _pve "chattr +i '$path' 2>/dev/null || true"

  # Sync the VM config's size= field to the new image so clones get the smaller
  # geometry (qemu-img alone doesn't touch the config).
  echo "==> shrink: qm rescan --vmid $vmid"
  _pve "qm rescan --vmid '$vmid' >/dev/null 2>&1 || true"
}
