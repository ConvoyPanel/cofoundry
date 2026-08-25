#!/usr/bin/env bash
# export-and-cleanup.sh — Packer shell-local post-processor.
#
# Exports the built VM as importable disk images plus a schema-2 sidecar
# describing how to rebuild the VM around them. See docs/disk-images.md.
#
# When SSH_TARGET=local (packer runs on the PVE node itself): export and file
# operations run directly. CF_OUT_DIR must be a local path on the node.
#
# When SSH_TARGET=<user@host>: export runs over SSH, artifacts are scp'd local.
#
# Required env:
#   SSH_TARGET           "local" or e.g. root@pve.example.com
#   PVE_DUMP_DIR         e.g. /var/lib/vz/dump
#   CF_OUT_DIR           output dir (local on node when SSH_TARGET=local)
#
# Set by HCL environment_vars:
#   CF_BUILT_VMID / CF_RECIPE_NAME / CF_RECIPE_DISPLAY
#
# Optional: CF_UPLOAD_CMD, CF_PUBLIC_URL_TMPL, CF_KEEP_VM, CF_MIN_CORES,
#           CF_MIN_MEMORY
#   Generated templates use {{recipe}}, {{arch}}, {{sha256}}, and {{group}}.
#   Raw overrides also support {{file}} plus legacy {{name}} / {{filename}}.
#   {{sha256}} and {{filename}} are rendered PER ARTIFACT — a recipe now emits
#   a system disk and, on OVMF recipes, an EFI varstore, each with its own hash.

set -euo pipefail

: "${SSH_TARGET:?}"
: "${PVE_DUMP_DIR:?}"
: "${CF_OUT_DIR:?}"
: "${CF_RECIPE_NAME:?}"
: "${CF_RECIPE_DISPLAY:?}"
: "${CF_BUILT_VMID:?}"
: "${CF_ARCH:?}"
: "${CF_GROUP:?}"

# CF_BUILT_VMID is the slot-derived build id (recipe base * 100 + slot index)
# for parallel builds. The sidecar's suggested_vmid should advertise the recipe
# BASE, which cf exports as CF_RECIPE_BASE_VMID. Plain non-slot builds set only
# CF_BUILT_VMID, where the two are equal.
BASE_VMID="${CF_RECIPE_BASE_VMID:-$CF_BUILT_VMID}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

LOCAL_MODE=0
[ "$SSH_TARGET" = "local" ] && LOCAL_MODE=1

_pve() {
  if [ "$LOCAL_MODE" = "1" ]; then
    bash -c "$*"
  else
    ssh "$SSH_TARGET" "$*"
  fi
}

# shrink_disk() — defined here, invoked below only when CF_FINAL_DISK_SIZE is set.
# shellcheck source=shrink-disk.sh
. "$SCRIPT_DIR/shrink-disk.sh"

# assert_generalized() — Windows-only, no-op for every other recipe.
# shellcheck source=assert-generalized.sh
. "$SCRIPT_DIR/assert-generalized.sh"

# capture_profile() + _kv_from() — build the sidecar's `hardware` object.
# shellcheck source=capture-profile.sh
. "$SCRIPT_DIR/capture-profile.sh"

# export_disks() — populates the CF_DISK_* arrays. Depends on _kv_from above.
# shellcheck source=export-disks.sh
. "$SCRIPT_DIR/export-disks.sh"

cleanup() {
  if [ "${CF_KEEP_VM:-}" != "1" ]; then
    echo "==> cleanup: destroying VM $CF_BUILT_VMID"
    _pve "qm stop '$CF_BUILT_VMID' --skiplock 1 2>/dev/null || true; \
          qm destroy '$CF_BUILT_VMID' --purge 1 --destroy-unreferenced-disks 1 2>/dev/null || true" || true
  fi
}
trap cleanup EXIT

mkdir -p "$CF_OUT_DIR"

