# display: Rocky Linux 9
# build_vmid: 9112

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

variable "iso_cache_dir" {
  type    = string
  default = "/var/lib/cofoundry/iso-cache"
}

variable "packer_ssh_private_key_file" {
  type      = string
  sensitive = true
}

locals {
  build_vmid     = 9112
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
  template_description = "${local.recipe_display} Packer Template -- ${formatdate("YYYY-MM-DD", timestamp())}"

  bios    = "seabios"
  machine = "q35"
  os      = "l26"
  cpu_type = "host"
  cores    = 2
  sockets  = 1
  memory   = 2048
  qemu_agent              = true
  cloud_init              = true
  cloud_init_storage_pool = var.proxmox_storage_pool
  scsi_controller         = "virtio-scsi-pci"

  disks {
    disk_size    = "10G"
    format       = "qcow2"
    storage_pool = var.proxmox_storage_pool
    type         = "virtio"
  }

  network_adapters {
    bridge = var.proxmox_bridge
    model  = "virtio"
  }

  boot_iso {
    type             = "ide"
    iso_url          = "https://download.rockylinux.org/pub/rocky/9/isos/x86_64/Rocky-9.7-x86_64-minimal.iso"
    iso_checksum     = "sha256:23a1ac1175d8ccada7195863914ef1237f584ff25f73bd53da410d5fffd882b0"
    iso_storage_pool = var.proxmox_iso_storage_pool
    iso_target_path  = "${var.iso_cache_dir}/Rocky-9.7-x86_64-minimal.iso"
    unmount          = true
  }

  http_directory = "${path.root}/${local.recipe_name}/http"

  boot_wait = "10s"
  boot_command = [
    "<tab> inst.text inst.ks=http://{{ .HTTPIP }}:{{ .HTTPPort }}/ks.cfg ip=${var.build_ip}::${var.build_gw}:255.255.255.0:${local.recipe_name}:ens18:none nameserver=${var.build_dns} inst.waitfornet=10<enter><wait>",
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
      "sudo timeout 180 cloud-init status --wait || true",
      "sudo dnf -y update",
      "sudo dnf -y autoremove",
      "sudo dnf -y clean all",
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
      "sudo install -m 0644 /tmp/99-pve.cfg /etc/cloud/cloud.cfg.d/99-pve.cfg",
      "sudo userdel --remove --force packer || true",
      "sudo sync",
    ]
  }

  post-processor "shell-local" {
    environment_vars = [
      "CF_BUILT_VMID=${local.build_vmid}",
      "CF_RECIPE_NAME=${local.recipe_name}",
      "CF_RECIPE_DISPLAY=${local.recipe_display}",
    ]
    script = "${path.root}/_shared/post/vzdump-and-cleanup.sh"
  }
}
