# Disk image artifacts

Replaces the `.vma.zst` template artifact with importable disk images. This
document is both the design and the record of the Proxmox 9 behaviour it
depends on — re-read "Verified Proxmox behaviour" before changing any of it.

**Status.** Fully implemented across the export path
(`recipes/_shared/post/`), schema 2 (`src/registry/`, `src/manifest.ts`,
`src/upload/`), `coport`, `cf verify`, `cf prune --r2`, and the optional
cluster-distribution hook (`scripts/cf-cluster-templates.sh`).

**Exercised end to end on Linux.** `cf build debian-12` (14m29s) produced a
623.1 MB compressed qcow2 plus a schema-2 sidecar, and `cf verify debian-12`
rebuilt a VM from that sidecar through `qm create --import-from` and passed all
17 in-guest checks, including `disk-fully-partitioned` after the post-import
resize. The OVMF path — `efidisk0` export and the two-image sidecar — has still
never run: only a `windows-server-*` build exercises it.

## Why

Today `cf` exports a `vzdump` archive and `coport` restores it with
`qmrestore`, which produces a VM template on the node. Templates carry two
costs that scale badly for a consumer like Convoy:

- every template occupies a VMID, so installs collide with tenant VMs and with
  each other, and `coport` needs conflict resolution, VMID stickiness, and an
  install cache to work around it;
- a template is node-local unless its storage is shared, so the same artifact
  is downloaded and restored on every node in a cluster.

Proxmox 9 can create a VM directly from a disk image, which removes both. The
image is data on a storage, not a VM; nothing reserves a VMID, and an import
store on shared storage serves a whole cluster from one copy.

## Verified Proxmox behaviour

Confirmed against `pve-manager/9.2.2` on `us-southwest-2`. These are the facts
the design rests on — re-verify them before assuming they still hold on a
different release.

| Behaviour                            | Evidence                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `import` content type on by default  | `local` in `/etc/pve/storage.cfg` lists `import`                                                     |
| Download to an import store          | `POST /nodes/{node}/storage/{storage}/download-url`, `content=import`                                |
| Native checksum verification         | same endpoint: `checksum` + `checksum-algorithm` (`sha256` accepted)                                 |
| **No decompression for `import`**    | `API2/Storage/Status.pm:900` — `die "decompression not supported for $content" if $content ne 'iso'` |
| Accepted extensions                  | `Storage.pm:124` — `UPLOAD_IMPORT_EXT_RE_1 = qr/\.(ova\|qcow2\|raw\|vmdk)/`                          |
| Filename charset                     | `Storage.pm:126` — `SAFE_CHAR_CLASS_RE = qr/[a-zA-Z0-9\-\.\+\=\_]/`                                  |
| Import onto a data disk              | `qm create --scsi0 <storage>:0,import-from=<volume>`                                                 |
| **Import onto the EFI varstore**     | `qm create --efidisk0 <storage>:0,import-from=<volume>`                                              |
| **`import-from` takes an abs. path** | `API2/Qemu.pm:202` — non-volid sources fall through to `check_volume_access`; probed live            |
| Machine type re-pinned per node      | `qm create --machine q35` on a `win*` ostype logs "pinning machine type to 'pc-q35-11.0'"            |
| Format is **not** preserved          | a qcow2 source imported to `local` became `vm-<id>-disk-N.raw` — target follows the storage default  |
| Block-storage targets need a scratch | `qm create --import-working-storage <storage ID>`                                                    |
| Disks cannot shrink after import     | `qm disk resize` — "Extend volume size", "Shrinking disk size is not supported"                      |
| Cloud-init drive format is automatic | `QemuServer/Cloudinit.pm:76` — `configdrive2` for Windows `ostype`, `nocloud` otherwise              |

The `--compression` parameter on `download-url` exists but is rejected for
`import` content, so artifacts cannot ship as `.zst`. Compression has to live
_inside_ the image: `qemu-img convert -c -O qcow2` produces compressed clusters
that qemu reads natively and Proxmox accepts as a plain `.qcow2`.

`--efidisk0 … import-from=` is the feature that makes Windows viable. Without
it there is no way to ship a populated UEFI variable store, and the rest of
this design does not work.

Because `import-from` accepts an absolute path, a consumer does **not** need an
`import`-content storage configured. `coport` downloads into its own temp
directory and imports from there, keeping its existing progress, retry, and
checksum handling. The `download-url` API remains the right path for a consumer
that wants Proxmox to own the fetch (a shared import store serving a cluster).

## The artifact set

Each recipe emits two or three files in place of one `.vma.zst`:

