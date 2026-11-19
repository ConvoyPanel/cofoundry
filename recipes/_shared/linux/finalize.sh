#!/usr/bin/env bash
# finalize.sh — the last thing every Linux build runs inside the guest.
#
# Turns the installed build VM into a template the way the distros' own cloud
# images are made: install the Proxmox cloud-init config, remove everything the
# installer and the build left behind, strip per-machine identity, assert the
# result, delete the build user, and power off without writing anything else.
#
# The recipe uploads this directory to /tmp/cofoundry and runs it as root, with
# Packer's `skip_clean`: it deletes the user Packer is logged in as, and the
# script Packer would clean up. It exits 0 with the disk already read-only and
# the power-off a few seconds away, so Packer gets a real exit status. That is
# why the recipe does not set `expect_disconnect`: a connection that dropped
# halfway through would otherwise read as success and export a half-finished
# image.
#
# Every step must succeed or fail the build. A `|| true` here needs a comment
# saying why the failure cannot matter.
#
# Why the power-off is not a normal shutdown: a clean shutdown writes. systemd
# saves a fresh random seed (marked creditable, so every clone would trust the
# same "entropy"), records a shutdown in wtmp, rsyslog and auditd log their
# exit, chrony saves its drift. Any of that lands in the image after the
# cleanup below has run. So the script syncs, remounts every filesystem
# read-only, and powers off from the kernel. Nothing written after the cleanup
# can reach the disk.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

step() { printf '==> finalize: %s\n' "$*"; }
# dpkg/rpm "is this installed" without a `| grep -q` pipeline: under pipefail
# grep's early exit can fail the writer with SIGPIPE and read as "absent".
installed() {
  case "$family" in
    debian) [ "$(dpkg-query -W -f '${db:Status-Abbrev}' "$1" 2>/dev/null)" = 'ii ' ] ;;
    rhel) rpm -q "$1" >/dev/null 2>&1 ;;
  esac
}
fail() {
  printf 'finalize FAILED: %s\n' "$*" >&2
  exit 1
}

. /etc/os-release
case " ${ID} ${ID_LIKE:-} " in
  *' debian '* | *' ubuntu '*) family=debian ;;
  *' rhel '* | *' centos '* | *' fedora '*) family=rhel ;;
  *) fail "unsupported distribution: ${ID}" ;;
esac
step "distribution ${PRETTY_NAME} (${family} family)"

# The build network, captured before anything is cleaned. Every address the
# build VM holds, and its gateway, must be gone from the image at the end.
build_addrs=$(ip -4 -o addr show scope global | awk '{sub(/\/.*/, "", $4); print $4}')
build_gw=$(ip -4 route show default | awk 'NR == 1 {print $3}')

export DEBIAN_FRONTEND=noninteractive

# Nothing else may run the package manager while this does, or touch the disk
# once it is read-only. Stopping a timer's service waits for a run in progress;
# the apt calls below also wait on the lock rather than failing on it.
step "stopping scheduled package jobs"
case "$family" in
  debian)
    systemctl stop apt-daily.timer apt-daily-upgrade.timer apt-daily.service \
      apt-daily-upgrade.service unattended-upgrades.service 2>/dev/null || true # absent units are fine
    if command -v snap >/dev/null 2>&1 && systemctl is-active --quiet snapd.service; then
      snap watch --last=auto-refresh? 2>/dev/null || true # nothing to wait for is fine
    fi
    ;;
  rhel)
    systemctl stop dnf-makecache.timer dnf-makecache.service 2>/dev/null || true # absent units are fine
    ;;
esac
apt_get() { apt-get -y -o DPkg::Lock::Timeout=600 "$@"; }

# --- packages ----------------------------------------------------------------

