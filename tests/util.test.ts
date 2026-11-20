import { describe, expect, test } from 'bun:test'
import {
    addSensitiveValues,
    formatMinutes,
    redactSensitive,
    shellQuote,
} from '../src/util.ts'

describe('shellQuote', () => {
    test('quotes single quotes for shell strings', () => {
        expect(shellQuote("can't")).toBe("'can'\\''t'")
    })
})

describe('formatMinutes', () => {
    test('reads to the minute, in hours once there are any', () => {
        expect(formatMinutes(0)).toBe('0m')
        expect(formatMinutes(39 * 60_000 + 29_000)).toBe('39m')
        expect(formatMinutes(260 * 60_000)).toBe('4h20m')
        expect(formatMinutes(300 * 60_000)).toBe('5h00m')
        expect(formatMinutes(-5 * 60_000)).toBe('0m')
    })
})

describe('redactSensitive', () => {
    test('redacts registered values wherever they appear in a string', () => {
        addSensitiveValues('943a053d-0b42-48f9-9398-56ce6f66b7cc')
        const msg =
            "Command failed: ssh root@host 'packer build -var proxmox_token=943a053d-0b42-48f9-9398-56ce6f66b7cc -var proxmox_node=pve1'"
        expect(redactSensitive(msg)).toBe(
            "Command failed: ssh root@host 'packer build -var proxmox_token=[REDACTED] -var proxmox_node=pve1'"
        )
    })

    test('redacts username (token ID) as well as secret', () => {
        addSensitiveValues('user@pam!mytoken', 'super-secret')
        const msg =
            'proxmox_username=user@pam!mytoken proxmox_token=super-secret proxmox_node=pve1'
        expect(redactSensitive(msg)).toBe(
            'proxmox_username=[REDACTED] proxmox_token=[REDACTED] proxmox_node=pve1'
        )
    })

    test('does not redact short or undefined values', () => {
        addSensitiveValues(undefined, 'ab')
        expect(redactSensitive('ab is fine')).toBe('ab is fine')
    })
})
