#!/usr/bin/env bash
# cf-cluster-templates.sh
#
# Post-build helper for a Proxmox CLUSTER: turn the freshly-built cofoundry
# artifacts into a clonable template on EVERY node, each with its own VMID
# (cluster VMIDs are globally unique, so nodes cannot share one id).
#
# Wire in as the build node's CF_SIDECAR_UPLOAD_CMD in .env:
#   CF_SIDECAR_UPLOAD_CMD=bash $PVE_DUMP_DIR/cofoundry-work/scripts/cf-cluster-templates.sh {{file}}
#
# NOT CF_UPLOAD_CMD. A template is several images now (a system disk and, on
# OVMF recipes, an EFI varstore), and CF_UPLOAD_CMD fires once PER IMAGE — this
# script would be handed a bare .qcow2 with no idea what else belongs to it.
# CF_SIDECAR_UPLOAD_CMD fires once per template, after every image has been
# written, and hands over the sidecar that names them all.
#
# Reads from the environment (set by the recipe's post-processor):
#   CF_RECIPE_BASE_VMID or CF_BUILT_VMID (required)
#
# CF_BUILT_VMID is the slot-derived build id (recipe base * 100 + slot index)
# for parallel builds; CF_RECIPE_BASE_VMID is the recipe base cf exports for
# the per-node template numbering. Plain builds set only CF_BUILT_VMID = base.
#
# Per-node VMID = node_id * OFFSET + BASE_VMID   (OFFSET default 10000)
#   base 4001 -> node1=14001, node2=24001, node3=34001
#
# Exits non-zero when any online node failed to end up with a verified
# template; offline nodes are reported but do not fail the run (deliberate
# node downtime should not fail every build).
#
# LOCAL/cluster convenience — not part of the upstream recipes.

# Intentionally no `-e`: we want the per-node loop to keep going on a single
# node's failure (logged as `[fail]`) rather than aborting the whole run.
set -uo pipefail

SIDECAR="${1:?usage: cf-cluster-templates.sh <sidecar-path>}"
[ -f "$SIDECAR" ] || {
  echo "cf-cluster-templates: sidecar '$SIDECAR' not found" >&2; exit 1; }
SRC_DIR="$(cd "$(dirname "$SIDECAR")" && pwd)"

# cf exports the recipe BASE directly. CF_BUILT_VMID is the slot-derived build
# id (recipe base * 100 + slot index) for parallel builds; the per-node template
# numbering needs the base, so prefer CF_RECIPE_BASE_VMID. A plain (non-slot)
# build doesn't set it — CF_BUILT_VMID is then the base itself.
BASE_VMID="${CF_RECIPE_BASE_VMID:-${CF_BUILT_VMID:?CF_BUILT_VMID or CF_RECIPE_BASE_VMID not set}}"
DUMP_DIR="${PVE_DUMP_DIR:-/var/lib/vz/dump}"
# Overridable for tests; on a real node this is the pmxcfs cluster state file.
MEMBERS_FILE="${CF_MEMBERS_FILE:-/etc/pve/.members}"

# --- knobs (edit to taste) -------------------------------------------------
# Preferred per-node disk storage. Nodes that don't have it (e.g. a ZFS node
# with local-zfs instead of local-lvm) auto-pick their best images-capable
# storage: local over shared, then most free space.
STORAGE="${CF_TEMPLATE_STORAGE:-local-lvm}"
OFFSET="${CF_TEMPLATE_VMID_OFFSET:-10000}"     # per-node VMID spacing
BRIDGE="${CF_TEMPLATE_BRIDGE:-vmbr0}"          # NIC bridge for the templates
# ---------------------------------------------------------------------------

# Adjacent nodes collide if BASE_VMID >= OFFSET (e.g. node1+14001 == node2+4001).
if [ "$BASE_VMID" -ge "$OFFSET" ]; then
  echo "cf-cluster-templates: derived base VMID ($BASE_VMID) must be < CF_TEMPLATE_VMID_OFFSET ($OFFSET)" >&2
  exit 1
fi