# Kernels the build no longer runs. The build rebooted after its upgrade, so
# the running kernel is the newest one; every other one is dead weight (a
# Debian 12 image carried 790 MiB of modules for two kernels) and an extra
# boot entry. Only remove anything when the running kernel's own package is
# found, so a naming surprise can never purge the kernel the image boots.
step "removing kernels other than the running $(uname -r)"
case "$family" in
  debian)
    running_pkg="linux-image-$(uname -r)"
    if installed "$running_pkg"; then
      old=$(dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 'linux-image-[0-9]*' |
        awk -v keep="$running_pkg" '$1 == "ii" && $2 != keep {print $2}')
      if [ -n "$old" ]; then
        # Only those kernels and their own modules and headers may go; a
        # metapackage going with them would stop the image's kernel updates.
        # shellcheck disable=SC2086
        versions=$(printf '%s\n' $old | sed -E 's/^linux-image-//; s/-[a-z]+$//' | sort -u)
        # shellcheck disable=SC2086
        for pkg in $(apt-get -s purge $old | awk '/^Purg /{print $2}'); do
          ok=0
          for v in $versions; do
            case "$pkg" in *"$v"*) ok=1 ;; esac
          done
          [ "$ok" = 1 ] || fail "purging the old kernels would also remove $pkg"
        done
        # shellcheck disable=SC2086
        apt_get purge $old
      fi
    else
      fail "running kernel package $running_pkg is not installed"
    fi
    # The autoinstall asks for linux-virtual, but 26.04's installer layer
    # already carries linux-generic, which keeps ~700 MB of bare-metal firmware
    # installed. Drop the generic flavour's image metapackages; autoremove then
    # takes the firmware. Same kernel binary, so nothing the image boots goes
    # away. linux-headers-generic stays: linux-virtual's headers depend on it.
    if installed linux-virtual; then
      generic=""
      for pkg in linux-generic linux-image-generic; do
        if installed "$pkg"; then generic="$generic $pkg"; fi
      done
      if [ -n "$generic" ]; then
        # shellcheck disable=SC2086
        removes=$(apt-get -s purge $generic | awk '/^Purg /{print $2}' | sort | tr '\n' ' ')
        expected=$(printf '%s\n' $generic | sort | tr '\n' ' ')
        [ "$removes" = "$expected" ] || fail "purging$generic would also remove: $removes"
        # shellcheck disable=SC2086
        apt_get purge $generic
      fi
      # autoremove keeps the firmware anyway: the kernel packages recommend
      # it, and apt treats recommended packages as wanted. The official cloud
      # images carry none.
      # dpkg-query exits 1 when no package matches at all, which under
      # pipefail would end the script here, silently, wherever dpkg has never
      # heard of linux-firmware (22.04 and 24.04 with linux-virtual).
      firmware=$( (dpkg-query -W -f '${db:Status-Abbrev} ${Package}\n' 'linux-firmware*' 2>/dev/null || true) |
        awk '$1 == "ii" {print $2}' | tr '\n' ' ')
      if [ -n "$firmware" ]; then
        # shellcheck disable=SC2086
        for pkg in $(apt-get -s purge $firmware | awk '/^Purg /{print $2}'); do
          case "$pkg" in linux-firmware*) ;; *) fail "purging linux-firmware would also remove $pkg" ;; esac
        done
        # shellcheck disable=SC2086
        apt_get purge $firmware
      fi
    fi
    apt_get autoremove --purge
    ;;
  rhel)
    old=$(dnf -q repoquery --installed --installonly --latest-limit=-1)
    if [ -n "$old" ]; then
      # shellcheck disable=SC2086
      dnf -y remove $old
    fi
    ;;
esac

if [ "$family" = debian ]; then
  # Packages that ride in with the installers' hardware detection, the Debian
  # standard task and Ubuntu's server seed, and that the official cloud images
  # do not carry: bare-metal firmware and microcode, laptop and phone
  # plumbing, crash-dump tooling (which on 26.04 also reserves up to 512 MiB
  # of every clone's RAM through crashkernel=). Each is purged only when apt
  # would remove that package alone, so one with dependants stays rather than
  # taking something wanted down with it.
  step "purging hardware and installer-only packages"
  for pkg in laptop-detect os-prober discover discover-data installation-report \
    doc-debian debian-faq amd64-microcode intel-microcode iucode-tool \
    firmware-sof-signed wireless-regdb thermald ubuntu-drivers-common \
    python3-xkit upower usbmuxd fwupd modemmanager udisks2 hwctl \
    kdump-tools crash makedumpfile kexec-tools; do
    installed "$pkg" || continue
    removes=$(apt-get -s purge "$pkg" | awk '/^Purg /{print $2}' | tr '\n' ' ')
    if [ "$removes" = "$pkg " ]; then
      apt_get purge "$pkg"
    else
      echo "    keeping $pkg: removing it would also remove: $removes"
    fi
  done
  apt_get autoremove --purge