# Bake ciuser=root into the config so clones with --sshkeys / --cipassword
# apply them to root instead of falling through to the distro's default
# cloud-init user (debian/ubuntu/cloud-user/…), which doesn't actually exist in
# these images. Linux only — Windows uses cloudbase-init, not ciuser, and
# Cloudbase-Init's CreateUserPlugin is deliberately omitted (see Finalize.ps1).
# Set before the profile capture so it lands in the published `hardware`.
OSTYPE_LINE=$(_pve "qm config '$CF_BUILT_VMID' 2>/dev/null | grep -E '^ostype:' || true")
case "$OSTYPE_LINE" in
  *l24*|*l26*)
    echo "==> setting ciuser=root on VMID $CF_BUILT_VMID"
    _pve "qm set '$CF_BUILT_VMID' --ciuser root >/dev/null"
    ;;
esac

# Windows only: refuse to export an image sysprep did not actually generalize.
# Deliberately before the shrink — a failed build then costs no export time, and
# the GPT backup header is still intact for the read-only mount. set -e makes
# this fail the build (see assert-generalized.sh for why it cannot be guest-side).
assert_generalized

# Opt-in disk shrink: recipe declared `# final_disk_size:` and cf forwarded it
# as CF_FINAL_DISK_SIZE. Must run while the VM is stopped, before the export.
if [ -n "${CF_FINAL_DISK_SIZE:-}" ]; then
  echo "==> shrinking disk to $CF_FINAL_DISK_SIZE before export"
  shrink_disk
fi

# Read the config ONCE, after the shrink so scsi0's size= is the final geometry
# (shrink_disk runs `qm rescan` to sync it) and before the destroy below.
echo "==> reading VM config for profile capture"
VM_CONFIG=$(_pve "qm config '$CF_BUILT_VMID'")

HARDWARE=$(capture_profile "$VM_CONFIG")
echo "==> captured hardware profile: $HARDWARE"

export_disks "$VM_CONFIG"

echo "==> destroying VM $CF_BUILT_VMID"
if [ "${CF_KEEP_VM:-}" = "1" ]; then
  echo "==> CF_KEEP_VM=1: skipping destroy"
else
  _pve "qm stop '$CF_BUILT_VMID' --skiplock 1 2>/dev/null || true; \
        qm destroy '$CF_BUILT_VMID' --purge 1 --destroy-unreferenced-disks 1" || true
fi

# _render <template> <sha256> <filename> <ext> [file]
#
# {{ext}} exists because a template now publishes several images with different
# extensions, so a key template ending in {{sha256}} cannot carry a fixed one.
_render() {
  local out="$1"
  out="${out//\{\{recipe\}\}/$CF_RECIPE_NAME}"
  out="${out//\{\{name\}\}/$CF_RECIPE_NAME}"
  out="${out//\{\{arch\}\}/$CF_ARCH}"
  out="${out//\{\{group\}\}/$CF_GROUP}"
  out="${out//\{\{sha256\}\}/$2}"
  out="${out//\{\{filename\}\}/$3}"
  out="${out//\{\{ext\}\}/$4}"
  out="${out//\{\{file\}\}/${5:-}}"
  printf '%s' "$out"
}