| File                                 | Recipes   | Contents                                           |
| ------------------------------------ | --------- | -------------------------------------------------- |
| `<name>-<arch>-<sha256>.qcow2`       | all       | system disk, already shrunk to `# final_disk_size` |
| `<name>-<arch>-<sha256>.efivars.raw` | OVMF only | UEFI variable store                                |
| `<name>-<arch>.json`                 | all       | sidecar (schema 2)                                 |

Linux recipes are `bios: seabios` and emit no varstore, so the sidecar
describes disks as a list rather than fixed fields.

### What `efivars.raw` is

OVMF is split into read-only firmware code, which lives on the node at
`/usr/share/pve-edk2-firmware/`, and a per-VM writable variable store, which
Proxmox calls `efidisk0`. On a built Windows template it is a 540,672-byte raw
file:

```
/var/lib/vz/images/2002/base-2002-disk-0.raw
efidisk0: local:2002/base-2002-disk-0.raw,efitype=4m,ms-cert=2023k,pre-enrolled-keys=1,size=528K
```

It holds three things that cannot be reconstructed from configuration flags:

- the boot entry Windows Setup wrote (`Boot0000` →
  `\EFI\Microsoft\Boot\bootmgfw.efi`) and `BootOrder`. A freshly allocated
  varstore has neither;
- Secure Boot state — the enrolled PK/KEK/db, the `ms-cert=2023k` Microsoft
  UEFI CA, and any dbx revocations applied during the `WU.ps1` rounds;
- firmware settings such as boot timeout.

It ships as a verbatim copy of that file. At ~540 KB against a 32 G system
disk it is not worth reasoning about whether OVMF would rediscover the
bootloader against fresh variables.

## Sidecar schema 2

Windows Server 2025, derived from `qm config 2002`:

```json
{
    "schema_version": "2",
    "name": "windows-server-2025-amd64",
    "display": "Windows Server 2025 Datacenter",
    "group": "windows-server",
    "arch": "amd64",
    "built_at": "2026-08-04T16:53:31Z",
    "suggested_vmid": 2002,

    "disks": [
        {
            "slot": "scsi0",
            "role": "system",
            "format": "qcow2",
            "file": "windows-server-2025-amd64-<sha256>.qcow2",
            "url": "https://cofoundry.cdn.convoypanel.com/images/…qcow2",
            "sha256": "…",
            "size": 7900000000,
            "virtual_size": "32G",
            "options": { "discard": "on" }
        },
        {
            "slot": "efidisk0",
            "role": "efivars",
            "format": "raw",
            "file": "windows-server-2025-amd64-<sha256>.efivars.raw",
            "url": "https://cofoundry.cdn.convoypanel.com/images/…efivars.raw",
            "sha256": "…",
            "size": 540672,
            "options": {
                "efitype": "4m",
                "pre-enrolled-keys": 1,
                "ms-cert": "2023k"
            }
        }
    ],

    "hardware": {
        "ostype": "win11",
        "bios": "ovmf",
        "machine": "q35",
        "scsihw": "virtio-scsi-single",
        "cpu": "host",
        "agent": 1,
        "net_model": "virtio",
        "tpm": "v2.0"
    },

    "minimum": { "cores": 2, "memory": 4096 }
}
```

Debian 12 is the same shape with one disk and no varstore:

```json
{
    "disks": [
        {
            "slot": "scsi0",
            "role": "system",
            "format": "qcow2",
            "virtual_size": "5G",
            "options": { "discard": "on", "ssd": 1 }
        }
    ],
    "hardware": {
        "ostype": "l26",
        "bios": "seabios",
        "machine": "q35",
        "scsihw": "virtio-scsi-single",
        "cpu": "host",
        "agent": 1,
        "net_model": "virtio",
        "serial0": "socket",
        "ciuser": "root"
    },
    "minimum": { "cores": 1, "memory": 1024 }
}
```

`size` is bytes on the wire; `virtual_size` is what the guest sees after
import.

### Why `minimum` has no `disk`

`import-from` gives the imported disk the source's virtual size, and
`qm disk resize` cannot shrink. The disk floor is therefore enforced
structurally by `disks[0].virtual_size`, and a separate field would only
duplicate it. `cores` and `memory` have no such floor — nothing prevents a
1-core, 512 MB Windows Server 2025 VM — which is why they stay.

