# display: AlmaLinux 8
# group: almalinux
# build_vmid: 6000
# min_cores: 1
# min_memory: 2048
# iso_url: https://repo.almalinux.org/almalinux/8/isos/x86_64/AlmaLinux-8.10-x86_64-minimal.iso
# iso_target_path: ${var.iso_cache_dir}/packer-AlmaLinux-8.10-x86_64-minimal.iso
# iso_checksum_url: https://repo.almalinux.org/almalinux/8/isos/x86_64/CHECKSUM
# iso_filename_re: AlmaLinux-8\.\d+-x86_64-minimal\.iso

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
  default = 6000
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
  recipe_name    = "almalinux-8"
  recipe_display = "AlmaLinux 8"
}

source "proxmox-iso" "almalinux-8" {
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
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/packer-AlmaLinux-8.10-x86_64-minimal.iso"
    iso_checksum = "sha256:e524329700abe47ce1f509bed7e2d3c68b336a54c712daa1b492b2429a64d419"
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
  sources = ["source.proxmox-iso.almalinux-8"]

  provisioner "shell" {
    inline = [
      "echo '==> Waiting for cloud-init to finish (may report disabled on minimal installs)'",
      "sudo timeout 180 cloud-init status --wait || true",
      "echo '==> Updating packages'",
      "sudo dnf -y update",
      "echo '==> Removing unused packages'",
      "sudo dnf -y autoremove",
      "echo '==> Cleaning package cache'",
      "sudo dnf -y clean all",
    ]
  }

  # RHEL ships qemu-guest-agent with guest-exec denied, which fails the build
  # smoke test's reboot-and-verify. Enable it here, after 'dnf update', so a
  # guest-agent package refresh cannot revert the change.
  provisioner "file" {
    source      = "${path.root}/_shared/post/enable-guest-exec.sh"
    destination = "/tmp/enable-guest-exec.sh"
  }

  provisioner "shell" {
    inline = ["sudo bash /tmp/enable-guest-exec.sh"]
  }

  provisioner "file" {
    source      = "${path.root}/_shared/cloud-init-cleanup.sh"
    destination = "/tmp/cloud-init-cleanup.sh"
  }

  provisioner "shell" {
    inline = ["sudo bash /tmp/cloud-init-cleanup.sh"]
  }

  provisioner "file" {
    source      = "${path.root}/_shared/cloud-init/99-pve.cfg"
    destination = "/tmp/99-pve.cfg"
  }

  provisioner "shell" {
    inline = [
      "sudo install -m 0644 /tmp/99-pve.cfg /etc/cloud/cloud.cfg.d/99-pve.cfg",
      "sudo sync",
    ]
  }

  provisioner "shell" {
    inline = [
      "echo '==> Verifying cloud-init is enabled for the final image'",
      "sudo systemctl is-enabled cloud-init-local cloud-init cloud-config cloud-final",
      "test ! -e /etc/cloud/cloud-init.disabled",
      "! grep -qw 'cloud-init=disabled' /proc/cmdline",
      "cloud-init --version",
      "test -s /etc/cloud/cloud.cfg",
      "grep -qx 'datasource_list: \\[ConfigDrive, NoCloud\\]' /etc/cloud/cloud.cfg.d/99-pve.cfg",
    ]
  }

  provisioner "shell" {
    expect_disconnect = true
    skip_clean        = true
    inline            = ["sudo bash -c 'rm -f /etc/sudoers.d/packer /etc/sudoers.d/wheel; userdel --remove --force packer' || true"]
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
