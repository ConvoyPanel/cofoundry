#!/usr/bin/env bash
# export-disks.sh — export the built VM's disks as importable images.
#
# Sourced by export-and-cleanup.sh, so it reuses that scope's _pve() dispatch
# (local bash vs. ssh to the node) and CF_* environment.
#
# Replaces vzdump. A vzdump archive can only be restored with qmrestore, which
# produces a VM template and therefore occupies a VMID on every node it lands
# on. A disk image is data on a storage: `qm create --scsiN <storage>:0,
# import-from=...` builds a VM from it without reserving anything, and an
# import store on shared storage serves a whole cluster from one copy.
#
# Compression has to live INSIDE the image. Proxmox refuses to decompress on
# the import path -- API2/Storage/Status.pm rejects `compression` for any
# content type other than `iso` -- so artifacts cannot ship as .zst.
# `qemu-img convert -c` writes compressed qcow2 clusters that qemu reads
# natively and that Proxmox accepts as a plain .qcow2.
#
# Populates these parallel arrays for the caller, one entry per artifact:
#   CF_DISK_SLOT   scsi0, efidisk0
#   CF_DISK_ROLE   system, efivars
#   CF_DISK_FORMAT qcow2, raw
#   CF_DISK_FILE   local path under CF_OUT_DIR
#   CF_DISK_OPTS   JSON object of image-describing options
#   CF_DISK_VSIZE  guest-visible size, or "" where it does not apply

CF_DISK_SLOT=()
CF_DISK_ROLE=()
CF_DISK_FORMAT=()
CF_DISK_FILE=()
CF_DISK_OPTS=()
CF_DISK_VSIZE=()

# _fetch <remote-path> <local-path> — move (local mode) or scp (remote mode).
_fetch() {
  if [ "$LOCAL_MODE" = "1" ]; then
    mv "$1" "$2"
  else
    scp "$SSH_TARGET:$1" "$2"
    _pve "rm -f '$1'"
  fi
}

# _volid_path <volid> — resolve a Proxmox volid to a node-side file path.
#
# `pvesm path` only *constructs* a path from the volid; it does not check that
# anything is there. A config entry naming a file that no longer exists
# therefore resolves cleanly and only fails later, at the copy, with a bare
# "cannot stat" that says nothing about why. Assert existence here and dump the
# VM's image directory when it fails, so the next occurrence is diagnosable from
# packer's stdout instead of needing another multi-hour build to reproduce.
#
# This is not hypothetical: a windows-server-2025 build on 2026-08-25 reached
# the export with `efidisk0: local:200205/base-200205-disk-0.raw` in its config
# and no such file on disk. Four targeted probes failed to reproduce it —
# template conversion, packer's post-template ISO delete + cloudinit add, and
# the shrink's `qm rescan` all preserve the varstore — so the cause is still
# unknown and the directory listing is how we catch it next time.
# Every diagnostic here goes to STDERR on purpose: this function is called as
# `path=$(_volid_path ...)`, so anything on stdout is captured into the caller's
# variable instead of reaching packer's log — which would make the failure
# silent at exactly the moment it needs to explain itself.
_volid_path() {
  local path
  path=$(_pve "pvesm path '$1' 2>/dev/null")
  [ -n "$path" ] || { echo "export-disks: could not resolve a path for $1" >&2; return 1; }
  if ! _pve "test -e '$path'"; then
    {
      echo "export-disks: $1 resolves to '$path', which does not exist."
      echo "export-disks: the VM config names a volume that is not on disk."
      echo "export-disks: contents of its image directory:"
      _pve "ls -la '$(dirname "$path")' 2>&1 || true"
      echo "export-disks: current VM config:"
      _pve "qm config '$CF_BUILT_VMID' 2>&1 || true"
    } >&2
    return 1
  fi
  printf '%s' "$path"
}

