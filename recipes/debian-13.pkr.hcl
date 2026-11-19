# display: Debian 13 (Trixie)
# group: debian
# build_vmid: 4002
# min_cores: 1
# min_memory: 1024
# iso_url: https://cdimage.debian.org/cdimage/release/current/amd64/iso-cd/debian-13.7.0-amd64-netinst.iso
# iso_target_path: ${var.iso_cache_dir}/packer-debian-13.7.0-amd64-netinst.iso
# iso_checksum_url: https://cdimage.debian.org/cdimage/release/current/amd64/iso-cd/SHA256SUMS
# iso_filename_re: debian-13\.\d+\.\d+-amd64-netinst\.iso
# iso_signing_key: debian-cd
# iso_checksum_sig: SHA256SUMS.sign

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
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/packer-debian-13.7.0-amd64-netinst.iso"
    iso_checksum = "sha256:a7ef94ac2fb9a7fec454552abd629b7cc9d5155c886165a45649f5ce6167e355"
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
      "sudo timeout 600 cloud-init status --wait || true",
      "echo '==> Upgrading packages'",
      "sudo apt-get -y -o DPkg::Lock::Timeout=600 update",
      # dist-upgrade, not upgrade: upgrade holds back any package whose new
      # version needs a new dependency, and those stayed old in the image.
      "sudo DEBIAN_FRONTEND=noninteractive apt-get -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold dist-upgrade",
      # The official images' network stack; finalize.sh switches to it. Last,
      # because systemd-resolved takes over /etc/resolv.conf with no upstream
      # server while ifupdown still runs the build NIC, so nothing after this
      # may need DNS. Debian 11 has resolved inside the systemd package.
      "echo '==> Installing netplan and systemd-resolved'",
      "sudo DEBIAN_FRONTEND=noninteractive apt-get -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confold install netplan.io $(apt-cache show systemd-resolved >/dev/null 2>&1 && echo systemd-resolved)",
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