fi

# --- distribution-specific state ------------------------------------------

case "$ID" in
  debian)
    step "switching the network stack to netplan, systemd-networkd and systemd-resolved"
    # The official Debian cloud images use netplan, systemd-networkd and
    # systemd-resolved, and that is what makes DNS work on a clone with a
    # static address. With ifupdown, cloud-init's eni renderer writes the
    # nameservers as `dns-nameservers` lines, which only resolvconf acts on.
    # Without it /etc/resolv.conf keeps whatever the installer wrote, so a
    # static clone used the build's DNS server forever. With ifupdown gone,
    # cloud-init can only pick netplan.
    command -v netplan >/dev/null || fail "netplan is not installed"
    if installed ifupdown; then
      removes=$(apt-get -s purge ifupdown | awk '/^Purg /{print $2}' | tr '\n' ' ')
      if [ "$removes" = "ifupdown " ]; then
        # Its maintainer scripts stop networking.service, which takes the
        # build's own NIC down mid-script; policy-rc.d forbids that.
        printf '%s\n' '#!/bin/sh' 'exit 101' >/usr/sbin/policy-rc.d
        chmod 755 /usr/sbin/policy-rc.d
        apt_get purge ifupdown
        rm -f /usr/sbin/policy-rc.d
        rm -rf /etc/network/interfaces /etc/network/interfaces.d
      else
        # bullseye's cloud-init depends on ifupdown. Keep it with loopback
        # only; the renderer setting below keeps cloud-init on netplan.
        echo "    keeping ifupdown: removing it would also remove: $removes"
        printf '%s\n' '# Network interfaces are configured by cloud-init through netplan.' \
          '# See interfaces(5).' '' 'source /etc/network/interfaces.d/*' '' \
          'auto lo' 'iface lo inet loopback' >/etc/network/interfaces
        find /etc/network/interfaces.d -mindepth 1 -delete 2>/dev/null || true # may not exist
      fi
    fi
    # cloud-init's renderer order puts eni first on some releases; netplan is
    # the one that applies a static clone's nameservers.
    printf '%s\n' 'system_info:' '  network:' '    renderers: [netplan, eni]' \
      >/etc/cloud/cloud.cfg.d/90-cofoundry-network.cfg
    systemctl enable systemd-networkd.service systemd-resolved.service
    ln -sfn ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
    # Debian's resolved answers LLMNR on 0.0.0.0:5355 by default, which on a
    # public VPS is a responder handing out the hostname to anyone who asks.
    # Ubuntu's does not; neither should these.
    mkdir -p /etc/systemd/resolved.conf.d
    printf '%s\n' '[Resolve]' 'LLMNR=no' 'MulticastDNS=no' >/etc/systemd/resolved.conf.d/10-cofoundry.conf

    step "removing the installer's apt and fstab settings"
    # base-installer writes 00InstallRecommends when the preseed turns
    # Recommends off for the install. Left in place it turns them off for
    # every package a customer installs, unlike stock Debian.
    rm -f /etc/apt/apt.conf.d/00InstallRecommends /etc/apt/apt.conf.d/00trustcdrom \
      /etc/apt/apt.conf.d/00CDMountPoint
    # The netinst CD's mount line lets any user mount whatever sits in the
    # CD drive, and on Proxmox that is the cloud-init drive with its user-data.
    sed -i -E '/^[^#]*[[:space:]]\/media\/cdrom[0-9]*[[:space:]]/d' /etc/fstab
    rm -rf /media/cdrom /media/cdrom[0-9]*
    # netcfg names the build subnet here.
    printf '%s\n' 'default		0.0.0.0' 'loopback	127.0.0.0' 'link-local	169.254.0.0' >/etc/networks
    ;;
  ubuntu)
    step "removing the installer's network, apt and cloud-init settings"
    # Subiquity leaves the build's static address in a netplan file that
    # cloud-init only overwrites when it renders network config. A boot
    # without a usable cloud-init drive would bring the build address up.
    rm -f /etc/netplan/*.yaml
    # Subiquity disables cloud-init after the installed system's first boot
    # (/etc/cloud/cloud-init.disabled) and leaves clean.d/99-installer for
    # `cloud-init clean` to undo that and its other installer configs. Run it
    # now, before the checks below, then name the files it removes anyway in
    # case a release's list differs. 20-disable-cc-dpkg-grub.cfg is among them:
    # it stops cloud-init pointing grub-pc at each clone's own boot disk.
    if [ -f /etc/cloud/clean.d/99-installer ]; then
      python3 /etc/cloud/clean.d/99-installer
    fi
    rm -f /etc/cloud/cloud-init.disabled /etc/cloud/ds-identify.cfg \
      /etc/cloud/cloud.cfg.d/*subiquity-disable-cloudinit-networking.cfg \
      /etc/cloud/cloud.cfg.d/20-disable-cc-dpkg-grub.cfg \
      /etc/cloud/cloud.cfg.d/99-installer.cfg \
      /etc/cloud/cloud.cfg.d/90-installer-network.cfg \
      /etc/cloud/cloud.cfg.d/curtin-preserve-sources.cfg \
      /etc/cloud/clean.d/99-installer \
      /etc/apt/sources.list.d/*.curtin.orig /etc/apt/sources.list.curtin.old
    rm -rf /etc/apt/preferences.d.save
    # multipathd recorded the build disk's WWID; the login banner cached the
    # build address.
    rm -f /etc/multipath/bindings /etc/multipath/wwids /var/lib/landscape/landscape-sysinfo.cache

    # The root filesystem goes read-only on errors in every official image;
    # curtin writes plain `defaults`.
    sed -i -E 's#^([^#[:space:]]+[[:space:]]+/[[:space:]]+ext4[[:space:]]+)defaults([[:space:]])#\1defaults,errors=remount-ro\2#' /etc/fstab
    awk '$2 == "/" && $3 == "ext4"' /etc/fstab | grep -q 'errors=remount-ro' ||
      fail "the root filesystem's fstab entry lacks errors=remount-ro"

    if [ -d /var/lib/snapd ] && command -v snap >/dev/null 2>&1; then
      step "returning snapd to its unseeded state"
      # The build boot seeded snapd, and on 22.04 registered a device with the
      # Snap Store: a serial and a private key every clone would share, plus a
      # refresh-privacy-key on every release. The official images ship
      # unseeded, so each instance seeds and registers itself on first boot.
      # Removing the installed snaps (apps, then bases, then snapd) and
      # snapd's state does the same; the seed stays for first boot to use.
      snaps=$(snap list 2>/dev/null | awk 'NR > 1 {print $1, $NF}')
      for pass in app base snapd; do
        for name in $(awk -v pass="$pass" '
          { kind = ($2 ~ /snapd/) ? "snapd" : ($2 ~ /base/ || $1 ~ /^core[0-9]*$/) ? "base" : "app" }
          kind == pass {print $1}' <<<"$snaps"); do
          snap remove --purge "$name"
        done
      done
      systemctl stop snapd.service snapd.socket
      rm -rf /var/lib/snapd/state.json /var/lib/snapd/device /var/lib/snapd/cookie /var/cache/snapd/*
    fi
    ;;
esac

if [ "$family" = rhel ]; then
  step "applying RHEL-family guest agent and SELinux settings"
  bash "$here/enable-guest-exec.sh"

  # The official images enforce SELinux, and so do these. The guest agent's
  # domain is the one exception: Proxmox's guest-exec and set-password RPCs,
  # and cf verify's smoke test, run their commands in virt_qemu_ga_t, where
  # policy denies even `systemctl is-system-running`. Making that one domain
  # permissive keeps them working without unconfining anything else; the
  # hypervisor that can call those RPCs already owns the disk.
  semodule -i "$here/cofoundry-qemu-ga.cil"
  modules=$(semodule -l)
  grep -qx 'cofoundry-qemu-ga' <<<"$modules" || fail "SELinux module cofoundry-qemu-ga did not load"
  grep -qx 'SELINUX=enforcing' /etc/selinux/config || fail "/etc/selinux/config is not enforcing"
  [ "$(getenforce)" = Enforcing ] || fail "SELinux is $(getenforce), expected Enforcing"

  # el9 and el10 never install it (%packages excludes it); el8's installer
  # insists on it, so it goes here.
  if installed firewalld; then
    dnf -y remove firewalld
  fi
  ! installed firewalld || fail "firewalld is installed; the official images ship without it"

  step "regenerating generic initramfs images and dropping the rescue kernel"
  # dracut-config-generic makes dracut include every storage driver instead
  # of only the build VM's. Images built host-only stop at the dracut shell
  # on a clone moved to another disk controller.
  installed dracut-config-generic || fail "dracut-config-generic is not installed"
  dracut -f --regenerate-all
  for img in /boot/initramfs-*.img; do
    case "$img" in *rescue*) continue ;; esac
    contents=$(lsinitrd "$img")
    grep -q '/vmw_pvscsi\.ko' <<<"$contents" || fail "$img is still host-only (no vmw_pvscsi)"
  done
  rm -f /boot/*-rescue-* /boot/loader/entries/*-rescue.conf

  # The image's repositories are signed with these; import them now so the
  # first `dnf install` on a clone does not stop to ask. One at a time: Rocky
  # 9.9 ships a post-quantum (V6) key its own rpm cannot read yet, and dnf
  # still imports any key a repository needs when it first needs it.
  for key in /etc/pki/rpm-gpg/RPM-GPG-KEY-*; do
    rpm --import "$key" 2>/dev/null || echo "    rpm cannot import $key; leaving it to dnf"
  done

  step "removing the installer's network config and leftovers"
  rm -f /etc/NetworkManager/system-connections/*
  find /etc/sysconfig/network-scripts -maxdepth 1 -name 'ifcfg-*' ! -name ifcfg-lo -delete 2>/dev/null || true # absent on 10
  rm -rf /var/lib/NetworkManager/* /var/lib/dhclient/*
  : >/etc/resolv.conf
  rm -rf /root/anaconda-ks.cfg /root/original-ks.cfg /root/ks-post.log /var/log/anaconda
  rm -f /tmp/ks-script-* /var/lib/dnf/history.sqlite*

  step "configuring GRUB for the serial console"
  # One second, on both the VGA and serial consoles. consoleblank=0 keeps the
  # Proxmox console from going black after ten idle minutes. The argument goes
  # into GRUB_CMDLINE_LINUX as well as the BLS entries, because el8's
  # grub2-mkconfig rewrites kernelopts from it.
  grep -q '^GRUB_CMDLINE_LINUX=.*consoleblank=0' /etc/default/grub ||
    sed -i -E 's/^GRUB_CMDLINE_LINUX="(.*)"$/GRUB_CMDLINE_LINUX="\1 consoleblank=0"/' /etc/default/grub
  sed -i -E '/^GRUB_(TIMEOUT|TERMINAL|TERMINAL_OUTPUT|SERIAL_COMMAND)=/d' /etc/default/grub
  printf '%s\n' 'GRUB_TIMEOUT=1' 'GRUB_TERMINAL="console serial"' \
    'GRUB_SERIAL_COMMAND="serial --speed=115200"' >>/etc/default/grub
  grub2-mkconfig -o /boot/grub2/grub.cfg
  grubby --update-kernel=ALL --args=consoleblank=0
fi

if [ "$family" = debian ]; then
  step "configuring GRUB for the serial console"
  # One second, on both the VGA and serial consoles. Ubuntu otherwise waits
  # 30 seconds at a menu only VGA shows after any boot that did not finish,
  # such as a VM reset or a host crash mid-boot (measured: kernel at 44.7s
  # instead of 14.9s). This file is sourced after /etc/default/grub.
  mkdir -p /etc/default/grub.d
  cat >/etc/default/grub.d/50-cofoundry.cfg <<'EOF'
GRUB_TIMEOUT=1
GRUB_TIMEOUT_STYLE=menu
GRUB_RECORDFAIL_TIMEOUT=1
GRUB_TERMINAL="console serial"
GRUB_SERIAL_COMMAND="serial --speed=115200"
GRUB_CMDLINE_LINUX="console=tty0 console=ttyS0,115200 consoleblank=0"
EOF
  update-grub
  ! grep -q 'crashkernel=' /boot/grub/grub.cfg || fail "grub.cfg still reserves crashkernel memory"
fi

# --- all distributions ---------------------------------------------------------

step "installing the Proxmox cloud-init config"
install -m 0644 "$here/99-pve.cfg" /etc/cloud/cloud.cfg.d/99-pve.cfg

step "checking cloud-init will run on clones"
systemctl is-enabled cloud-init-local cloud-init cloud-config cloud-final >/dev/null ||
  fail "a cloud-init unit is not enabled"
[ ! -e /etc/cloud/cloud-init.disabled ] || fail "/etc/cloud/cloud-init.disabled exists"
! grep -qw 'cloud-init=disabled' /proc/cmdline || fail "cloud-init=disabled is on the kernel cmdline"
grep -qx 'datasource_list: \[ConfigDrive, NoCloud\]' /etc/cloud/cloud.cfg.d/99-pve.cfg ||
  fail "99-pve.cfg does not set the datasource list"
# Merged the way cloud-init reads them (later files win), in either YAML style.
# cloud-init brings PyYAML with it.
net_disabled=$(
  python3 -c '
import glob, yaml
net = None
for path in ["/etc/cloud/cloud.cfg"] + sorted(glob.glob("/etc/cloud/cloud.cfg.d/*.cfg")):
    with open(path) as f:
        data = yaml.safe_load(f) or {}
    if isinstance(data, dict) and "network" in data:
        net = data["network"]
print("yes" if isinstance(net, dict) and net.get("config") == "disabled" else "no")
'
)
[ "$net_disabled" = no ] || fail "a cloud-init config disables cloud-init networking"

step "checking the effective sshd configuration"
# The settings are what matters, not which file holds them: on el8 the
# drop-in directory is not read at all.
mkdir -p /run/sshd
sshd_t=$(sshd -T -C user=root,host=localhost,addr=127.0.0.1 2>/dev/null) || fail "sshd -T failed"
for want in 'permitrootlogin yes' 'passwordauthentication yes'; do
  grep -qx "$want" <<<"$sshd_t" || fail "sshd does not have '$want'"
done

step "removing build network state"
rm -f /etc/udev/rules.d/70-persistent-net.rules
rm -f /var/lib/dhcp/*.leases /var/lib/systemd/network/* 2>/dev/null || true # dirs differ by release
# cloud-init writes the clone's own name here when Proxmox sets
# manage_etc_hosts, which it does; until then a clone is plain localhost.
printf '%s\n' localhost >/etc/hostname
printf '%s\n' '127.0.0.1	localhost' '' \
  '# The following lines are desirable for IPv6 capable hosts' \
  '::1	localhost ip6-localhost ip6-loopback' \
  'ff02::1	ip6-allnodes' 'ff02::2	ip6-allrouters' >/etc/hosts

step "removing per-machine identity"
cloud-init clean --logs
rm -f /etc/cloud/clean.d/99-installer
: >/etc/machine-id
if [ -d /var/lib/dbus ]; then
  rm -f /var/lib/dbus/machine-id
  ln -s /etc/machine-id /var/lib/dbus/machine-id
fi
rm -f /etc/ssh/ssh_host_*
rm -f /var/lib/systemd/random-seed /var/lib/systemd/credential.secret
rm -rf /var/lib/chrony/*
# Debian 13's login databases record the build's SSH logins and source address.
for db in /var/lib/lastlog/lastlog2.db /var/lib/wtmpdb/wtmp.db; do
  [ ! -f "$db" ] || : >"$db"
done
if [ -f /etc/iscsi/initiatorname.iscsi ]; then
  # open-iscsi generates a fresh name on first start when it finds this.
  echo 'GenerateName=yes' >/etc/iscsi/initiatorname.iscsi
fi

step "removing build credentials"
# Root has no usable password in the image; cloud-init sets the clone's. A
# hash of the kickstart's placeholder password used to ship here, one
# `passwd -u` away from a published root password.
usermod -p '*' root
rm -f /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys
rm -f /root/.bash_history /home/*/.bash_history /root/.lesshst /root/.viminfo
rm -f /etc/sudoers.d/packer /etc/sudoers.d/wheel
userdel --remove --force packer 2>/dev/null || true # asserted just below
getent passwd packer >/dev/null && fail "the packer user still exists"
[ ! -e /home/packer ] || fail "/home/packer still exists"
# The shadow-utils backups hold the account lines from before userdel.
rm -f /etc/passwd- /etc/shadow- /etc/group- /etc/gshadow- /etc/subuid- /etc/subgid-

