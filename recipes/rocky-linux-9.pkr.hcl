# display: Rocky Linux 9
# group: rocky-linux
# build_vmid: 5001
# min_cores: 1
# min_memory: 2048
# iso_url: https://download.rockylinux.org/pub/rocky/9/isos/x86_64/Rocky-9.9-x86_64-minimal.iso
# iso_target_path: ${var.iso_cache_dir}/packer-Rocky-9.9-x86_64-minimal.iso
# iso_checksum_url: https://download.rockylinux.org/pub/rocky/9/isos/x86_64/CHECKSUM
# iso_filename_re: Rocky-9\.\d+-x86_64-minimal\.iso
# iso_signing_key: rocky-linux-9
# iso_checksum_sig: CHECKSUM.asc
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
  default = 5001
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
  recipe_name    = "rocky-linux-9"
  recipe_display = "Rocky Linux 9"
}

source "proxmox-iso" "rocky-linux-9" {
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
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/packer-Rocky-9.9-x86_64-minimal.iso"
    iso_checksum = "sha256:56772c6c07464ea8e55b64cb5ec2448d16e1b4673b8041678dacfd540131401c"
    unmount      = true
  }

  http_directory    = "${path.root}/${local.recipe_name}/http"
  http_bind_address = var.build_gw

  boot_wait = "15s"
  boot_key_interval = "100ms"
  boot_command = [
    "<up><wait>",
    "<tab><wait>",
    " inst.text console=tty0 console=ttyS0,115200 inst.ks.sendmac ip=dhcp rd.neednet=1 inst.waitfornet=30 inst.ks=http://${var.build_gw}:{{ .HTTPPort }}/ks<enter><wait>",
  ]

  communicator           = "ssh"
  ssh_username           = "packer"
  ssh_private_key_file   = var.packer_ssh_private_key_file
  ssh_handshake_attempts = 12
  ssh_pty                = true
  ssh_timeout            = "35m"
}

build {
  sources = ["source.proxmox-iso.rocky-linux-9"]

  provisioner "shell" {
    inline = [
      "echo '==> Waiting for cloud-init to finish (may report disabled on minimal installs)'",
      "sudo timeout 180 cloud-init status --wait || true",
      "echo '==> Updating packages'",
      "sudo dnf -y update",
      "sudo dnf -y autoremove",
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
