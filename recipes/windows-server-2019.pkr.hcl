# display: Windows Server 2019 Datacenter
# group: windows-server
# build_vmid: 2000
# final_disk_size: 30G
# iso_url: https://software-static.download.prss.microsoft.com/pr/download/17763.737.190906-2324.rs5_release_svc_refresh_SERVER_EVAL_x64FRE_en-us_1.iso
# iso_target_path: /var/lib/vz/template/iso/packer-windows-server-2019-eval.iso

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
  default = "vmbr1"
}

variable "winrm_password" {
  type      = string
  sensitive = true
}

variable "build_ip" { type = string }
variable "build_gw" { type = string }
variable "build_dns" { type = string }
variable "build_mac" { type = string }

variable "build_vmid" {
  type    = number
  default = 2000
}

# Filename of the pinned virtio-win driver ISO in the Proxmox ISO store. cf
# derives it from CF_VIRTIO_WIN_VERSION; the default tracks
# VIRTIO_WIN_DEFAULT_VERSION in src/env.ts for manual packer runs.
variable "virtio_win_iso" {
  type    = string
  default = "packer-virtio-win-0.1.285-1.iso"
}

locals {
  build_vmid     = var.build_vmid
  recipe_name    = "windows-server-2019"
  recipe_display = "Windows Server 2019 Datacenter"
  # Final exported disk size. Keep in sync with the `# final_disk_size:` header
  # above — the header drives the host-side shrink (cf -> shrink-disk.sh), this
  # local drives the guest-side partition shrink (Finalize.ps1).
  final_disk_size = "30G"

  ps_execute = "powershell -executionpolicy bypass \"& { $ErrorActionPreference='Stop'; $_p='{{.Path}}'; $_v='{{.Vars}}'; $_dl=[DateTime]::Now.AddSeconds(300); while ((-not (Test-Path $_p) -or -not (Test-Path $_v)) -and [DateTime]::Now -lt $_dl) { Start-Sleep 2 }; if (-not (Test-Path $_p)) { Write-Host ('PROVISIONER ERROR: script never arrived at ' + $_p + ' - the upload did not land within 300s'); exit 1 }; if (-not (Test-Path $_v)) { Write-Host ('PROVISIONER ERROR: env-vars file never arrived at ' + $_v + ' - the upload did not land within 300s'); exit 1 }; try { . $_v; & $_p } catch { Write-Host ('PROVISIONER ERROR: ' + $_.Exception.Message); exit 1 }; if ($LastExitCode) { exit $LastExitCode }; exit 0 }\""

  # Gating on the pending-reboot flags alone is NOT enough. On 2026-08-02 a 2022
  # build was caught rebooting TWICE after round one, 79 seconds apart, with the
  # flags already clear the whole time:
  #
  #   13:21:15  BOOT TIME CHANGED 11:00:10 -> 13:20:44   (packer's restart)
  #   13:21:29  cbsPending=False wuPending=False servicingRunning=True
  #   13:22:27  BOOT TIME CHANGED 13:20:44 -> 13:22:03   (second, unsolicited)
  #   13:24:48  cbsPending=False wuPending=False servicingRunning=False
  #
  # The flags describe work already *queued*; they say nothing about servicing
  # still executing. TiWorker/TrustedInstaller running is the signal that another
  # restart may still be coming, so the process check has to stay alongside them.
  # Without it packer resumed into that window and the uploaded provisioner script
  # was destroyed by the second reboot ("script never arrived within 300s").
  # Packer's default restart check reports "restarted" the instant WinRM answers,
  # which after a cumulative update is while Windows is still committing the
  # update (TiWorker/TrustedInstaller saturating the disk). Provisioning into
  # that window is what broke the 2026-08-01 builds: the uploaded script had not
  # landed in C:\Windows\Temp yet on 2022 ("is not recognized"), and the round-two
  # update scan was killed mid-flight on 2025. Hold the restart open until
  # servicing is actually idle. See docs/windows.md#post-update-restart-settling.
  restart_check = "powershell -Command \"& { if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') { exit 1 }; if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\PackagesPending') { exit 1 }; if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') { exit 1 }; if (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue) { exit 1 }; if (Get-Process -Name TiWorker,TrustedInstaller -ErrorAction SilentlyContinue) { exit 1 }; if (((Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime).TotalSeconds -lt 180) { exit 1 }; Write-Output 'restarted.' }\""
}

