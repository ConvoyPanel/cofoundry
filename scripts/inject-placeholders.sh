#!/usr/bin/env bash
# inject-placeholders.sh — pre-build CI helper.
#
# Generates ephemeral credentials, substitutes __PACKER_*__ tokens in recipe
# files, and writes a Packer vars file so the build step can pass the
# generated secrets to packer build.
#
# Usage: bash scripts/inject-placeholders.sh <recipe-name>
# Output: path to the generated .pkrvars.hcl file (printed to stdout)

set -euo pipefail
umask 077

RECIPE="${1:?usage: inject-placeholders.sh <recipe-name>}"
RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
VARS_FILE="${RUNNER_TEMP}/packer-vars-${RECIPE}.pkrvars.hcl"

# Recreate rather than truncate so an old permissive mode cannot survive.
rm -f "$VARS_FILE"
: >"$VARS_FILE"

RECIPE_DIR="recipes/${RECIPE}"

# Debian package mirror, from the recipe's `# mirror:` header. It has to reach
# the preseed file rather than the boot command: the installer loads the file
# with debconf-set-selections after applying boot parameters, so a key the
# shared preseed sets would silently override a boot-command value.
DEBIAN_MIRROR="$(sed -nE 's/^#[[:space:]]*mirror:[[:space:]]*([^[:space:]]+).*/\1/p' "recipes/${RECIPE}.pkr.hcl" 2>/dev/null | head -n1 || true)"
DEBIAN_MIRROR="${DEBIAN_MIRROR:-deb.debian.org}"

# ── Detect installer files and generate ephemeral SSH keypair ────────────────
PRESEED="${RECIPE_DIR}/http/preseed.cfg"
USER_DATA="${RECIPE_DIR}/http/user-data"
KS="${RECIPE_DIR}/http/ks.cfg"
KS_ALIAS="${RECIPE_DIR}/http/ks"

NEEDS_KEY=0
[ -f "$PRESEED" ] && NEEDS_KEY=1
[ -f "$USER_DATA" ] && NEEDS_KEY=1
[ -f "$KS" ] && NEEDS_KEY=1

if [ "$NEEDS_KEY" = "1" ]; then
  KEY_FILE="${RUNNER_TEMP}/packer_key_${RECIPE}"
  rm -f "$KEY_FILE" "${KEY_FILE}.pub"
  ssh-keygen -t ed25519 -N "" -C "packer-${RECIPE}-${GITHUB_RUN_ID:-local}" \
    -f "$KEY_FILE" >/dev/null
  chmod 600 "$KEY_FILE"
  PUB_KEY="$(cat "${KEY_FILE}.pub")"

  for f in "$PRESEED" "$USER_DATA" "$KS"; do
    [ -f "$f" ] || continue
    WORK="${RUNNER_TEMP}/inject-work-$(basename "$f")-${RECIPE}"
    sed -E \
      "s|__PACKER_SSH_PUBLIC_KEY__|${PUB_KEY}|g; \
       s|ssh-ed25519 AAAA[^ ]+ packer-${RECIPE}-[^ '\"]*|${PUB_KEY}|g; \
       s|__PACKER_RECIPE_NAME__|${RECIPE}|g; \
       s|__PACKER_DEBIAN_MIRROR__|${DEBIAN_MIRROR}|g; \
       s|__PACKER_BUILD_IP__|${CF_BUILD_IP:-}|g; \
       s|__PACKER_BUILD_GW__|${CF_BUILD_GW:-}|g; \
       s|__PACKER_BUILD_DNS__|${CF_BUILD_DNS:-1.1.1.1}|g" \
      "$f" >"$WORK"
    cp "$WORK" "$f"
  done

  # Keep the kernel command-line kickstart URL short and punctuation-light. Some
  # Anaconda boot paths have mangled `/ks.cfg` when typed through the bootloader.
  [ -f "$KS" ] && cp "$KS" "$KS_ALIAS"

  printf 'packer_ssh_private_key_file = "%s"\n' "$KEY_FILE" >>"$VARS_FILE"
fi

# ── Windows: ephemeral admin password ───────────────────────────────────────
AUTOUNATTEND="${RECIPE_DIR}/autounattend.xml"
if [ -f "$AUTOUNATTEND" ]; then
  WIN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=\n' | head -c 24)"
  AUTOUNATTEND_WORK="${RUNNER_TEMP}/autounattend-${RECIPE}.xml"
  sed "s|__PACKER_ADMIN_PASSWORD__|${WIN_PASSWORD}|g" "$AUTOUNATTEND" >"$AUTOUNATTEND_WORK"
  cp "$AUTOUNATTEND_WORK" "$AUTOUNATTEND"
  chmod 600 "$AUTOUNATTEND"
  printf 'winrm_password = "%s"\n' "$WIN_PASSWORD" >>"$VARS_FILE"
fi

echo "$VARS_FILE"
