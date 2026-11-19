# display: Ubuntu 26.04 LTS (Resolute Raccoon)
# group: ubuntu
# build_vmid: 1005
# min_cores: 1
# min_memory: 1024
# iso_url: https://releases.ubuntu.com/26.04/ubuntu-26.04.1-live-server-amd64.iso
# iso_target_path: ${var.iso_cache_dir}/packer-ubuntu-26.04.1-live-server-amd64.iso
# iso_checksum_url: https://releases.ubuntu.com/26.04/SHA256SUMS
# iso_filename_re: ubuntu-26\.04(\.\d+)?-live-server-amd64\.iso
# iso_signing_key: ubuntu-cdimage
# iso_checksum_sig: SHA256SUMS.gpg

packer {
  required_plugins {
    proxmox = {
      version = "~> 1"
      source  = "github.com/hashicorp/proxmox"
    }
  }
}

variable "proxmox_api_url" { type = string }

variable "proxmox_username" {
  type      = string
  sensitive = true
}

variable "proxmox_token" {
  type      = string
  sensitive = true
}

variable "proxmox_node" { type = string }

variable "proxmox_storage_pool" {
  type    = string
  default = "local"
}

variable "proxmox_iso_storage_pool" {
  type    = string
  default = "local"
}

variable "proxmox_bridge" {
  type    = string
  default = "vmbr0"
}

variable "build_ip" {
  type    = string
  default = ""
}

variable "build_gw" {
  type    = string
  default = ""
}

variable "build_dns" {
  type    = string
  default = "1.1.1.1"
}

variable "build_mac" { type = string }

variable "build_vmid" {
  type    = number
  default = 1005
}

variable "iso_cache_dir" {
  type    = string
  default = "/var/lib/vz/template/iso"
}

variable "packer_ssh_private_key_file" {
  type      = string
  sensitive = true
}

locals {
  build_vmid     = var.build_vmid
  recipe_name    = "ubuntu-26.04"
  recipe_display = "Ubuntu 26.04 LTS (Resolute Raccoon)"
}

source "proxmox-iso" "ubuntu-26-04" {
  proxmox_url              = var.proxmox_api_url
  username                 = var.proxmox_username
  token                    = var.proxmox_token
  node                     = var.proxmox_node
  insecure_skip_tls_verify = true

  vm_id                = local.build_vmid
  vm_name              = "packer-${local.recipe_name}"
  template_description = <<-EOT
    # Convoy Template

    This template was created for use with **Convoy**.

    Source repository: [ConvoyPanel/cofoundry](https://github.com/ConvoyPanel/cofoundry)

    Created at: `${timestamp()}`
  EOT

  bios                    = "seabios"
  machine                 = "q35"
  os                      = "l26"
  cpu_type                = "host"
  cores                   = 2
  sockets                 = 1
  memory                  = 4096
  qemu_agent              = true
  cloud_init              = true
  cloud_init_storage_pool = var.proxmox_storage_pool
  scsi_controller         = "virtio-scsi-single"

  serials = ["socket"]

  vga {
    type = "std"
  }

  disks {
    disk_size    = "5G"
    format       = "qcow2"
    storage_pool = var.proxmox_storage_pool
    type         = "scsi"
    discard      = true
    ssd          = true
    io_thread    = true
  }

  network_adapters {
    bridge      = var.proxmox_bridge
    model       = "virtio"
    mac_address = var.build_mac
  }

  boot_iso {
    type         = "ide"
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/packer-ubuntu-26.04.1-live-server-amd64.iso"
    iso_checksum = "sha256:cc8a95cde20f6ced61a322420de00f10cc3c90ced545daa46cb9c1a117f1d927"
    unmount      = true
  }

  http_directory    = "${path.root}/${local.recipe_name}/http"
  http_bind_address = var.build_gw

  boot_wait = "5s"
  # Space out simulated keystrokes. Proxmox sends the boot command via the
  # QEMU `sendkey` API; with no interval the guest keyboard buffer drops
  # characters, which corrupted the `ip=` netmask (…255.255.255.0 arriving as
  # …255.25.250) and left the installer unable to bring up networking, so it
  # never fetched the autoinstall user-data and SSH timed out. See
  # docs/recipes.md#ubuntu-autoinstall.
  boot_key_interval = "100ms"
  boot_command = [
    "e<wait>",
    "<down><down><down><end>",
    "<bs><bs><bs><wait>",
    " autoinstall ds=nocloud-net\\;s=http://${var.build_gw}:{{ .HTTPPort }}/ ip=${var.build_ip}::${var.build_gw}:255.255.255.0::::${var.build_dns} console=tty0 console=ttyS0,115200 ---<wait>",
    "<f10><wait>",
  ]

  communicator           = "ssh"
  ssh_username           = "packer"
  ssh_private_key_file   = var.packer_ssh_private_key_file
  ssh_handshake_attempts = 10
  ssh_pty                = true
  ssh_timeout            = "30m"
}

build {
  sources = ["source.proxmox-iso.ubuntu-26-04"]

  provisioner "shell" {
    inline = [
      # Subiquity creates the build user on cloud-init's first boot, so wait
      # for it to finish -- but not forever: a cloud-init that never finishes
      # would otherwise hold the build until the CI job's own timeout.
      "echo '==> Waiting for cloud-init to finish'",
      "timeout 900 sh -c 'until [ -f /var/lib/cloud/instance/boot-finished ]; do sleep 2; done' || { echo 'cloud-init did not finish within 15 minutes' >&2; sudo cloud-init status --long >&2; exit 1; }",
      "echo '==> Upgrading packages'",
      "sudo apt-get -y -o DPkg::Lock::Timeout=600 update",
      # dist-upgrade, not upgrade: upgrade holds back any package whose new
      # version needs a new dependency, and those stayed old in the image.
      "sudo DEBIAN_FRONTEND=noninteractive apt-get -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold dist-upgrade",
    ]
  }

  # Boot the upgraded kernel. finalize.sh removes every other kernel, which
  # apt and dnf refuse to do to the running one, and the build proves the new
  # kernel boots before anything is exported from it.
  provisioner "shell" {
    expect_disconnect = true
    inline            = ["sudo systemctl reboot"]
  }

  provisioner "shell" {
    pause_before        = "20s"
    start_retry_timeout = "10m"
    inline              = ["mkdir -p /tmp/cofoundry"]
  }

  provisioner "file" {
    source      = "${path.root}/_shared/linux/"
    destination = "/tmp/cofoundry/"
  }

  # Cleanup, the cloud-init config, the leftover checks and the build user's
  # removal all happen in finalize.sh. It leaves the disk read-only and the VM
  # powering itself off, so nothing a shutdown writes reaches the image. No
  # expect_disconnect: a connection lost partway must fail the build. See the
  # script's header.
  provisioner "shell" {
    skip_clean = true
    inline     = ["sudo bash /tmp/cofoundry/finalize.sh"]
  }

  post-processor "shell-local" {
    environment_vars = [
      "CF_BUILT_VMID=${local.build_vmid}",
      "CF_RECIPE_NAME=${local.recipe_name}",
      "CF_RECIPE_DISPLAY=${local.recipe_display}",
    ]
    script = "${path.root}/_shared/post/export-and-cleanup.sh"
  }
}
