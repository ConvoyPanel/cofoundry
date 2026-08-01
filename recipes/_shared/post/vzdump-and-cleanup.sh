#!/usr/bin/env bash
# vzdump-and-cleanup.sh — Packer shell-local post-processor.
#
# When SSH_TARGET=local (packer runs on the PVE node itself): vzdump and file
# operations run directly. CF_OUT_DIR must be a local path on the node.
#
# When SSH_TARGET=<user@host>: vzdump runs over SSH, artifact is scp'd locally.
#
# Required env:
#   SSH_TARGET           "local" or e.g. root@pve.example.com
#   PVE_DUMP_DIR         e.g. /var/lib/vz/dump
#   CF_OUT_DIR           output dir (local on node when SSH_TARGET=local)
#
# Set by HCL environment_vars:
#   CF_BUILT_VMID / CF_RECIPE_NAME / CF_RECIPE_DISPLAY
#
# Optional: CF_UPLOAD_CMD, CF_PUBLIC_URL_TMPL, CF_KEEP_VM
#   Generated templates use {{recipe}}, {{arch}}, {{sha256}}, and {{group}}.
#   Raw overrides also support {{file}} plus legacy {{name}} / {{filename}}.

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

LOCAL_FILE="$CF_OUT_DIR/${CF_RECIPE_NAME}-${CF_ARCH}.vma.zst"
LOCAL_MODE=0
[ "$SSH_TARGET" = "local" ] && LOCAL_MODE=1
REMOTE_ARTIFACT=""
REMOTE_LOG=""

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

cleanup() {
  if [ -n "$REMOTE_ARTIFACT" ]; then
    _pve "rm -f '$REMOTE_ARTIFACT' '$REMOTE_LOG'" || true
  fi
  if [ "${CF_KEEP_VM:-}" != "1" ]; then
    echo "==> cleanup: destroying VM $CF_BUILT_VMID"
    _pve "qm stop '$CF_BUILT_VMID' --skiplock 1 2>/dev/null || true; \
          qm destroy '$CF_BUILT_VMID' --purge 1 --destroy-unreferenced-disks 1 2>/dev/null || true" || true
  fi
  [ "$LOCAL_MODE" = "0" ] && rm -f "$LOCAL_FILE" || true
}
trap cleanup EXIT

mkdir -p "$CF_OUT_DIR"

# Bake ciuser=root into the template config so clones with --sshkeys /
# --cipassword apply them to root instead of falling through to the distro's
# default cloud-init user (debian/ubuntu/cloud-user/…), which doesn't actually
# exist in these images. Linux only — Windows uses cloudbase-init, not ciuser.
OSTYPE_LINE=$(_pve "qm config '$CF_BUILT_VMID' 2>/dev/null | grep -E '^ostype:' || true")
case "$OSTYPE_LINE" in
  *l24*|*l26*)
    echo "==> setting ciuser=root on VMID $CF_BUILT_VMID"
    _pve "qm set '$CF_BUILT_VMID' --ciuser root >/dev/null"
    ;;
esac

echo "==> setting template name to $CF_RECIPE_NAME"
_pve "qm set '$CF_BUILT_VMID' --name '$CF_RECIPE_NAME' >/dev/null"

# Windows only: refuse to export an image sysprep did not actually generalize.
# Deliberately before the shrink — a failed build then costs no export time, and
# the GPT backup header is still intact for the read-only mount. set -e makes
# this fail the build (see assert-generalized.sh for why it cannot be guest-side).
assert_generalized

# Opt-in disk shrink: recipe declared `# final_disk_size:` and cf forwarded it
# as CF_FINAL_DISK_SIZE. Must run while the VM is stopped, before vzdump.
if [ -n "${CF_FINAL_DISK_SIZE:-}" ]; then
  echo "==> shrinking disk to $CF_FINAL_DISK_SIZE before vzdump"
  shrink_disk
fi

echo "==> vzdump VMID $CF_BUILT_VMID"
_pve "vzdump $CF_BUILT_VMID --compress zstd --mode stop --dumpdir $PVE_DUMP_DIR"

echo "==> locating artifact"
REMOTE_ARTIFACT=$(_pve "ls -t $PVE_DUMP_DIR/vzdump-qemu-${CF_BUILT_VMID}-*.vma.zst | head -1")
[ -n "$REMOTE_ARTIFACT" ] || { echo "no artifact found"; exit 1; }
REMOTE_LOG="${REMOTE_ARTIFACT%.vma.zst}.log"