A recommendation that exceeds the image size ("32 G boots, but expect to be
full after two patch Tuesdays") is a different number and would need a
different name.

## Building the profile

The `hardware` block is **captured from `qm config` of the built VM**, not
hand-written in HCL. Hand-authored values drift from what was actually built
and booted; captured values cannot.

Capture is a denylist over `qm config`. Two categories come out.

**Build identity** — meaningless or actively wrong on a consumer's node:

`vmid`, `name`, `smbios1`, `vmgenid`, `meta`, `description`, `template`, the
`net0` `macaddr` (that is `build_mac` from the NAT slot), and the `ide*`
CD-ROM mounts for the boot ISO, virtio ISO, and answer-file ISO.

Dropping the macaddr is not hygiene, it is a bug fix. `coport` used to install
with `qmrestore` and **without** `--unique`, so every template it installed kept
the build VM's MAC. Build MACs are deterministic per netslot, and the netslot
allocator evicts any VM carrying the MAC of the slot it is claiming — the
comment at `src/build/netslot.ts:224` assumes such a VM "can only be an orphan
from a previous build", which was never true of a restored template.

Observed live: `cf build debian-12` took netslot 05 (MAC `…:00:9c`) and evicted
six installed templates that shared it —

```
evicting orphan VM 1003 on node us-southwest-2 squatting netslot 05
evicting orphan VM 2001 …  2002 …  4000 …  4001 …  5002 …
```

The ten survivors carried `…:9d`, `…:9e`, `…:9f` — other slots — so the set
destroyed was decided purely by which slot the build drew. A schema-2 template
cannot hit this: the profile records only `net_model`, and `qm create` assigns
a fresh MAC per VM.

`memory` and `cores` come out too: `8192`/`4` on Windows is servicing headroom
for the `WU.ps1` rounds, not a runtime requirement. Publishing it would floor
every consumer plan at 8 GB. The hand-authored `minimum` block replaces it.

**No-op defaults** the packer plugin writes explicitly:

| Field    | Proxmox default | Action |
| -------- | --------------- | ------ |
| `kvm`    | `1`             | omit   |
| `numa`   | `0`             | omit   |
| `onboot` | `0`             | omit   |
| `vga`    | `std`           | omit   |

Everything else is recorded, including values that happen to be identical
across all 18 recipes. The test is **"does getting this wrong break the
image?"**, not "does this value vary?" — those diverge, and `scsihw` is where.
Every recipe builds `virtio-scsi-single` because every image has virtio-scsi
drivers bound to its boot device; hand a Windows image an `lsi` controller and
it stops at `0x7B INACCESSIBLE_BOOT_DEVICE`, and a Linux initramfs built for
`virtio_scsi` may not find root. A predictable value still has to be recorded,
or the consumer is left hardcoding a constant that happens to match.

`cpu: host` is recorded for the same reason. Proxmox's default is not `host`,
and the Windows Server 2025 installer probes SSE4.1/4.2. It does block live
migration between heterogeneous nodes, but that is an override a consumer
makes against a correct baseline — the artifact should not pre-decide it for
every non-Convoy user of `coport`.

`agent: 1` is recorded because the Proxmox default is `0`. All 18 images ship
`qemu-guest-agent`: Linux recipes set `qemu_agent = true` and install it via
preseed/kickstart/user-data, Windows installs it from
`virtio-win-guest-tools.exe` in `Install.ps1`. Omitting the field would cost
every standalone install IP reporting and filesystem freeze on backup.

### Values to normalize during capture

Two captured values must not be published verbatim.

**`machine: pc-q35-11.0`.** The build pins a QEMU machine version. Published
as-is, the image will not start on a node running older QEMU — a hard failure,
not a degradation.

Publishing the bare type is not merely safe, it is what Proxmox wants: creating
a VM with `--machine q35` on a `win*` ostype makes Proxmox pin the version
_itself_, against the target node's QEMU —

```
# qm create … --ostype win11 --machine q35
pinning machine type to 'pc-q35-11.0' for Windows guest OS
```

so every consumer gets a version its own node actually has. A published pin
could only ever name someone else's QEMU.

**`ide3` for the cloud-init drive.** Windows templates land on `ide3` only
because `ide0`–`ide2` held the boot ISO, virtio ISO, and answer-file ISO during
the build. That is build scaffolding leaking into the template. Cloudbase-Init
locates the config drive by label, not slot, so the consumer allocates `ide2`.

## Consuming an artifact

The cloud-init drive and TPM state are allocated fresh by the consumer, not
downloaded. The image is generalized, so nothing is sealed to the TPM, and a
shipped varstore would give every VM the same EK.

```sh
# 1. fetch into the import store (idempotent; re-running is safe)
pvesh create /nodes/localhost/storage/local/download-url \
  --content import --filename windows-server-2025-amd64-<sha>.qcow2 \
  --url https://…/windows-server-2025-amd64-<sha>.qcow2 \
  --checksum <sha256> --checksum-algorithm sha256

# 2. create the VM from the profile
qm create 9001 \
  --ostype win11 --bios ovmf --machine q35 \
  --scsihw virtio-scsi-single --cpu host --agent 1 \
  --cores 4 --memory 8192 \
  --efidisk0 local:0,import-from=local:import/…efivars.raw,efitype=4m,pre-enrolled-keys=1,ms-cert=2023k \
  --scsi0 local:0,import-from=local:import/…qcow2,discard=on \
  --tpmstate0 local:0,version=v2.0 \
  --ide2 local:cloudinit \
  --net0 virtio,bridge=vmbr0 \
  --boot order=scsi0

# 3. grow to the plan size (extend only)
qm disk resize 9001 scsi0 80G
```

Growth on first boot is already handled in-guest: Linux via
`cloud-initramfs-growroot`, Windows via Cloudbase-Init's `ExtendVolumesPlugin`,
which `Finalize.ps1` includes in its plugin list.

`citype` is deliberately not passed. Proxmox derives it from `ostype`
(`configdrive2` for Windows, `nocloud` for Linux), and the sidecar already
carries `ostype`.

### Cloud-init capabilities are derived from `ostype`

The sidecar does not describe which cloud-init knobs are safe to send, because
`ostype` already determines it. Consumers must branch on it, and for Windows
the failure is not graceful:

- **`sshkeys` breaks provisioning.** `SetUserSSHPublicKeysPlugin` is omitted
  from the Cloudbase-Init plugin list, and with `--sshkeys` metadata present
  the plugin fails outright with `[WinError 2]` — observed live on a 2019
  clone. See `recipes/_shared/windows/Finalize.ps1:241`.
- **`ciuser` is ignored.** `CreateUserPlugin` is omitted deliberately;
  `SetUserPasswordPlugin` applies the password to the existing Administrator.
- **Readiness takes minutes, not seconds.** Cloudbase-Init runs `delayed-auto`
  after a full OOBE pass, so polling tuned for Debian will time out.

## Resolved by live probe

Both were probed on `us-southwest-2` by creating a scratch VM from a copy of
the real `windows-server-2025` varstore and destroying it again.

1. **`pre-enrolled-keys`/`ms-cert` alongside `import-from` on `efidisk0`** — no
   conflict. The imported bytes are authoritative and the flags are recorded as
   metadata beside them. `cmp` against the source varstore reported identical,
   and the resulting config read
   `efidisk0: local:…,efitype=4m,ms-cert=2023k,pre-enrolled-keys=1,size=528K`.
   Pass them to match the source, which is what `coport` does.
2. **`machine: q35` on a generalized Windows image** — Proxmox pins the version
   per node at create time (see above), so the bare type is correct to publish.

## Open questions

1. **Full copy per VM.** `import-from` copies; there are no linked clones. For
   multi-tenant use this is arguably correct — a linked clone can never have
   its base deleted or updated — but provisioning latency and space use change,
   and that should be measured before cutover.
2. **Artifact size — measured, ~16% larger.** The first real build of
   `debian-12` produced a 623.1 MB compressed qcow2 against the 536.1 MB
   `.vma.zst` it replaced (+87.0 MB, +16.2%). zstd on a vzdump stream beats
   qcow2's per-cluster zlib, and the import path cannot take a `.zst` wrapper.
   Comparable rather than equal, and the cost is paid per download. Worth
   re-measuring on a Windows recipe, where the absolute numbers are ~50x
   larger, before deciding whether it matters.
3. **Imported format follows the target storage, not the source.** A compressed
   qcow2 imported onto dir storage lands as `raw`. It is sparse, so the cost is
   bounded, but a `coport`-installed template no longer gets qcow2's linked-clone
   support on file storages the way a `qmrestore`d one did. Passing `format=`
   would fix it for dir storages and break block storages, so it needs a
   storage-capability probe rather than a constant.

## Impact on `cf` and `coport`

`recipes/_shared/post/export-and-cleanup.sh` stops calling `vzdump`. After the
existing shrink it exports the disks — the system disk via
`qemu-img convert -c -O qcow2`, the varstore as a byte copy — hashes each, and
writes the schema-2 sidecar. The `assert_generalized` and `shrink_disk` steps
are unchanged and still run first.

`cf verify` exercises the import path rather than `qmrestore`, building its
scratch VM through the same `src/registry/create.ts` builder `coport` installs
with, so the profile is a tested artifact rather than metadata nobody checks. A
profile that is never used to boot anything will drift. It reads the published
sidecar rather than the build VM, and boots at the recipe's build shape rather
than the profile's `minimum` — the floor is what a consumer may configure, while
the checks want the resources the recipe was exercised with.

`cf prune --r2` retains **generations**: a sidecar plus the images it names.
Objects are matched to a generation by the sha256 embedded in their key, since
`[upload].key` is user-configurable and any rule parsing the path breaks on some
layout.

`coport` keeps its current role — installing templates for admins who want
them — and gains a step: download images, `qm create` from the profile, then
`qm template`. Its VMID machinery stays, because a template still occupies a
VMID. Breaking existing installs is acceptable while this is a developer
preview.

Registry `schema_version` goes to `"2"`. Schema-1 consumers will not understand
the new sidecar and are not expected to.