step "cleaning package caches"
case "$family" in
  debian)
    apt_get clean
    # Clones refresh the lists on first boot (Proxmox's cloud-init asks for an
    # upgrade by default); shipping them only adds 140 MiB of stale indexes.
    find /var/lib/apt/lists -mindepth 1 -maxdepth 1 ! -name lock ! -name partial -exec rm -rf {} +
    rm -f /var/cache/apt/*.bin
    ;;
  rhel)
    dnf -y clean all
    rm -rf /var/cache/dnf/*
    ;;
esac

step "clearing logs and temporary files"
# The journal is removed rather than truncated: journald holds it open, and a
# file truncated under it ships as a corrupt journal. The directory stays so
# clones keep a persistent journal.
# Stopped first: a journal deleted while journald holds it open stays
# allocated, so it would ship in the image anyway, build logins and all.
systemctl stop systemd-journald.socket systemd-journald-dev-log.socket \
  systemd-journald-audit.socket systemd-journald.service 2>/dev/null || true # audit socket absent on some
rm -rf /var/log/journal/*
find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' -o -name '*-[0-9]*' \) -delete
find /var/log -type f -exec truncate -s 0 {} +
rm -rf /var/log/installer
find /tmp /var/tmp -xdev -mindepth 1 -delete
# Where /tmp is a tmpfs (Debian 13), the disk's own /tmp sits underneath it,
# still holding whatever the installer wrote there before the first boot. A
# bind mount of / shows the directories beneath every mount point. It goes
# under /run: a mount point inside the /tmp being emptied could not be deleted.
disk_root=/run/cofoundry-disk-root
mkdir -p "$disk_root"
mount --bind / "$disk_root"
find "$disk_root/tmp" "$disk_root/var/tmp" -xdev -mindepth 1 -delete
umount "$disk_root"
rmdir "$disk_root"

step "checking no build address or gateway is left in the image"
for addr in $build_addrs $build_gw; do
  # Binary files too: login databases store addresses as text inside sqlite.
  left=$(grep -rlwF --exclude-dir=rpm --exclude-dir=dpkg "$addr" /etc /var/lib /root 2>/dev/null || true)
  [ -z "$left" ] || fail "build address $addr is still in: $(echo $left)"
done

step "checking the package database is consistent"
# A package manager interrupted by the read-only remount would ship a
# half-configured package to every clone.
case "$family" in
  debian)
    audit=$(dpkg --audit)
    [ -z "$audit" ] || fail "dpkg reports unfinished packages: $audit"
    ;;
  rhel)
    rpm -q rpm >/dev/null || fail "the rpm database is unreadable"
    ;;
esac

step "trimming free space"
fstrim -av

step "remounting read-only; powering off in 3 seconds"
sync
echo 1 >/proc/sys/kernel/sysrq
echo u >/proc/sysrq-trigger
root_ro() { [ "$(awk '$2 == "/" {split($4, o, ","); print o[1]}' /proc/mounts)" = ro ]; }
for _ in $(seq 1 50); do
  root_ro && break
  sleep 0.2
done
root_ro || fail "the root filesystem did not remount read-only"
# Detached, so this script can return its exit status to Packer first. Packer
# then asks Proxmox to shut the VM down, which races this harmlessly: the disk
# is read-only either way, and a shutdown of a stopped VM succeeds.
setsid sh -c 'sleep 3; echo o >/proc/sysrq-trigger' </dev/null >/dev/null 2>&1 &
exit 0
