# display: Recipe With ISO
# notice: Unsupported; do not use.
# build_vmid: 9101
# final_disk_size: 16G
# iso_url: https://example.com/foo-1.2.3-amd64.iso
# iso_target_path: ${var.iso_cache_dir}/foo-1.2.3-amd64.iso

variable "iso_cache_dir" {
  type    = string
  default = "/var/lib/cofoundry/iso-cache"
}

source "proxmox-iso" "withiso" {
  boot_iso {
    iso_file         = "local:iso/foo-1.2.3-amd64.iso"
    iso_checksum     = "sha256:deadbeef"
    unmount          = true
  }

  additional_iso_files {
    iso_url         = "https://example.com/virtio-win.iso"
    iso_target_path = "${var.iso_cache_dir}/virtio-win.iso"
  }
}