source "proxmox-iso" "windows-server-2019" {
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

  bios    = "ovmf"
  machine = "q35"
  os      = "win10"

  cpu_type = "host"
  cores    = 4
  sockets  = 1
  memory   = 8192

  efi_config {
    efi_storage_pool  = var.proxmox_storage_pool
    pre_enrolled_keys = true
    efi_type          = "4m"
  }

  scsi_controller = "virtio-scsi-single"

  cloud_init              = true
  cloud_init_storage_pool = var.proxmox_storage_pool

  disks {
    # Build at 100G for installer/servicing headroom, then shrink to
    # final_disk_size for export
    # (see `# final_disk_size:` above + Finalize.ps1/shrink-disk.sh). The large
    # disk is purely temporary working space, truncated back before export.
    disk_size    = "100G"
    format       = "qcow2"
    storage_pool = var.proxmox_storage_pool
    type         = "scsi"
    discard      = true
    io_thread    = true
  }

  network_adapters {
    bridge      = var.proxmox_bridge
    model       = "virtio"
    mac_address = var.build_mac
  }

  boot_iso {
    type         = "ide"
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/packer-windows-server-2019-eval.iso"
    iso_checksum = "none"
    unmount      = true
  }

  # VirtIO drivers ISO (provides virtio-win-guest-tools.exe for Install.ps1)
  additional_iso_files {
    type         = "ide"
    iso_file     = "${var.proxmox_iso_storage_pool}:iso/${var.virtio_win_iso}"
    iso_checksum = "none"
    unmount      = true
  }

  # Packer creates an ISO from these local files and attaches it as a CD-ROM.
  # inject-placeholders.sh replaces __PACKER_ADMIN_PASSWORD__ in autounattend.xml before the build.
  additional_iso_files {
    type             = "ide"
    iso_storage_pool = var.proxmox_iso_storage_pool
    cd_files = [
      "${path.root}/windows-server-2019/autounattend.xml",
      "${path.root}/_shared/CloudbaseInitSetup_x64.msi",
    ]
    cd_label = "ANSWERFILES"
    unmount  = true
  }

  # The OVMF "Press any key to boot from CD or DVD" prompt is a short (~5s)
  # window whose start drifts with POST speed — on a busy node it can land well
  # after a short keypress burst, leaving the VM at "no bootable device" until
  # winrm_timeout (45m) expires. Blanket ~60s with a press every 2s so a slow
  # POST can't fall outside the window; stray <enter>s during WinPE load are
  # harmless (autounattend drives Setup non-interactively).
  boot_wait    = "2s"
  boot_command = ["<enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2><enter><wait2>"]

  communicator   = "winrm"
  winrm_host     = var.build_ip
  winrm_username = "Administrator"
  winrm_password = var.winrm_password
  winrm_use_ssl  = false
  winrm_insecure = true
  # A healthy install reaches WinRM in ~15 min. Keep this tight so a failed
  # install (setup error dialog leaves the VM "running" with WinRM never coming
  # up) fails the attempt in ~45 min instead of hanging the full timeout —
  # cf retries the build (CF_BUILD_ATTEMPTS) to ride out intermittent flakes.
  winrm_timeout = "45m"
  winrm_port    = 5985
}

build {
  sources = ["source.proxmox-iso.windows-server-2019"]

  provisioner "powershell" {
    execute_command = local.ps_execute
    max_retries     = 2
    script          = "${path.root}/_shared/windows/Install.ps1"
  }

  provisioner "windows-restart" {
    restart_check_command = local.restart_check
    restart_timeout       = "30m"
  }

  provisioner "powershell" {
    pause_before    = "30s"
    execute_command = local.ps_execute
    max_retries     = 2
    script          = "${path.root}/_shared/windows/WU.ps1"
  }
  provisioner "windows-restart" {
    restart_check_command = local.restart_check
    restart_timeout       = "90m"
    restart_command       = "powershell -Command \"if (Test-Path 'C:/Windows/Temp/tb-wu-reboot.flag') { Remove-Item 'C:/Windows/Temp/tb-wu-reboot.flag' -Force; shutdown /r /f /t 5 /c 'packer wu reboot' } else { exit 0 }\""
  }

  provisioner "powershell" {
    pause_before    = "30s"
    execute_command = local.ps_execute
    max_retries     = 2
    script          = "${path.root}/_shared/windows/WU.ps1"
  }
  provisioner "windows-restart" {
    restart_check_command = local.restart_check
    restart_timeout       = "90m"
    restart_command       = "powershell -Command \"if (Test-Path 'C:/Windows/Temp/tb-wu-reboot.flag') { Remove-Item 'C:/Windows/Temp/tb-wu-reboot.flag' -Force; shutdown /r /f /t 5 /c 'packer wu reboot' } else { exit 0 }\""
  }

  provisioner "powershell" {
    pause_before    = "30s"
    execute_command = local.ps_execute
    max_retries     = 2
    script          = "${path.root}/_shared/windows/PreFinalize.ps1"
  }
  provisioner "windows-restart" {
    restart_check_command = local.restart_check
    restart_timeout       = "30m"
  }

  # Finalize is the one provisioner with NO max_retries, unlike every provisioner
  # above it. It runs sysprep /generalize, and its own arming gate already
  # retries that once (maxAttempts=2 in Finalize.ps1). A max_retries here
  # MULTIPLIES with that loop -- packer's `2` means two *retries*, so three runs
  # of the script and up to SIX generalizes. Each generalize consumes a licensing
  # rearm, and cf verify's rearm-headroom check already warns on 2025. A retry
  # would also re-run `dism /ResetBase` and reinstall the Cloudbase-Init MSI over
  # an already-generalized image, which nothing here is designed for. Retrying
  # the whole build is CF_BUILD_ATTEMPTS' job, not this provisioner's.
  provisioner "powershell" {
    pause_before    = "30s"
    execute_command = local.ps_execute
    environment_vars = [
      "CF_FINAL_DISK_SIZE=${local.final_disk_size}",
      # Seeds <AdministratorPassword> in the sysprep answer file so OOBE completes
      # unattended on a clone. Cloudbase-Init replaces it with the cloud-init
      # password on first boot; it is the fallback if that injection fails.
      "CF_ADMIN_PASSWORD=${var.winrm_password}",
    ]
    script = "${path.root}/_shared/windows/Finalize.ps1"
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
