#!/usr/bin/env bash
# Enable the QEMU guest agent's guest-exec RPC on RHEL-family images.
#
# The build smoke test proves an exported template can reboot by reading the
# guest's kernel boot id over the guest agent's guest-exec RPC before and after
# a reboot (see src/verify/guest.ts, rebootGuest/readBootId). Debian and Ubuntu
# ship qemu-guest-agent with every RPC permitted, so they pass; RHEL ships it
# with guest-exec denied, so almalinux/rocky fail the smoke test with
# "Command guest-exec has been disabled" and never read a boot id.
#
# The deny is expressed two different ways depending on the release:
#
#   * el8  - a *block* list, BLACKLIST_RPC=...,guest-exec,guest-exec-status,...
#            Everything not listed is allowed, so we drop just the two
#            guest-exec entries and leave the file RPCs blocked.
#   * el9+ - an *allow* list, FILTER_RPC_ARGS="--allow-rpcs=...". Everything not
#            listed is denied, so we add guest-exec/guest-exec-status when they
#            are missing (el9 omits both; el10 omits guest-exec-status).
#
# This must run from a Packer provisioner *after* `dnf update`, because a
# qemu-guest-agent package refresh can rewrite /etc/sysconfig/qemu-ga back to
# the shipped defaults, silently reverting an edit made during the kickstart.
set -euo pipefail

cfg=/etc/sysconfig/qemu-ga
if [ ! -f "$cfg" ]; then
    echo "==> $cfg not found; qemu-guest-agent not installed as expected" >&2
    exit 1
fi

if grep -qE '^[[:space:]]*BLACKLIST_RPC=' "$cfg"; then
    # el8 block-list: remove the guest-exec entries, then tidy the commas the
    # removals leave behind (doubled, leading, trailing). guest-exec-status is
    # stripped first so the shorter guest-exec pattern cannot chew a hole in it.
    sed -i -E '/^[[:space:]]*BLACKLIST_RPC=/{
        s/guest-exec-status//g
        s/guest-exec//g
        s/,{2,}/,/g
        s/=,/=/
        s/,$//
    }' "$cfg"
    if grep -qE '^[[:space:]]*BLACKLIST_RPC=([^#]*[=,])?guest-exec([,]|$)' "$cfg"; then
        echo "ERROR: guest-exec still blocked in BLACKLIST_RPC after edit" >&2
        exit 1
    fi
    echo "==> removed guest-exec from BLACKLIST_RPC"
elif grep -qE '^[[:space:]]*FILTER_RPC_ARGS=.*--allow-rpcs=' "$cfg"; then
    # el9/el10 allow-list: ensure both RPCs are present. Membership must be
    # tested against the *active* assignment only, never the whole file: the
    # shipped file documents guest-exec in a commented-out example --block-rpcs
    # line, and matching that comment would make us skip the append yet still
    # "verify" success. The active line is the one starting with the bare key
    # (a comment starts with '#', so it is excluded). The trailing [,"] bound
    # distinguishes an existing guest-exec from guest-exec-status.
    active() { grep -E '^[[:space:]]*FILTER_RPC_ARGS=' "$cfg"; }
    for rpc in guest-exec guest-exec-status; do
        if ! active | grep -qE -- "[=,]${rpc}[,\"]"; then
            # Append inside the allow-rpcs value only, stopping at the first
            # space or quote so a second --arg (if any) is untouched.
            sed -i -E "/^[[:space:]]*FILTER_RPC_ARGS=/ s/(--allow-rpcs=[^\" ]*)/\1,${rpc}/" "$cfg"
        fi
        if ! active | grep -qE -- "[=,]${rpc}[,\"]"; then
            echo "ERROR: ${rpc} not present in allow-rpcs after edit" >&2
            exit 1
        fi
    done
    echo "==> ensured guest-exec/guest-exec-status in FILTER_RPC_ARGS allow-list"
else
    echo "ERROR: no BLACKLIST_RPC or --allow-rpcs filter found in $cfg" >&2
    echo "       the guest-agent RPC filter format has changed; update this script" >&2
    exit 1
fi

# Not strictly needed for the exported image (the file is what the smoke-test
# clone reads at boot), but restarting now proves the edited file still parses.
systemctl restart qemu-guest-agent 2>/dev/null || true
echo "==> guest-exec enabled in the QEMU guest agent"
