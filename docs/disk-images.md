# Disk image artifacts

Cofoundry publishes importable disk images, and `coport` installs them with
`qm create --import-from`. This replaced the `.vma.zst` + `qmrestore` path in
2.0.0; the two are not compatible in either direction.

This document records the Proxmox 9 behaviour the format depends on. **Re-verify
"Proxmox behaviour this depends on" before changing any of it** — every design
decision below rests on one of those rows.

## Why images instead of archives

A `.vma.zst` can only be restored into a VMID. That gave templates two costs
that scale badly for a consumer like Convoy:

- every template occupies a VMID, so installs collide with tenant VMs and with
  each other, requiring conflict resolution, VMID stickiness, and an install
  cache to work around it;
- a template is node-local unless its storage is shared, so the same artifact is
  downloaded and restored on every node in a cluster.

An image is just a file. Nothing reserves a VMID, the VM is rebuilt around the
image from the hardware profile the build recorded, and an import store on shared
storage serves a whole cluster from one copy.

**The cost is size: roughly +10–16%.** `debian-12` went 536.1 MB → 623.1 MB
(+16.2%), `windows-server-2025` 9.49 GB → 10.49 GB (+10.6%). zstd over a vzdump
stream beats qcow2's per-cluster zlib and the import path cannot take a `.zst`
wrapper, so the penalty is permanent — but it shrinks with image size, and
Windows is where the absolute numbers matter.

## Proxmox behaviour this depends on

Confirmed against `pve-manager/9.2.2` on `us-southwest-2`.

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
| **`import-from` takes an abs. path** | `API2/Qemu.pm:202` — non-volid sources fall through to `check_volume_access`; probed live             |
| Machine type re-pinned per node      | `qm create --machine q35` on a `win*` ostype logs "pinning machine type to 'pc-q35-11.0'"            |
| Format is **not** preserved          | a qcow2 source imported to `local` became `vm-<id>-disk-N.raw` — target follows the storage default  |
| Block-storage targets need a scratch | `qm create --import-working-storage <storage ID>`                                                    |
| Disks cannot shrink after import     | `qm disk resize` — "Extend volume size", "Shrinking disk size is not supported"                      |
| Cloud-init drive format is automatic | `QemuServer/Cloudinit.pm:76` — `configdrive2` for Windows `ostype`, `nocloud` otherwise              |
| `pre-enrolled-keys`/`ms-cert` alongside `import-from` | Probed live: no conflict — imported bytes are authoritative, flags are metadata beside them. `cmp` against the source varstore reported identical |

Two consequences worth stating outright:

- **Artifacts cannot ship as `.zst`.** The `--compression` parameter on
  `download-url` exists but is rejected for `import` content, so compression has
  to live *inside* the image: `qemu-img convert -c -O qcow2` produces compressed
  clusters that qemu reads natively and Proxmox accepts as a plain `.qcow2`.
- **`--efidisk0 … import-from=` is what makes Windows viable.** Without it there
  is no way to ship a populated UEFI variable store, and none of this works.

Because `import-from` accepts an absolute path, a consumer does **not** need an
`import`-content storage configured. `coport` downloads into its own temp
directory and imports from there, keeping its existing progress, retry, and
checksum handling. The `download-url` API remains the right path for a consumer
that wants Proxmox to own the fetch (a shared import store serving a cluster).

## The artifact set

| File                                 | Recipes   | Contents                                           |
| ------------------------------------ | --------- | -------------------------------------------------- |
| `<name>-<arch>-<sha256>.qcow2`       | all       | system disk, already shrunk to `# final_disk_size` |
| `<name>-<arch>-<sha256>.efivars.raw` | OVMF only | UEFI variable store                                |
| `<name>-<arch>.json`                 | all       | sidecar (schema 2)                                 |

Linux recipes are `bios: seabios` and emit no varstore, so the sidecar describes
disks as a list rather than fixed fields.

**The varstore ships verbatim** because it holds three things a freshly allocated
one does not have: the boot entry Windows Setup wrote (`Boot0000` →
`\EFI\Microsoft\Boot\bootmgfw.efi`) plus `BootOrder`; the Secure Boot state — the
enrolled PK/KEK/db, the `ms-cert=2023k` Microsoft UEFI CA, and any dbx revocations
applied during the `WU.ps1` rounds; and firmware settings such as boot timeout. At
~540 KB against a 32 G system disk it is not worth reasoning about whether OVMF
would rediscover the bootloader against fresh variables.

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

