import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
    assetFetchCommand,
    isoChecksumListUrl,
    CHECKSUM_EXTRACT_PY,
    cloudbaseInitMsiCachePath,
    cloudbaseInitMsiUrl,
    pinnedChecksum,
    virtioWinIsoFilename,
    virtioWinIsoUrl,
} from '@/build/prefetch.ts'
import { describeExit, isPermanentWgetExit, WGET_EXIT } from '@/build/remote.ts'
import {
    CLOUDBASE_INIT_DEFAULT_VERSION,
    VIRTIO_WIN_DEFAULT_VERSION,
} from '@/env.ts'

describe('assetFetchCommand', () => {
    test('locks, validates, and atomically publishes to a stable temp file', () => {
        const command = assetFetchCommand(
            '/var/lib/vz/template/iso/packer-debian.iso',
            'https://example.com/debian.iso',
            {
                url: 'https://example.com/SHA256SUMS',
                filenamePattern: 'debian-.*\\.iso',
            }
        )
        const result = spawnSync('bash', ['-n'], {
            input: command,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(command).toContain('flock -x 9')
        // Stable temp path (no $$ PID) so pRetry re-runs resume the same
        // partial rather than starting a fresh download each attempt.
        expect(command).toContain(".tmp'; ")
        expect(command).not.toContain('.$$')
        expect(command).toContain('sha256sum "$tmp"')
        expect(command).toContain('mv -f "$tmp"')
    })

    test('resumes an interrupted transfer instead of restarting from zero', () => {
        const command = assetFetchCommand(
            '/var/lib/vz/template/iso/packer-debian.iso',
            'https://example.com/debian.iso'
        )
        // -c resumes the partial .tmp; without it wget re-pulls from byte 0.
        expect(command).toContain(' -c ')
        // No EXIT trap, or a failed attempt would delete the partial it must
        // leave behind for the next attempt to resume.
        expect(command).not.toContain('trap')
        expect(command).toContain('--tries=5')
        expect(command).toContain('--retry-connrefused')
        expect(command).toContain('--waitretry=5')
        // A stalled read must be detected and retried, not left to hang until
        // the whole attempt is lost near the end of a multi-GB transfer.
        expect(command).toContain('--read-timeout=60')
        expect(command).toContain('--timeout=30')
        // -nv (not -q) keeps wget's error/retry lines in the CI log so a failed
        // fetch is diagnosable; --show-progress still forces the transfer bar.
        expect(command).toContain('wget -nv --show-progress')
        expect(command).not.toContain('wget -q')
    })

    test('threads the URL basename through to the checksum extraction', () => {
        const command = assetFetchCommand(
            '/var/lib/vz/template/iso/packer-ubuntu-24.04.iso',
            'https://releases.ubuntu.com/24.04/ubuntu-24.04.4-live-server-amd64.iso?query=1',
            {
                url: 'https://releases.ubuntu.com/24.04/SHA256SUMS',
                filenamePattern:
                    'ubuntu-24\\.04(\\.\\d+)?-live-server-amd64\\.iso',
            }
        )
        // Pattern first, then the exact URL basename (query string stripped) as
        // argv[2] of the extraction one-liner.
        expect(command).toContain(
            "'ubuntu-24\\.04(\\.\\d+)?-live-server-amd64\\.iso' 'ubuntu-24.04.4-live-server-amd64.iso'"
        )
        const result = spawnSync('bash', ['-n'], {
            input: command,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })

    test('reports a checksum mismatch with exit 9 and the hashes involved', () => {
        const command = assetFetchCommand(
            '/var/lib/vz/template/iso/packer-ubuntu-24.04.iso',
            'https://releases.ubuntu.com/24.04/ubuntu-24.04.4-live-server-amd64.iso',
            {
                url: 'https://releases.ubuntu.com/24.04/SHA256SUMS',
                filenamePattern:
                    'ubuntu-24\\.04(\\.\\d+)?-live-server-amd64\\.iso',
            }
        )
        // Deleted (never resumed as garbage), diagnosed, and surfaced under an
        // exit code outside wget's 0–8 range instead of the misleading
        // "wget exit 1 — generic error".
        expect(command).toContain('rm -f "$tmp"; exit 9')
        expect(command).toContain('failed checksum verification')
        expect(command).toContain('expected=${expected:-none}')
        expect(command).toContain('actual=${actual:-none}')
        expect(command).toContain('entry=${matched:-none}')
        expect(command).toContain(
            "'https://releases.ubuntu.com/24.04/SHA256SUMS'"
        )
    })

    test('stops with exit 10 when the checksum list yields no hash', () => {
        // It used to fall back to "file is not empty", so a 404 on the list
        // passed as verified. Resolved before the cached copy is judged, so a
        // briefly unreachable list cannot get a good cached ISO deleted.
        const command = assetFetchCommand(
            '/var/lib/vz/template/iso/packer-debian-12.iso',
            'https://cdimage.debian.org/cdimage/archive/12.15.0/amd64/iso-cd/debian-12.15.0-amd64-netinst.iso',
            {
                url: 'https://cdimage.debian.org/cdimage/archive/12.15.0/amd64/iso-cd/SHA256SUMS',
                filenamePattern: 'debian-12\\.\\d+\\.\\d+-amd64-netinst\\.iso',
            }
        )
        expect(command).not.toContain('test -s')
        const resolve = command.indexOf('exit 10')
        expect(resolve).toBeGreaterThan(-1)
        expect(resolve).toBeLessThan(command.indexOf('rm -f '))
        const result = spawnSync('bash', ['-n'], {
            input: command,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
    })

    test('keeps exit 1 for a failed size check when no checksum is configured', () => {
        const command = assetFetchCommand(
            '/var/lib/vz/template/iso/packer-debian.iso',
            'https://example.com/debian.iso'
        )
        expect(command).toContain('rm -f "$tmp"; exit 1')
        expect(command).not.toContain('exit 9')
    })
})

// The one-liner needs a local python; the host may only ship `python` or the
// Windows `py` launcher (or none at all). Skip rather than fail when no
// interpreter is available — the code under test always runs on the Proxmox
// node, which has python3.
const pythonBin = ['python3', 'python', 'py'].find(bin => {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' })
    return r.status === 0 && `${r.stdout}${r.stderr}`.includes('Python')
})
const pyTest = pythonBin ? test : test.skip

describe('CHECKSUM_EXTRACT_PY', () => {
    const extract = (sums: string, pattern: string, base: string): string => {
        const r = spawnSync(
            pythonBin!,
            ['-c', CHECKSUM_EXTRACT_PY, pattern, base],
            {
                input: sums,
                encoding: 'utf8',
            }
        )
        expect(r.status, r.stderr).toBe(0)
        return r.stdout.trim()
    }

    // Reproduces https://releases.ubuntu.com/24.04/SHA256SUMS while 24.04.3
    // and 24.04.4 were both listed: the recipe's iso_filename_re matches BOTH
    // lines, so first-match extraction returned 24.04.3's hash while iso_url
    // downloaded 24.04.4 — a deterministic mismatch on every attempt.
    const OLD_HASH = 'c3514bf0' + 'ab'.repeat(28)
    const NEW_HASH = 'e907d92e' + 'cd'.repeat(28)
    const SUMS =
        `${OLD_HASH} *ubuntu-24.04.3-live-server-amd64.iso\n` +
        `${NEW_HASH} *ubuntu-24.04.4-live-server-amd64.iso\n`
    const PATTERN = 'ubuntu-24\\.04(\\.\\d+)?-live-server-amd64\\.iso'

    pyTest(
        'prefers the exact URL-basename line over the first regex match',
        () => {
            expect(
                extract(SUMS, PATTERN, 'ubuntu-24.04.4-live-server-amd64.iso')
            ).toBe(`${NEW_HASH} ubuntu-24.04.4-live-server-amd64.iso`)
        }
    )

    pyTest('falls back to the first regex match without an exact hit', () => {
        // iso_filename_re exists for mirrors whose sums-file names differ from
        // the URL basename — that semantic must survive.
        expect(
            extract(SUMS, PATTERN, 'ubuntu-24.04.9-live-server-amd64.iso')
        ).toBe(`${OLD_HASH} ubuntu-24.04.3-live-server-amd64.iso`)
    })

    pyTest(
        'matches the "<hash>  <name>" format without the binary marker',
        () => {
            const sums = `${NEW_HASH.toUpperCase()}  plain.iso\n`
            expect(extract(sums, 'no-regex-match', 'plain.iso')).toBe(
                `${NEW_HASH} plain.iso`
            )
        }
    )

    pyTest('prints nothing when neither basename nor pattern matches', () => {
        expect(extract(SUMS, 'nope\\.iso', 'nope.iso')).toBe('')
    })
})

describe('assetFetchCommand with a pinned sha256', () => {
    const destination =
        '/var/lib/vz/template/iso/packer-virtio-win-0.1.285-1.iso'
    const command = assetFetchCommand(
        destination,
        'https://example.com/virtio-win.iso',
        {
            sha256: 'E14CF2B94492C3E925F0070BA7FDFEDEB2048C91EEA9C5A5AFB30232A3976331',
        }
    )

    test('validates the cached file and the fresh download against the pin', () => {
        const result = spawnSync('bash', ['-n'], {
            input: command,
            encoding: 'utf8',
        })
        expect(result.status, result.stderr).toBe(0)
        expect(command).toContain(`sha256sum '${destination}'`)
        expect(command).toContain('sha256sum "$tmp"')
        // The pin is compared lowercased, once per validation site.
        const pin =
            "'e14cf2b94492c3e925f0070ba7fdfedeb2048c91eea9c5a5afb30232a3976331'"
        expect(command.split(pin).length - 1).toBe(2)
    })

    test('never degenerates to a non-empty check or a remote checksum fetch', () => {
        expect(command).not.toContain('test -s')
        expect(command).not.toContain('curl')
    })
})

describe('pinnedChecksum', () => {
    test('an explicit override wins regardless of version', () => {
        expect(pinnedChecksum('abc123', '9.9.9', '1.1.8', 'def456')).toEqual({
            sha256: 'abc123',
        })
    })

    test('the built-in pin applies only to the default version', () => {
        expect(pinnedChecksum(undefined, '1.1.8', '1.1.8', 'def456')).toEqual({
            sha256: 'def456',
        })
        // A bumped version without an explicit pin must not be validated
        // against the default version's hash — that would always fail.
        expect(
            pinnedChecksum(undefined, '9.9.9', '1.1.8', 'def456')
        ).toBeUndefined()
    })
})

describe('pinned Windows asset locations', () => {
    test('cloudbase-init resolves to the versioned GitHub release, not latest', () => {
        expect(cloudbaseInitMsiUrl(CLOUDBASE_INIT_DEFAULT_VERSION)).toBe(
            `https://github.com/cloudbase/cloudbase-init/releases/download/${CLOUDBASE_INIT_DEFAULT_VERSION}/CloudbaseInitSetup_${CLOUDBASE_INIT_DEFAULT_VERSION.replace(/\./g, '_')}_x64.msi`
        )
        expect(
            cloudbaseInitMsiUrl(CLOUDBASE_INIT_DEFAULT_VERSION)
        ).not.toContain('latest')
    })

    test('virtio-win resolves to the versioned archive, not stable-virtio', () => {
        expect(virtioWinIsoUrl(VIRTIO_WIN_DEFAULT_VERSION)).toBe(
            `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-${VIRTIO_WIN_DEFAULT_VERSION}/virtio-win.iso`
        )
        expect(virtioWinIsoUrl(VIRTIO_WIN_DEFAULT_VERSION)).not.toContain(
            'stable-virtio'
        )
    })

    test('cache filenames include the version so a bump refetches', () => {
        expect(
            cloudbaseInitMsiCachePath({
                PVE_DUMP_DIR: '/dump',
                CF_CLOUDBASE_INIT_VERSION: '1.1.8',
            })
        ).toBe('/dump/cofoundry-cache/CloudbaseInitSetup_1_1_8_x64.msi')
        expect(
            virtioWinIsoFilename({ CF_VIRTIO_WIN_VERSION: '0.1.285-1' })
        ).toBe('packer-virtio-win-0.1.285-1.iso')
        expect(
            cloudbaseInitMsiCachePath({
                PVE_DUMP_DIR: '/dump',
                CF_CLOUDBASE_INIT_VERSION: '1.1.9',
            })
        ).not.toBe(
            cloudbaseInitMsiCachePath({
                PVE_DUMP_DIR: '/dump',
                CF_CLOUDBASE_INIT_VERSION: '1.1.8',
            })
        )
        expect(
            virtioWinIsoFilename({ CF_VIRTIO_WIN_VERSION: '0.1.271-1' })
        ).not.toBe(virtioWinIsoFilename({ CF_VIRTIO_WIN_VERSION: '0.1.285-1' }))
    })
})

describe('isPermanentWgetExit', () => {
    test('treats a stale URL (8) and a bad invocation (2) as permanent', () => {
        expect(isPermanentWgetExit(8)).toBe(true)
        expect(isPermanentWgetExit(2)).toBe(true)
    })

    test('treats network/generic faults as retryable', () => {
        for (const code of [1, 3, 4, 5, 7])
            expect(isPermanentWgetExit(code)).toBe(false)
    })

    test('treats a checksum mismatch (9) as retryable, not permanent', () => {
        // Genuine transport corruption heals on retry; a deterministic
        // mismatch is now visible in the log on every attempt instead.
        expect(isPermanentWgetExit(9)).toBe(false)
    })
})

describe('WGET_EXIT', () => {
    test('maps our checksum-failure exit 9 to a self-explanatory message', () => {
        expect(WGET_EXIT[9]).toBe(
            'downloaded file failed checksum verification — expected hash did not match'
        )
    })
})

describe('describeExit', () => {
    test('uses the wget table for wget/our own codes (1-9)', () => {
        expect(describeExit(8)).toBe(WGET_EXIT[8])
        expect(describeExit(9)).toBe(WGET_EXIT[9])
    })

    test('decodes non-wget shell and ssh codes instead of calling them wget errors', () => {
        expect(describeExit(255)).toBe(
            'ssh connection or authentication failed'
        )
        expect(describeExit(127)).toBe(
            'command not found (is wget installed on the remote node?)'
        )
        expect(describeExit(126)).toBe('command found but not executable')
    })

    test('decodes a signal death (128+N) as the signal number', () => {
        expect(describeExit(130)).toBe('process killed by signal 2') // Ctrl-C
        expect(describeExit(137)).toBe('process killed by signal 9') // SIGKILL/OOM
        expect(describeExit(143)).toBe('process killed by signal 15') // SIGTERM
    })

    test('still surfaces the raw number for anything unmapped', () => {
        expect(describeExit(42)).toBe('unmapped exit code 42')
    })
})

describe('isoChecksumListUrl', () => {
    test("points an archived Debian placeholder at the ISO's own SHA256SUMS", () => {
        // cdimage/archive/latest-12/ does not exist (404); it is a marker for
        // `cf update`. The pinned ISO's list sits next to it.
        expect(
            isoChecksumListUrl(
                'https://cdimage.debian.org/cdimage/archive/12.15.0/amd64/iso-cd/debian-12.15.0-amd64-netinst.iso',
                'https://cdimage.debian.org/cdimage/archive/latest-12/amd64/iso-cd/SHA256SUMS'
            )
        ).toBe(
            'https://cdimage.debian.org/cdimage/archive/12.15.0/amd64/iso-cd/SHA256SUMS'
        )
    })

    test('leaves every other checksum URL alone', () => {
        const ubuntu = 'https://releases.ubuntu.com/24.04/SHA256SUMS'
        expect(
            isoChecksumListUrl(
                'https://releases.ubuntu.com/24.04/ubuntu-24.04.4-live-server-amd64.iso',
                ubuntu
            )
        ).toBe(ubuntu)
    })
})