echo "==> hashing and uploading ${#CF_DISK_FILE[@]} artifact(s)"
DISKS_JSON=""
SYSTEM_SHA256=""
for i in "${!CF_DISK_FILE[@]}"; do
  file="${CF_DISK_FILE[$i]}"
  slot="${CF_DISK_SLOT[$i]}"
  sha256=$(sha256sum "$file" | awk '{print $1}')
  size=$(wc -c <"$file" | tr -d ' ')

  # Proxmox restricts import-store filenames to [a-zA-Z0-9.+=_-]
  # (Storage.pm SAFE_CHAR_CLASS_RE), which the recipe-arch-hash form satisfies.
  ext="${file##*/}"
  ext="${ext#"${CF_RECIPE_NAME}-${CF_ARCH}"}"
  upload_filename="${CF_RECIPE_NAME}-${CF_ARCH}-${sha256}${ext}"

  public_url=""
  if [ -n "${CF_PUBLIC_URL_TMPL:-}" ]; then
    public_url=$(_render "$CF_PUBLIC_URL_TMPL" "$sha256" "$upload_filename" "$ext")
  fi

  if [ -n "${CF_UPLOAD_CMD:-}" ]; then
    echo "==> uploading $upload_filename"
    bash -c "$(_render "$CF_UPLOAD_CMD" "$sha256" "$upload_filename" "$ext" "$file")"
  fi

  entry="{\"slot\":\"$slot\",\"role\":\"${CF_DISK_ROLE[$i]}\""
  entry="$entry,\"format\":\"${CF_DISK_FORMAT[$i]}\""
  entry="$entry,\"file\":\"$upload_filename\""
  entry="$entry,\"url\":\"$public_url\""
  entry="$entry,\"sha256\":\"$sha256\",\"size\":$size"
  [ -n "${CF_DISK_VSIZE[$i]}" ] && entry="$entry,\"virtual_size\":\"${CF_DISK_VSIZE[$i]}\""
  entry="$entry,\"options\":${CF_DISK_OPTS[$i]}}"
  DISKS_JSON="$DISKS_JSON,$entry"

  # The sidecar is content-addressed by the SYSTEM disk's hash so each build
  # publishes a distinct sidecar key rather than overwriting the last one --
  # that history is what `cf publish --r2` selects newest-per-template from and
  # what `cf prune --r2` retains N of.
  [ "${CF_DISK_ROLE[$i]}" = "system" ] && SYSTEM_SHA256="$sha256"
done
DISKS_JSON="[${DISKS_JSON#,}]"

# `minimum` is hand-authored per recipe (`# min_cores:` / `# min_memory:`),
# not captured: the build's cores/memory are servicing headroom, not a runtime
# floor. There is deliberately no `minimum.disk` — `import-from` gives the
# imported disk the source's virtual size and `qm disk resize` cannot shrink,
# so disks[0].virtual_size already enforces that floor structurally.
MINIMUM=""
if [ -n "${CF_MIN_CORES:-}" ] || [ -n "${CF_MIN_MEMORY:-}" ]; then
  fields=""
  [ -n "${CF_MIN_CORES:-}" ] && fields="$fields,\"cores\":${CF_MIN_CORES}"
  [ -n "${CF_MIN_MEMORY:-}" ] && fields="$fields,\"memory\":${CF_MIN_MEMORY}"
  MINIMUM=",
  \"minimum\": {${fields#,}}"
fi

echo "==> writing sidecar"
SIDECAR="$CF_OUT_DIR/${CF_RECIPE_NAME}-${CF_ARCH}.json"
# Write to .tmp then rename so a partial/crashed write can't leave a sidecar
# whose hashes disagree with the artifacts next to it.
cat >"$SIDECAR.tmp" <<JSON
{
  "schema_version": "2",
  "name": "${CF_RECIPE_NAME}-${CF_ARCH}",
  "display": "$CF_RECIPE_DISPLAY",
  "arch": "$CF_ARCH",
  "group": "$CF_GROUP",
  "suggested_vmid": ${BASE_VMID},
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "disks": $DISKS_JSON,
  "hardware": $HARDWARE$MINIMUM
}
JSON
mv "$SIDECAR.tmp" "$SIDECAR"

if [ -n "${CF_SIDECAR_UPLOAD_CMD:-}" ]; then
  echo "==> uploading sidecar"
  bash -c "$(_render "$CF_SIDECAR_UPLOAD_CMD" "$SYSTEM_SHA256" "${CF_RECIPE_NAME}-${CF_ARCH}-${SYSTEM_SHA256}.json" ".json" "$SIDECAR")"
fi

trap - EXIT
echo "==> done: $SIDECAR"