A Linux recipe is the same shape with one disk, no varstore, and Linux hardware
values (`ostype: l26`, `bios: seabios`, `serial0: socket`, `ciuser`).

`size` is bytes on the wire; `virtual_size` is what the guest sees after import.

**`minimum` has no `disk` field.** `import-from` gives the imported disk the
source's virtual size and `qm disk resize` cannot shrink, so the disk floor is
enforced structurally by `disks[0].virtual_size`; a separate field would only
duplicate it. `cores` and `memory` have no such floor — nothing prevents a 1-core,
512 MB Windows Server 2025 VM — which is why they stay. A *recommendation* that
exceeds the image size ("32 G boots, but expect to be full after two patch
Tuesdays") is a different number and would need a different name.

## How the profile is built

The `hardware` block is **captured from `qm config` of the built VM**, not
hand-written in HCL. Hand-authored values drift from what was actually built and
booted; captured values cannot. Capture is a denylist, so fields Proxmox adds in
future releases flow through on their own.

**Dropped — build identity**, meaningless or actively wrong on a consumer's node:
`vmid`, `name`, `smbios1`, `vmgenid`, `meta`, `description`, `template`, the
`net0` `macaddr`, and the `ide*` CD-ROM mounts for the boot, virtio, and
answer-file ISOs.

Dropping the macaddr is a bug fix, not hygiene. `coport` used to install with
`qmrestore` and **without** `--unique`, so every installed template kept the build
VM's MAC. Build MACs are deterministic per netslot, and the netslot allocator
evicts any VM carrying the MAC of the slot it is claiming — `src/build/netslot.ts`
assumed such a VM could only be an orphan from a previous build, which was never
true of a restored template. Observed live: `cf build debian-12` took netslot 05
and evicted six installed templates that shared its MAC, while ten templates on
other slots survived. A schema-2 template cannot hit this: the profile records only
`net_model`, and `qm create` assigns a fresh MAC per VM.

`memory` and `cores` are dropped too — `8192`/`4` on Windows is servicing headroom
for the `WU.ps1` rounds, not a runtime requirement, and publishing it would floor
every consumer plan at 8 GB. The hand-authored `minimum` block replaces it.

**Dropped — no-op defaults** the packer plugin writes explicitly: `kvm=1`,
`numa=0`, `onboot=0`, `vga=std`.

**Everything else is recorded**, including values identical across all 18 recipes.
The test is "does getting this wrong break the image?", not "does this value
vary?" — those diverge:

- `scsihw` is `virtio-scsi-single` everywhere because every image has virtio-scsi
  drivers bound to its boot device. Hand a Windows image an `lsi` controller and it
  stops at `0x7B INACCESSIBLE_BOOT_DEVICE`; a Linux initramfs built for
  `virtio_scsi` may not find root. A predictable value still has to be recorded, or
  the consumer hardcodes a constant that happens to match.
- `cpu: host` — Proxmox's default is not `host`, and the 2025 installer probes
  SSE4.1/4.2. It does block live migration between heterogeneous nodes, but that is
  an override a consumer makes against a correct baseline; the artifact should not
  pre-decide it for every non-Convoy user.
- `agent: 1` — the Proxmox default is `0`, and all 18 images ship
  `qemu-guest-agent`. Omitting it would cost every standalone install IP reporting
  and filesystem freeze on backup.

### Two captured values must be normalized

**`machine: pc-q35-11.0` → `q35`.** The build pins a QEMU machine version;
published as-is the image will not start on a node running older QEMU — a hard
failure, not a degradation. Publishing the bare type is what Proxmox wants: on a
`win*` ostype it pins the version *itself*, against the target node's QEMU. A
published pin could only ever name someone else's QEMU.

**`ide3` for the cloud-init drive → `ide2`.** Windows templates land on `ide3` only
because `ide0`–`ide2` held the boot, virtio, and answer-file ISOs during the build.
That is build scaffolding leaking into the template. Cloudbase-Init locates the
config drive by label, not slot.

## Consuming an artifact

The cloud-init drive and TPM state are allocated fresh by the consumer, not
downloaded: the image is generalized, so nothing is sealed to the TPM, and a
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

Growth on first boot is handled in-guest: Linux via `cloud-initramfs-growroot`,
Windows via Cloudbase-Init's `ExtendVolumesPlugin`.

Pass the `efidisk0` flags to match the source, as `coport` does. Do **not** pass
`citype`: Proxmox derives it from `ostype`, and the sidecar already carries that.

### Cloud-init capabilities follow `ostype`

The sidecar does not describe which cloud-init knobs are safe to send, because
`ostype` already determines it. Consumers must branch on it, and for Windows the
failure is not graceful:

- **`sshkeys` breaks provisioning.** `SetUserSSHPublicKeysPlugin` is omitted from
  the Cloudbase-Init plugin list, and with `--sshkeys` metadata present the plugin
  fails outright with `[WinError 2]` — observed live on a 2019 clone.
- **`ciuser` is ignored.** `CreateUserPlugin` is omitted deliberately;
  `SetUserPasswordPlugin` applies the password to the existing Administrator.
- **Readiness takes minutes, not seconds.** Cloudbase-Init runs `delayed-auto`
  after a full OOBE pass, so polling tuned for Debian will time out.

A `--cipassword` must also not begin with a YAML indicator character — see
[windows.md](windows.md#constraints-on-the-caller). That constraint applies to
Linux images too.

## Implementation

`recipes/_shared/post/export-and-cleanup.sh` exports the disks after the existing
shrink — the system disk via `qemu-img convert -c -O qcow2`, the varstore as a byte
copy — hashes each, and writes the schema-2 sidecar. `assert_generalized` and
`shrink_disk` are unchanged and still run first.

`cf verify` exercises the import path, building its scratch VM through the same
`src/registry/create.ts` builder `coport` installs with, so the profile is a tested
artifact rather than metadata nobody checks — a profile never used to boot anything
will drift. It reads the published sidecar rather than the build VM, and boots at
the recipe's build shape rather than the profile's `minimum`: the floor is what a
consumer may configure, while the checks want the resources the recipe was
exercised with.

`cf prune --r2` retains **generations**: a sidecar plus the images it names.
Objects are matched to a generation by the sha256 embedded in their key, since
`[upload].key` is user-configurable and any rule parsing the path breaks on some
layout.

`coport` downloads the images, `qm create`s from the profile, then `qm template`s
the result. Its VMID machinery stays, because a template still occupies a VMID.

## Do not run other builds during a Windows export

A build VM is stopped for the entire export — packer shuts it down and converts it
to a template before the post-processor runs, and a 32 G qcow2 conversion takes
minutes. This once destroyed a windows-server-2025 build 3h26m in: `netslot.ts`
reclaimed a slot when no *running* VM carried its MAC, an exporting VM is
indistinguishable from an abandoned one, and a concurrent Linux batch drew that slot
and deleted the live build's disks between the config read and the varstore copy.

**Fixed**: the reclaim also consults the run lease that owns the VMID
(`vmid_leased`), heartbeated by the owning `cf` process, which answers "is this
build alive" regardless of power state. Eviction gained a second guard — it refuses
to destroy anything that is not a `packer-*` build VM, so an installed template
wearing a stale build MAC is reported and left alone.

The advice stands anyway: the longer the export, the wider any such window.

## Known limitations

- **Full copy per VM.** `import-from` copies; there are no linked clones. For
  multi-tenant use this is arguably correct — a linked clone can never have its
  base deleted or updated — but provisioning latency and space use are higher than
  the `qmrestore` path.
- **Imported format follows the target storage, not the source.** A compressed
  qcow2 imported onto dir storage lands as `raw`. It is sparse, so the cost is
  bounded, but a `coport`-installed template no longer gets qcow2's linked-clone
  support on file storages the way a `qmrestore`d one did. Passing `format=` would
  fix it for dir storages and break block storages, so it needs a
  storage-capability probe rather than a constant.
- **`windows-server-2019` and `-2022` have not been round-tripped through the new
  export path.** Every Linux recipe and `windows-server-2025` were built, published,
  rebuilt from their sidecars via `qm create --import-from`, and booted; the OVMF
  round-trip verified that a 540,672-byte varstore imports through
  `--efidisk0 …,import-from=` and **OVMF boots from it**, finding the boot entry
  Windows Setup wrote.