# export_disks <config-text>
export_disks() {
  local config="$1"
  local base="${CF_RECIPE_NAME}-${CF_ARCH}"

  # --- EFI variable store (efidisk0), staged FIRST ---------------------------
  # OVMF splits into read-only firmware code on the node and a per-VM writable
  # variable store. The varstore holds the boot entry Windows Setup wrote
  # (Boot0000 -> \EFI\Microsoft\Boot\bootmgfw.efi), the enrolled Secure Boot
  # keys, and any dbx revocations WU.ps1 applied. None of that can be
  # reconstructed from flags, and a freshly allocated varstore has none of it.
  # Proxmox 9 can import one: `qm create --efidisk0 <storage>:0,import-from=`.
  # Without that parameter this whole design does not work for Windows.
  #
  # Copied before the system disk on purpose. It is ~540 KB against a 32 G
  # qcow2 conversion that runs for minutes, so staging it first costs nothing
  # and removes that entire window from the time between resolving its path and
  # having its bytes. A 2026-08-25 windows-server-2025 build lost the varstore
  # inside exactly that window (see _volid_path above).
  local efi_line efi_volid efi_path efi_opts efi_remote efi_local=""
  efi_line=$(printf '%s' "$config" | sed -nE 's/^efidisk0: (.*)$/\1/p')
  if [ -n "$efi_line" ]; then
    efi_volid=${efi_line%%,*}
    efi_path=$(_volid_path "$efi_volid") || return 1

    local efitype keys mscert efi_fields=""
    efitype=$(_kv_from "$efi_line" efitype)
    keys=$(_kv_from "$efi_line" pre-enrolled-keys)
    mscert=$(_kv_from "$efi_line" ms-cert)
    [ -n "$efitype" ] && efi_fields="$efi_fields,\"efitype\":\"$efitype\""
    [ -n "$keys" ] && efi_fields="$efi_fields,\"pre-enrolled-keys\":$keys"
    [ -n "$mscert" ] && efi_fields="$efi_fields,\"ms-cert\":\"$mscert\""
    efi_opts="{${efi_fields#,}}"

    efi_remote="$PVE_DUMP_DIR/${base}.efivars.raw"
    efi_local="$CF_OUT_DIR/${base}.efivars.raw"
    echo "==> export: copying EFI varstore $efi_path"
    # Byte copy, not qemu-img: the varstore is raw and ~540 KB, and its exact
    # contents are the entire point.
    _pve "rm -f '$efi_remote'; cp '$efi_path' '$efi_remote'"
    echo "==> export: retrieving ${base}.efivars.raw"
    _fetch "$efi_remote" "$efi_local"
  fi

  # --- system disk (scsi0) ---------------------------------------------------
  local scsi_line volid path vsize opts remote local_file
  scsi_line=$(printf '%s' "$config" | sed -nE 's/^scsi0: (.*)$/\1/p')
  [ -n "$scsi_line" ] || { echo "export-disks: no scsi0 disk on VM $CF_BUILT_VMID"; return 1; }
  volid=${scsi_line%%,*}
  path=$(_volid_path "$volid") || return 1

  vsize=$(_kv_from "$scsi_line" size)
  opts="{}"
  local discard ssd fields=""
  discard=$(_kv_from "$scsi_line" discard)
  ssd=$(_kv_from "$scsi_line" ssd)
  [ -n "$discard" ] && fields="$fields,\"discard\":\"$discard\""
  [ -n "$ssd" ] && fields="$fields,\"ssd\":$ssd"
  [ -n "$fields" ] && opts="{${fields#,}}"

  remote="$PVE_DUMP_DIR/${base}.qcow2"
  local_file="$CF_OUT_DIR/${base}.qcow2"
  echo "==> export: converting $path -> compressed qcow2"
  # -c compresses clusters; the source is a template disk carrying the
  # immutable bit, which blocks writes but not the read this needs.
  _pve "rm -f '$remote'; qemu-img convert -c -O qcow2 '$path' '$remote'"
  echo "==> export: retrieving ${base}.qcow2"
  _fetch "$remote" "$local_file"

  CF_DISK_SLOT+=("scsi0")
  CF_DISK_ROLE+=("system")
  CF_DISK_FORMAT+=("qcow2")
  CF_DISK_FILE+=("$local_file")
  CF_DISK_OPTS+=("$opts")
  CF_DISK_VSIZE+=("$vsize")

  # The varstore was staged above; record it after the system disk so the
  # sidecar still reads system-first.
  if [ -n "$efi_local" ]; then
    CF_DISK_SLOT+=("efidisk0")
    CF_DISK_ROLE+=("efivars")
    CF_DISK_FORMAT+=("raw")
    CF_DISK_FILE+=("$efi_local")
    CF_DISK_OPTS+=("$efi_opts")
    CF_DISK_VSIZE+=("")
  fi
}
