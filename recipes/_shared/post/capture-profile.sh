#!/usr/bin/env bash
# capture-profile.sh — build the sidecar's `hardware` object from `qm config`.
#
# Sourced by export-and-cleanup.sh, so it reuses that scope's _pve() dispatch
# (local bash vs. ssh to the node) and CF_* environment.
#
# The profile is CAPTURED from the built VM, never hand-written in HCL. A
# hand-authored profile drifts from what was actually built and booted; a
# captured one cannot. See docs/disk-images.md#building-the-profile.
#
# Capture is a denylist: every key `qm config` prints is published unless it is
# build identity or a no-op default. The test for keeping a field is "does
# getting this wrong break the image?", NOT "does this value vary across
# recipes?" — those diverge. Every recipe builds scsihw=virtio-scsi-single
# because every image has virtio-scsi drivers bound to its boot device; hand a
# Windows image an lsi controller and it stops at 0x7B INACCESSIBLE_BOOT_DEVICE.
# A predictable value still has to be recorded, or the consumer is left
# hardcoding a constant that happens to match.

# Keys that describe THIS build rather than the image. Publishing any of them
# would be meaningless or actively wrong on a consumer's node.
#
#   name/description/template  build-local labelling
#   smbios1/vmgenid/meta       per-VM identity; a clone must generate its own
#   memory/cores/sockets       Windows builds at 8192/4 for WU servicing
#                              headroom. Publishing it would floor every
#                              consumer plan at 8 GB. The hand-authored
#                              `minimum` block replaces it.
#   boot                       derived by the consumer from disks[].slot
#   parent/digest/lock/protection  node-side bookkeeping
#
# No-op defaults the packer plugin writes explicitly (Proxmox would apply the
# same value anyway): kvm=1, numa=0, onboot=0, vga=std.
CF_PROFILE_DENY="name description template smbios1 vmgenid meta memory cores sockets boot parent digest lock protection kvm numa onboot vga"

# JSON string escape. qm config values are simple tokens, but `set -u` safety
# beats assuming that of a future Proxmox release.
_json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Extract `key=value` from a comma-separated qm config value (e.g. the
# `version=v2.0` in `tpmstate0: local:2002/...,size=17K,version=v2.0`).
_kv_from() {
  printf '%s' "$1" | tr ',' '\n' | sed -nE "s/^$2=(.*)$/\1/p" | head -1
}

# capture_profile <config-text>
#
# Prints the `hardware` object (without the enclosing key) to stdout. Disk
# slots are deliberately NOT emitted here — export_disks owns those, since a
# disk is an artifact to download, not a flag to set.
capture_profile() {
  local config="$1"
  local out="" key value

  while IFS= read -r line; do
    case "$line" in
      *:*) ;;
      *) continue ;;
    esac
    key=${line%%:*}
    value=${line#*: }
    [ "$value" = "$line" ] && value=""

    # Denylisted build identity and no-op defaults.
    case " $CF_PROFILE_DENY " in
      *" $key "*) continue ;;
    esac

    case "$key" in
      # Disk slots belong to export_disks. ide*/sata* here are the build's
      # boot ISO, virtio ISO, and answer-file ISO CD-ROMs plus the cloud-init
      # drive -- all build scaffolding. Windows templates land the cloud-init
      # drive on ide3 only because ide0-2 held those ISOs; the consumer
      # allocates a fresh one on ide2. Cloudbase-Init locates the config drive
      # by label, not slot, so the move is safe.
      scsi[0-9]*|ide[0-9]*|sata[0-9]*|virtio[0-9]*|efidisk[0-9]*|unused[0-9]*)
        continue
        ;;

      # A TPM is a property of the image (2019 has none; 2022 and 2025 do), but
      # the state volume itself is allocated fresh by the consumer -- the image
      # is generalized, so nothing is sealed to it, and a shipped varstore
      # would give every VM the same EK.
      tpmstate[0-9]*)
        local version
        version=$(_kv_from "$value" version)
        [ -n "$version" ] && out="$out,\"tpm\":\"$(_json_escape "$version")\""
        ;;

      # Record only the model. The macaddr is build_mac from the NAT slot and
      # the bridge is this node's; both are the consumer's to choose.
      net[0-9]*)
        local model
        model=$(printf '%s' "$value" | sed -nE 's/^([a-z0-9_]+)=.*/\1/p' | head -1)
        [ -n "$model" ] && out="$out,\"net_model\":\"$(_json_escape "$model")\""
        ;;

      # The build pins a QEMU machine version (pc-q35-11.0). Published as-is
      # the image will not start on a node running older QEMU -- a hard
      # failure, not a degradation. These images are sysprep-generalized and
      # re-detect hardware on first boot, so the bare type is portable.
      machine)
        local normalized
        normalized=$(printf '%s' "$value" | sed -E 's/^pc-(q35|i440fx)-[0-9]+\.[0-9]+$/\1/')
        out="$out,\"machine\":\"$(_json_escape "$normalized")\""
        ;;

      *)
        # agent=1 arrives as `agent: 1`; keep integers unquoted so consumers
        # don't have to coerce. Everything else is a string.
        case "$value" in
          ''|*[!0-9]*) out="$out,\"$(_json_escape "$key")\":\"$(_json_escape "$value")\"" ;;
          *) out="$out,\"$(_json_escape "$key")\":$value" ;;
        esac
        ;;
    esac
  done <<EOF
$config
EOF

  printf '{%s}' "${out#,}"
}
