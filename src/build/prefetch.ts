import pRetry, { AbortError } from 'p-retry'
import { createHash } from 'node:crypto'
import type { RecipeInfo } from '@/config.ts'
import {
    CLOUDBASE_INIT_DEFAULT_VERSION,
    VIRTIO_WIN_DEFAULT_VERSION,
    type Env,
} from '@/env.ts'
import { shellQuote } from '@/util.ts'
import { isoUrlCandidates } from '@/iso.ts'
import { remotePaths } from '@/build/paths.ts'
import {
    captureRemote,
    isPermanentWgetExit,
    remoteWgetCapture,
    WgetError,
} from '@/build/remote.ts'

export type PrefetchProgress = (slot: string, line: string) => void

// Either a vendor-published checksum file to match a filename pattern in, or
// a literal pinned sha256 for sources whose vendor publishes none.
export type Checksum =
    | { url: string; filenamePattern: string }
    | { sha256: string }
const ASSET_LOCK_DIR = '/var/lib/cofoundry/asset-locks'

/** A bounded lock pool avoids one persistent lock inode per historical ISO. */
export const assetLockPath = (destination: string): string =>
    `${ASSET_LOCK_DIR}/${createHash('sha256').update(destination).digest('hex').slice(0, 2)}`

/** Last path segment of a URL, with any query string / fragment stripped. */
const urlBasename = (url: string): string => {
    const path = url.replace(/[?#].*$/, '')
    return path.slice(path.lastIndexOf('/') + 1)
}

// Selects the expected hash from a SHA256SUMS-style file (lines of
// "<hash> *<name>" or "<hash>  <name>"). Prefers the line whose filename field
// EXACTLY matches the URL basename (argv[2]): releases.ubuntu.com lists every
// point release in one sums file, so a bare first-regex-match can pick a
// sibling release's hash (24.04.3 when the URL downloads 24.04.4) and doom
// every download to a deterministic mismatch. Falls back to the recipe's
// iso_filename_re (argv[1]) for mirrors whose sums-file names differ from the
// URL basename. Prints "<hash> <matched name>", or nothing on no match.
export const CHECKSUM_EXTRACT_PY =
    'import re,sys; ' +
    "pat=re.compile(sys.argv[1]); base=sys.argv[2] if len(sys.argv)>2 else ''; " +
    'lines=sys.stdin.read().splitlines(); ' +
    "name=lambda l: (lambda m: m.group(1) if m else '')(re.match(r'\\s*[0-9a-fA-F]{64}\\s+\\*?(.+?)\\s*$', l)); " +
    "line=next((l for l in lines if base and name(l)==base), '') or next((l for l in lines if pat.search(l)), ''); " +
    "h=re.findall(r'(?i)\\b[0-9a-f]{64}\\b', line); " +
    "print(h[0].lower()+' '+(name(line) or line.strip()) if h else '')"

const checksumCommand = (pathArg: string, checksum?: Checksum): string => {
    if (!checksum) return `test -s ${pathArg}`
    if ('sha256' in checksum) {
        // expected is also read by the mismatch diagnostics in onInvalid.
        return `expected=${shellQuote(checksum.sha256.toLowerCase())}; actual=$(sha256sum ${pathArg} | awk '{print $1}') && [ "$actual" = "$expected" ]`
    }
    // $expected was resolved from the checksum list once, up front.
    return `actual=$(sha256sum ${pathArg} | awk '{print $1}') && [ "$actual" = "$expected" ]`
}

/**
 * Read the expected hash out of a vendor checksum list, or stop.
 *
 * This used to fall back to "file is not empty" whenever the list could not be
 * fetched or had no entry for the file -- so a stale checksum URL (a 404) was
 * indistinguishable from a verified download. Resolved before the cached copy
 * is judged, so an unreachable list fails the fetch without deleting a cached
 * file that may be fine. Exit 10 keeps it retryable: a list can be briefly
 * unreachable.
 */
const expectedFromListCommand = (
    checksum: { url: string; filenamePattern: string },
    urlBase: string
): string =>
    `entry=$(curl -fsSL ${shellQuote(checksum.url)} 2>/dev/null | ` +
    `python3 -c ${shellQuote(CHECKSUM_EXTRACT_PY)} ${shellQuote(checksum.filenamePattern)} ${shellQuote(urlBase)} || true); ` +
    'expected="${entry%% *}"; matched="${entry#* }"; ' +
    `if [ -z "$expected" ]; then echo ${shellQuote(`no expected checksum for ${urlBase}: ${checksum.url} is unreachable or lists no matching file`)}; exit 10; fi; `

/** Serialize by destination, validate under the lock, and publish by rename. */
export const assetFetchCommand = (
    destination: string,
    url: string,
    checksum?: Checksum
): string => {
    const base = urlBasename(url)
    const valid = checksumCommand(shellQuote(destination), checksum)
    const downloadedValid = checksumCommand('"$tmp"', checksum)
    const resolveExpected =
        checksum && !('sha256' in checksum)
            ? expectedFromListCommand(checksum, base)
            : ''
    // A completed-but-invalid download is removed (resuming garbage that wget
    // considers finished is worse than restarting) and reported with our own
    // exit 9 — outside wget's 0–8 range — alongside the expected/actual hashes
    // and the sums entry that was consulted. A wrong expected hash (e.g. the
    // sums file listing several point releases) then shows up in the log as
    // what it is instead of being masked as "wget exit 1 — generic error".
    const source =
        checksum && !('sha256' in checksum)
            ? `" sums="${shellQuote(checksum.url)}`
            : `" source="${shellQuote('pinned sha256')}`
    const onInvalid = checksum
        ? 'echo "downloaded file failed checksum verification: ' +
          'expected=${expected:-none} actual=${actual:-none} entry=${matched:-none} file="' +
          `${shellQuote(base)}${source}; rm -f "$tmp"; exit 9`
        : 'rm -f "$tmp"; exit 1'
    return (
        `set -e; mkdir -p ${shellQuote(ASSET_LOCK_DIR)}; exec 9>${shellQuote(assetLockPath(destination))}; flock -x 9; ` +
        resolveExpected +
        `if ${valid}; then touch ${shellQuote(destination)}; exit 0; fi; ` +
        `rm -f ${shellQuote(destination)}; ` +
        // Stable temp path (no $$ PID) so a partial transfer survives to be
        // resumed. wget -c continues the same .tmp across both its own --tries
        // and the pRetry re-runs in fetchAsset, instead of re-pulling the whole
        // file from byte 0 and dying at the same point every time. Deliberately
        // no EXIT trap for the same reason: a failed attempt must leave the
        // partial in place for the next attempt to resume. On success mv
        // consumes the temp file; a completed-but-corrupt download (checksum
        // mismatch) is removed so the next attempt restarts clean rather than
        // resuming garbage that wget would consider already complete.
        //
        // -nv (not -q): keep wget's error/retry diagnostics — "Connection
        // closed at byte N. Retrying.", read-timeouts, range-response codes —
        // so a failed fetch is diagnosable from the CI log. --show-progress
        // still forces the transfer bar that -nv would otherwise suppress.
        // --read-timeout caps a stalled read so a mirror that goes silent near
        // the end (as releases.ubuntu.com does under load) is detected and
        // retried in seconds instead of hanging until the whole attempt is lost;
        // --timeout covers DNS/connect. The mirror honors HTTP Range (verified:
        // 206 + Content-Range), so each retry resumes the .tmp rather than
        // re-pulling multiple GB. A few extra --tries ride out transient drops
        // within one invocation before the outer pRetry layer takes over.
        `tmp=${shellQuote(`${destination}.tmp`)}; ` +
        `wget -nv --show-progress --progress=bar:force:noscroll -c --tries=5 --timeout=30 --read-timeout=60 --retry-connrefused --waitretry=5 -O "$tmp" ${shellQuote(url)}; ` +
        `if ${downloadedValid}; then mv -f "$tmp" ${shellQuote(destination)}; else ${onInvalid}; fi`
    )
}

const fetchAsset = async (
    env: Env,
    destination: string,
    url: string,
    slot: string,
    onLine?: PrefetchProgress,
    checksum?: Checksum
): Promise<void> => {
    // The fetch command is idempotent (flock-serialized, checksum-validated,
    // temp download published by atomic rename), so a transient network blip is
    // safe to retry rather than failing the whole build. A permanent failure
    // (stale URL / bad invocation) aborts immediately — retrying it only
    // wastes backoff and buries the real "your URL is wrong" signal.
    await pRetry(
        async () => {
            try {
                await remoteWgetCapture(
                    env.SSH_TARGET,
                    assetFetchCommand(destination, url, checksum),
                    line => onLine?.(slot, line),
                    { url, what: `${slot} fetch` }
                )
            } catch (err) {
                if (
                    err instanceof WgetError &&
                    isPermanentWgetExit(err.exitCode)
                )
                    throw new AbortError(err)
                throw err
            }
        },
        { retries: 3, minTimeout: 1000, factor: 2 }
    )
}

// ── Pinned Windows assets ─────────────────────────────────────────────────────
// Default SHA256 pins for the default versions in src/env.ts, computed from
// the vendor downloads themselves (GitHub release asset / fedorapeople
// archive) — neither vendor publishes a usable checksum file for these
// artifacts (the virtio-win CHECKSUM file covers only the RPMs, as MD5).
const CLOUDBASE_INIT_DEFAULT_SHA256 =
    '0e7fa42e0cbc0ce7657f85730b0c6cc7afc4087a3639df0ff51a721a0be19bd5'
const VIRTIO_WIN_DEFAULT_SHA256 =
    'e14cf2b94492c3e925f0070ba7fdfedeb2048c91eea9c5a5afb30232a3976331'

/** The built-in pin only describes the default version; validating any other
 *  release against it would always fail, so an overridden version without an
 *  explicit CF_*_SHA256 falls back to the plain non-empty check. */
export const pinnedChecksum = (
    override: string | undefined,
    version: string,
    defaultVersion: string,
    defaultSha256: string
): Checksum | undefined => {
    if (override) return { sha256: override }
    return version === defaultVersion ? { sha256: defaultSha256 } : undefined
}

// Upstream names the release asset with an underscored version, e.g.
// CloudbaseInitSetup_1_1_8_x64.msi. Reusing that name as the node-side cache
// key makes the version part of the key, so a version bump refetches instead
// of reusing the previous release forever. buildWritableRepoCommand installs
// the cached file into each build copy under the version-less name the
// recipes reference.
const cloudbaseInitMsiName = (version: string): string =>
    `CloudbaseInitSetup_${version.replace(/\./g, '_')}_x64.msi`

export const cloudbaseInitMsiUrl = (version: string): string =>
    `https://github.com/cloudbase/cloudbase-init/releases/download/${version}/${cloudbaseInitMsiName(version)}`

export const cloudbaseInitMsiCachePath = (
    env: Pick<Env, 'PVE_DUMP_DIR' | 'CF_CLOUDBASE_INIT_VERSION'>
): string =>
    `${remotePaths(env).assetCache}/${cloudbaseInitMsiName(env.CF_CLOUDBASE_INIT_VERSION)}`

/** Versioned cache filename in the Proxmox ISO store. The Windows recipes
 *  receive it through the `virtio_win_iso` Packer variable, and the prune
 *  preserve-glob (src/prune/node.ts) spares every version. */
export const virtioWinIsoFilename = (
    env: Pick<Env, 'CF_VIRTIO_WIN_VERSION'>
): string => `packer-virtio-win-${env.CF_VIRTIO_WIN_VERSION}.iso`

// `virtio-win.iso` inside a versioned archive directory is that release's ISO
// under a stable per-directory name — unlike the floating stable-virtio/
// symlink, whose content changes under the same URL with every release.
export const virtioWinIsoUrl = (version: string): string =>
    `https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-${version}/virtio-win.iso`

/**
 * The checksum list to verify a recipe's ISO against.
 *
 * Archived Debian recipes carry a `cdimage/archive/latest-N/` placeholder in
 * `iso_checksum_url`: `cf update` resolves it to discover the newest point
 * release, but the path itself does not exist (404). The list for the pinned
 * ISO sits next to it, in the same versioned directory.
 */
export const isoChecksumListUrl = (
    isoUrl: string,
    checksumUrl: string
): string =>
    /\/cdimage\/archive\/latest-\d+\//.test(checksumUrl) &&
    /\/cdimage\/archive\/\d+\.\d+\.\d+\//.test(isoUrl)
        ? isoUrl.replace(/[?#].*$/, '').replace(/[^/]+$/, 'SHA256SUMS')
        : checksumUrl

/**
 * What the downloaded boot ISO is checked against.
 *
 * The recipe's pin wins. `cf update` writes it only from a checksum file the
 * vendor's key signed, so it is the one value here that a mirror cannot
 * influence; the live checksum list is fetched at build time from whichever
 * server answers, with no signature check. A recipe without a pin falls back
 * to that list.
 */
export const isoChecksum = (recipe: RecipeInfo): Checksum | undefined => {
    if (recipe.isoSha256) return { sha256: recipe.isoSha256 }
    if (recipe.isoChecksumUrl && recipe.isoFilenameRe)
        return {
            url: recipe.isoUrl
                ? isoChecksumListUrl(recipe.isoUrl, recipe.isoChecksumUrl)
                : recipe.isoChecksumUrl,
            filenamePattern: recipe.isoFilenameRe,
        }
    return undefined
}

/**
 * Fetch from the first URL that serves the file. Only a permanent failure
 * (the URL is gone) moves on to the next candidate; a transient one already
 * exhausted its retries inside fetchAsset, and a checksum mismatch means the
 * bytes are wrong, which another URL for the same file will not fix.
 */
const fetchFirstAvailable = async (
    env: Env,
    destination: string,
    urls: string[],
    slot: string,
    onLine?: PrefetchProgress,
    checksum?: Checksum
): Promise<void> => {
    for (const [i, url] of urls.entries()) {
        try {
            await fetchAsset(env, destination, url, slot, onLine, checksum)
            return
        } catch (err) {
            const gone =
                err instanceof WgetError && isPermanentWgetExit(err.exitCode)
            if (!gone || i === urls.length - 1) throw err
            onLine?.(slot, `${url} is gone; trying ${urls[i + 1]}`)
        }
    }
}

export const prefetchPhase = async (
    env: Env,
    recipe: RecipeInfo,
    onLine?: PrefetchProgress
): Promise<void> => {
    if (recipe.isoUrl && recipe.isoTargetPath) {
        await captureRemote(
            env.SSH_TARGET,
            `mkdir -p ${shellQuote(recipe.isoTargetPath.replace(/\/[^/]+$/, ''))}`
        )
        await fetchFirstAvailable(
            env,
            recipe.isoTargetPath,
            isoUrlCandidates(recipe.isoUrl),
            'iso',
            onLine,
            isoChecksum(recipe)
        )
    }

    if (!recipe.name.startsWith('windows-')) return

    const paths = remotePaths(env)
    await captureRemote(
        env.SSH_TARGET,
        `mkdir -p ${shellQuote(paths.assetCache)}`
    )
    await fetchAsset(
        env,
        cloudbaseInitMsiCachePath(env),
        cloudbaseInitMsiUrl(env.CF_CLOUDBASE_INIT_VERSION),
        'msi',
        onLine,
        pinnedChecksum(
            env.CF_CLOUDBASE_INIT_SHA256,
            env.CF_CLOUDBASE_INIT_VERSION,
            CLOUDBASE_INIT_DEFAULT_VERSION,
            CLOUDBASE_INIT_DEFAULT_SHA256
        )
    )
    await fetchAsset(
        env,
        `${paths.isoStore}/${virtioWinIsoFilename(env)}`,
        virtioWinIsoUrl(env.CF_VIRTIO_WIN_VERSION),
        'virtio',
        onLine,
        pinnedChecksum(
            env.CF_VIRTIO_WIN_SHA256,
            env.CF_VIRTIO_WIN_VERSION,
            VIRTIO_WIN_DEFAULT_VERSION,
            VIRTIO_WIN_DEFAULT_SHA256
        )
    )
}