# Read the sidecar once. `IMAGES` is one "<local-name> <sha256>" per line; the
# published `file` carries the content hash while the file sitting next to the
# sidecar does not, so the local name is the published one with the hash
# removed (mirrors localArtifactName in src/upload/template.ts).
read_sidecar() {
  python3 - "$SIDECAR" "$1" <<'CF_READ_PY'
import json, sys

doc = json.load(open(sys.argv[1]))
name = doc["name"]
if sys.argv[2] == "images":
    for disk in doc.get("disks", []):
        local = disk["file"].replace(f"{name}-{disk['sha256']}", name)
        print(local, disk["sha256"])
elif sys.argv[2] == "name":
    print(name)
CF_READ_PY
}

mapfile -t IMAGES < <(read_sidecar images)
TEMPLATE_NAME="$(read_sidecar name)"
if [ "${#IMAGES[@]}" -eq 0 ]; then
  echo "cf-cluster-templates: sidecar '$SIDECAR' lists no disks" >&2
  exit 1
fi

for entry in "${IMAGES[@]}"; do
  read -r img _ <<<"$entry"
  [ -f "$SRC_DIR/$img" ] || {
    echo "cf-cluster-templates: image '$SRC_DIR/$img' named by the sidecar is missing" >&2
    exit 1; }
done

SSHOPT=(-o StrictHostKeyChecking=accept-new -o BatchMode=yes -o ConnectTimeout=8)

# Local IPv4s — used to skip scp-to-self (the images are already on this node).
LOCAL_IPS=" $(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"

is_local_ip() {
  [[ "$LOCAL_IPS" == *" $1 "* ]]
}

# Copy one image into the target node's dump dir (cp for this host, scp for
# remote nodes).
copy_to_node() {
  local ip="$1" img="$2"
  if is_local_ip "$ip"; then
    # -ef: already the same file (images live in the dump dir) — no copy.
    [ "$SRC_DIR/$img" -ef "$DUMP_DIR/$img" ] || cp -f "$SRC_DIR/$img" "$DUMP_DIR/$img"
  else
    scp -q "${SSHOPT[@]}" "$SRC_DIR/$img" "root@$ip:$DUMP_DIR/$img"
  fi
}

checksum_matches() {
  local ip="$1" img="$2" want="$3" actual
  if is_local_ip "$ip"; then
    actual="$(sha256sum "$DUMP_DIR/$img" 2>/dev/null | awk '{print $1}')"
  else
    actual="$(ssh "${SSHOPT[@]}" "root@$ip" "sha256sum '$DUMP_DIR/$img'" 2>/dev/null | awk '{print $1}')"
  fi
  [ "$actual" = "$want" ]
}

# Drop copies from the target node — but never the source images themselves
# (the local-node "copy" can be the image already in place).
remove_copies() {
  local ip="$1" entry img
  for entry in "${IMAGES[@]}"; do
    read -r img _ <<<"$entry"
    if is_local_ip "$ip"; then
      [ "$SRC_DIR/$img" -ef "$DUMP_DIR/$img" ] || rm -f "$DUMP_DIR/$img"
    else
      ssh "${SSHOPT[@]}" "root@$ip" "rm -f '$DUMP_DIR/$img'" || true
    fi
  done
}

# Copy + verify every image for one node. All of them must land before the
# node's existing template is touched: a template whose varstore failed to
# transfer is unbootable, and replacing a working one with that is worse than
# skipping the node.
stage_images() {
  local ip="$1" entry img want
  for entry in "${IMAGES[@]}"; do
    read -r img want <<<"$entry"
    if ! copy_to_node "$ip" "$img"; then
      echo "    [fail] could not copy $img to $ip"
      return 1
    fi
    if ! checksum_matches "$ip" "$img" "$want"; then
      echo "    [warn] checksum mismatch for $img on $ip — retrying copy"
      if ! copy_to_node "$ip" "$img" || ! checksum_matches "$ip" "$img" "$want"; then
        echo "    [fail] checksum mismatch for $img on $ip after retry — existing template left untouched"
        return 1
      fi
    fi
  done
  return 0
}

