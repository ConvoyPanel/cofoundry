# display: Debian 13 (Trixie)
# group: debian
# build_vmid: 4002
# min_cores: 1
# min_memory: 1024
# iso_url: https://cdimage.debian.org/cdimage/release/current/amd64/iso-cd/debian-13.6.0-amd64-netinst.iso
# iso_target_path: ${var.iso_cache_dir}/packer-debian-13.6.0-amd64-netinst.iso
# iso_checksum_url: https://cdimage.debian.org/cdimage/release/current/amd64/iso-cd/SHA256SUMS
# iso_filename_re: debian-13\.\d+\.\d+-amd64-netinst\.iso

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
  default = 4002
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
  recipe_name    = "debian-13"
  recipe_display = "Debian 13 (Trixie)"
}

source "proxmox-iso" "debian-13" {
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
  memory                  = 2048
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
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/packer-debian-13.6.0-amd64-netinst.iso"
    iso_checksum = "sha256:65273beed27b2df543b68b65630ba525cfbad8df2b12035732b2dff87d6664e7"
    unmount      = true
  }

  http_directory    = "${path.root}/${local.recipe_name}/http"
  http_bind_address = var.build_gw

  boot_wait = "10s"
  # Space out simulated keystrokes. Proxmox sends the boot command via the
  # QEMU `sendkey` API; with no interval the guest keyboard buffer drops
  # characters, which corrupted a typed netmask on Ubuntu (…255.255.255.0
  # arriving as …255.25.250) and would break the netcfg/ answers typed here
  # the same way. See docs/recipes.md#ubuntu-autoinstall.
  boot_key_interval = "100ms"
  boot_command = [
    "<esc><wait>",
    "install auto=true priority=critical console=tty0 <wait>",
    "netcfg/disable_autoconfig=true <wait>",
    "netcfg/get_ipaddress=${var.build_ip} <wait>",
    "netcfg/get_netmask=255.255.255.0 <wait>",
    "netcfg/get_gateway=${var.build_gw} <wait>",
    "netcfg/get_nameservers=${var.build_dns} <wait>",
    "netcfg/confirm_static=true <wait>",
    " preseed/url=http://${var.build_gw}:{{ .HTTPPort }}/preseed.cfg <wait>",
    "debian-installer=en_US.UTF-8 <wait>",
    "locale=en_US.UTF-8 <wait>",
    "kbd-chooser/method=us <wait>",
    "keyboard-configuration/xkb-keymap=us <wait>",
    "fb=false <wait>",
    "debconf/frontend=noninteractive <wait>",
    "console-setup/ask_detect=false <wait>",
    "console-keymaps-at/keymap=us <wait>",
    "grub-installer/bootdev=/dev/sda <wait>",
    "<enter><wait>",
  ]

  communicator           = "ssh"
  ssh_username           = "packer"
  ssh_private_key_file   = var.packer_ssh_private_key_file
  ssh_handshake_attempts = 10
  ssh_pty                = true
  ssh_timeout            = "35m"
}

build {
  sources = ["source.proxmox-iso.debian-13"]

  provisioner "shell" {
    inline = [
      "echo '==> Waiting for cloud-init to finish'",
      "if command -v cloud-init >/dev/null 2>&1; then sudo cloud-init status --wait || true; fi",
      "echo '==> Updating packages'",
      "sudo apt-get -y update",
      "sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -y upgrade",
      "echo '==> Cleaning up SSH host keys and machine ID'",
      "sudo rm -f /etc/ssh/ssh_host_*",
      "sudo truncate -s 0 /etc/machine-id",
      "echo '==> Removing unused packages and cleaning cache'",
      "sudo apt-get -y autoremove --purge",
      "sudo apt-get -y clean",
      "sudo apt-get -y autoclean",
      "echo '==> Cleaning cloud-init state'",
      "sudo cloud-init clean",
      "sudo rm -f /etc/cloud/cloud.cfg.d/subiquity-disable-cloudinit-networking.cfg",
      "sudo sync",
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