if [ "$LOCAL_MODE" = "1" ]; then
  echo "==> moving $REMOTE_ARTIFACT -> $LOCAL_FILE"
  mv "$REMOTE_ARTIFACT" "$LOCAL_FILE"
else
  echo "==> downloading $REMOTE_ARTIFACT -> $LOCAL_FILE"
  scp "$SSH_TARGET:$REMOTE_ARTIFACT" "$LOCAL_FILE"
fi

echo "==> removing dump intermediates"
_pve "rm -f '$REMOTE_ARTIFACT' '$REMOTE_LOG'"

echo "==> destroying VM $CF_BUILT_VMID"
if [ "${CF_KEEP_VM:-}" = "1" ]; then
  echo "==> CF_KEEP_VM=1: skipping destroy"
else
  _pve "qm stop '$CF_BUILT_VMID' --skiplock 1 2>/dev/null || true; \
        qm destroy '$CF_BUILT_VMID' --purge 1 --destroy-unreferenced-disks 1" || true
fi

echo "==> hashing"
SHA256=$(sha256sum "$LOCAL_FILE" | awk '{print $1}')
SIZE=$(wc -c <"$LOCAL_FILE" | tr -d ' ')
UPLOAD_FILENAME="${CF_RECIPE_NAME}-${CF_ARCH}-${SHA256}.vma.zst"

PUBLIC_URL=""
if [ -n "${CF_PUBLIC_URL_TMPL:-}" ]; then
  PUBLIC_URL="${CF_PUBLIC_URL_TMPL//\{\{recipe\}\}/$CF_RECIPE_NAME}"
  PUBLIC_URL="${PUBLIC_URL//\{\{name\}\}/$CF_RECIPE_NAME}"
  PUBLIC_URL="${PUBLIC_URL//\{\{arch\}\}/$CF_ARCH}"
  PUBLIC_URL="${PUBLIC_URL//\{\{sha256\}\}/$SHA256}"
  PUBLIC_URL="${PUBLIC_URL//\{\{group\}\}/$CF_GROUP}"
  PUBLIC_URL="${PUBLIC_URL//\{\{filename\}\}/$UPLOAD_FILENAME}"
fi

if [ -n "${CF_UPLOAD_CMD:-}" ]; then
  echo "==> uploading"
  CMD="${CF_UPLOAD_CMD//\{\{file\}\}/$LOCAL_FILE}"
  CMD="${CMD//\{\{recipe\}\}/$CF_RECIPE_NAME}"
  CMD="${CMD//\{\{name\}\}/$CF_RECIPE_NAME}"
  CMD="${CMD//\{\{arch\}\}/$CF_ARCH}"
  CMD="${CMD//\{\{sha256\}\}/$SHA256}"
  CMD="${CMD//\{\{group\}\}/$CF_GROUP}"
  CMD="${CMD//\{\{filename\}\}/$UPLOAD_FILENAME}"
  bash -c "$CMD"
fi

echo "==> writing sidecar"
SIDECAR="$CF_OUT_DIR/${CF_RECIPE_NAME}-${CF_ARCH}.json"
# Write to .tmp then rename so a partial/crashed write can't leave a sidecar
# whose sha256 disagrees with the artifact next to it.
cat >"$SIDECAR.tmp" <<JSON
{
  "name": "${CF_RECIPE_NAME}-${CF_ARCH}",
  "display": "$CF_RECIPE_DISPLAY",
  "arch": "$CF_ARCH",
  "group": "$CF_GROUP",
  "sha256": "$SHA256",
  "size": $SIZE,
  "suggested_vmid": ${BASE_VMID},
  "url": "$PUBLIC_URL",
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
mv "$SIDECAR.tmp" "$SIDECAR"

if [ -n "${CF_SIDECAR_UPLOAD_CMD:-}" ]; then
  echo "==> uploading sidecar"
  SCMD="${CF_SIDECAR_UPLOAD_CMD//\{\{file\}\}/$SIDECAR}"
  SCMD="${SCMD//\{\{recipe\}\}/$CF_RECIPE_NAME}"
  SCMD="${SCMD//\{\{name\}\}/$CF_RECIPE_NAME}"
  SCMD="${SCMD//\{\{arch\}\}/$CF_ARCH}"
  SCMD="${SCMD//\{\{sha256\}\}/$SHA256}"
  SCMD="${SCMD//\{\{group\}\}/$CF_GROUP}"
  SCMD="${SCMD//\{\{filename\}\}/${CF_RECIPE_NAME}-${CF_ARCH}-${SHA256}.json}"
  bash -c "$SCMD"
fi

trap - EXIT
echo "==> done: $SIDECAR"