# node_id + ip for every online member, from the cluster state file
mapfile -t NODES < <(
  grep -oE '"id": [0-9]+, "online": 1, "ip": "[0-9.]+"' "$MEMBERS_FILE" 2>/dev/null \
    | sed -E 's/.*"id": ([0-9]+).*"ip": "([0-9.]+)".*/\1 \2/'
)
# Offline members carry no "ip" field — collect name + id for the summary.
mapfile -t OFFLINE_NODES < <(
  grep -oE '"[^"]+": \{ "id": [0-9]+, "online": 0' "$MEMBERS_FILE" 2>/dev/null \
    | sed -E 's/^"([^"]+)": \{ "id": ([0-9]+).*/\1 (id \2)/'
)
if [ "${#NODES[@]}" -eq 0 ]; then
  echo "cf-cluster-templates: no online cluster nodes found in $MEMBERS_FILE" >&2
  exit 1
fi
for node in "${OFFLINE_NODES[@]}"; do
  echo "==> [offline] $node — skipping, will not receive this template" >&2
done

echo "==> $TEMPLATE_NAME (${#IMAGES[@]} image(s)) -> clonable template on ${#NODES[@]} node(s) (preferred storage=$STORAGE)"

OK_COUNT=0
FAILED_NODES=()

for line in "${NODES[@]}"; do
  read -r ID IP <<<"$line"
  [ -n "$ID" ] && [ -n "$IP" ] || continue
  VMID=$(( ID * OFFSET + BASE_VMID ))
  echo "==> node $ID ($IP) -> template $VMID"

  # Verify every transfer BEFORE touching the node's existing template: a
  # corrupt or missing image must never destroy a working template.
  if ! stage_images "$IP"; then
    remove_copies "$IP"
    FAILED_NODES+=("node $ID ($IP): image staging failed")
    continue
  fi

  # Replace only a template we own at this id; never clobber a real VM.
  # Same script for local + remote — pipe to bash directly for local to skip
  # the ssh roundtrip.
  SIDECAR_JSON="$(cat "$SIDECAR")"
  CREATE_SCRIPT=$(cat <<EOF
set -e
DESTROYED=0
cleanup() {
  # Failure path: qm create did not finish. Keep the verified images for a
  # manual retry and tell the operator the state of this node, so a
  # half-finished replacement is never silent.
  if [ "\$DESTROYED" = 1 ]; then
    echo "    [fail] qm create did not complete on \$(hostname) — the previous template at $VMID was already destroyed, so this node now has NO template at $VMID; the verified images are kept in $DUMP_DIR for a manual retry" >&2
  else
    echo "    [fail] qm create did not complete on \$(hostname) — no template was created at $VMID; the verified images are kept in $DUMP_DIR for a manual retry" >&2
  fi
}
trap cleanup EXIT
# Pick this node's storage, in order: the preferred one, then the standard
# Proxmox-installer storages (local-lvm, local-zfs), then as a last resort the
# best active images-capable storage (local over shared, VM-native types over
# dir, most free first).
STG=\$(pvesh get /nodes/\$(hostname)/storage --content images --output-format json 2>/dev/null | python3 -c "
import json, sys
rows = [s for s in json.load(sys.stdin) if s.get('active')]
names = [s['storage'] for s in rows]
for pref in ('$STORAGE', 'local-lvm', 'local-zfs'):
    if pref in names:
        print(pref)
        break
else:
    local = [s for s in rows if not s.get('shared')]
    rows = local if local else rows
    vm_native = ('lvmthin', 'zfspool', 'btrfs', 'rbd', 'lvm')
    rows.sort(key=lambda s: (0 if s.get('type') in vm_native else 1, -s.get('avail', 0)))
    print(rows[0]['storage'] if rows else '')
")
if [ -z "\$STG" ]; then
  echo "    [fail] no active images-capable storage on \$(hostname)"
  exit 1
fi
if qm status $VMID >/dev/null 2>&1; then
  if ! qm config $VMID 2>/dev/null | grep -q '^template:'; then
    echo "    [skip] VMID $VMID is a real (non-template) VM — leaving it alone"
    trap - EXIT
    exit 0
  fi
  qm stop $VMID --skiplock 1 >/dev/null 2>&1 || true
  qm destroy $VMID --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1 || true
  DESTROYED=1
fi
# The qm create flags are rendered HERE rather than on the build node, because
# only this node knows its own \$STG. The sidecar rides along inline.
#
# This mirrors createArgs in src/registry/create.ts, the canonical builder that
# coport and cf verify share. It is re-implemented because this runs on a
# cluster node, where bun is not installed — keep the two in step when the
# profile grows a field.
cat > $DUMP_DIR/cf-cluster-$VMID.json <<'CF_SIDECAR_JSON'
$SIDECAR_JSON
CF_SIDECAR_JSON
FLAGS=\$(python3 - $DUMP_DIR/cf-cluster-$VMID.json "\$STG" "$BRIDGE" "$DUMP_DIR" <<'CF_FLAGS_PY'
import json, shlex, sys

doc = json.load(open(sys.argv[1]))
storage, bridge, dump = sys.argv[2], sys.argv[3], sys.argv[4]
hw = doc.get("hardware", {})
minimum = doc.get("minimum", {})
name = doc["name"]

args = ["--name", name]
# net_model and tpm name a thing to allocate, not a value to set; a literal
# `--net_model virtio` would be rejected by qm.
for key, value in hw.items():
    if key in ("net_model", "tpm"):
        continue
    args += [f"--{key}", str(value)]
args += ["--cores", str(minimum.get("cores", 2))]
args += ["--memory", str(minimum.get("memory", 2048))]

boot = None
for disk in doc.get("disks", []):
    local = disk["file"].replace(f"{name}-{disk['sha256']}", name)
    opts = "".join(f",{k}={v}" for k, v in (disk.get("options") or {}).items())
    args += [f"--{disk['slot']}", f"{storage}:0,import-from={dump}/{local}{opts}"]
    if disk.get("role") == "system":
        boot = disk["slot"]

# Allocated fresh, never imported: the image is generalized so nothing is
# sealed to the TPM, and one shipped varstore would give every VM the same EK.
if hw.get("tpm"):
    args += ["--tpmstate0", f"{storage}:0,version={hw['tpm']}"]
args += ["--ide2", f"{storage}:cloudinit"]
args += ["--net0", f"{hw.get('net_model', 'virtio')},bridge={bridge}"]
if boot:
    args += ["--boot", f"order={boot}"]
print(" ".join(shlex.quote(a) for a in args))
CF_FLAGS_PY
)
rm -f $DUMP_DIR/cf-cluster-$VMID.json
[ -n "\$FLAGS" ] || { echo "    [fail] could not build qm create flags on \$(hostname)"; exit 1; }
# import-from accepts an absolute path, so the images are imported straight
# out of the dump dir — no import-content storage has to exist on the node.
eval "qm create $VMID \$FLAGS" >/dev/null
qm template $VMID >/dev/null
trap - EXIT
echo "    [ok] template $VMID on \$STG"
EOF
  )
  if is_local_ip "$IP"; then
    CREATE_OK=0
    bash -c "$CREATE_SCRIPT" && CREATE_OK=1
  else
    CREATE_OK=0
    ssh "${SSHOPT[@]}" "root@$IP" bash -s <<<"$CREATE_SCRIPT" && CREATE_OK=1
  fi
  if [ "$CREATE_OK" = "1" ]; then
    OK_COUNT=$(( OK_COUNT + 1 ))
    # Success: the images are now imported into the node's storage, so the
    # dump-dir copies are dead weight (multi-gigabyte, on every node).
    remove_copies "$IP"
  else
    echo "    [fail] $IP"
    FAILED_NODES+=("node $ID ($IP): create failed")
  fi
done

echo "==> cluster template distribution: $OK_COUNT/${#NODES[@]} node(s) ok, ${#FAILED_NODES[@]} failed, ${#OFFLINE_NODES[@]} offline"
if [ "${#FAILED_NODES[@]}" -gt 0 ]; then
  for failed in "${FAILED_NODES[@]}"; do
    echo "    [failed] $failed" >&2
  done
  exit 1
fi
