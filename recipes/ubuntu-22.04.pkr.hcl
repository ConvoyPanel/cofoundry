# display: Ubuntu 22.04 LTS (Jammy Jellyfish)
# group: ubuntu
# build_vmid: 1002
# min_cores: 1
# min_memory: 1024
# iso_url: https://releases.ubuntu.com/22.04/ubuntu-22.04.5-live-server-amd64.iso
# iso_target_path: ${var.iso_cache_dir}/packer-ubuntu-22.04.5-live-server-amd64.iso
# iso_checksum_url: https://releases.ubuntu.com/22.04/SHA256SUMS
# iso_filename_re: ubuntu-22\.04\.\d+-live-server-amd64\.iso

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
  default = 1002
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
  recipe_name    = "ubuntu-22.04"
  recipe_display = "Ubuntu 22.04 LTS (Jammy Jellyfish)"
}

source "proxmox-iso" "ubuntu-22-04" {
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
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/packer-ubuntu-22.04.5-live-server-amd64.iso"
    iso_checksum = "sha256:9bc6028870aef3f74f4e16b900008179e78b130e6b0b9a140635434a46aa98b0"
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
  sources = ["source.proxmox-iso.ubuntu-22-04"]

  provisioner "shell" {
    inline = [
      "echo '==> Waiting for cloud-init to finish'",
      "while [ ! -f /var/lib/cloud/instance/boot-finished ]; do echo 'Waiting for cloud-init...'; sleep 1; done",
      "echo '==> Updating packages'",
      "sudo apt-get -y update",
      "sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -y upgrade",
      "echo '==> Removing unused packages and cleaning cache'",
      "sudo apt-get -y autoremove --purge",
      "sudo apt-get -y clean",
      "echo '==> Removing installer network config'",
      "sudo rm -f /etc/netplan/00-installer-config.yaml",
      "sudo rm -f /etc/cloud/cloud.cfg.d/subiquity-disable-cloudinit-networking.cfg",
    ]
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
      "sudo cp /tmp/99-pve.cfg /etc/cloud/cloud.cfg.d/99-pve.cfg",
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
