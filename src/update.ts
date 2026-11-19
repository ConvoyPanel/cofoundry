import { readFile, writeFile } from 'node:fs/promises'
import type { RecipeInfo } from '@/config.ts'
import { loadSigningKey, verifiedChecksumText } from '@/iso.ts'
import { fetchWithRetry } from '@/util.ts'

export interface IsoUpdate {
    filename: string
    sha256: string
    isoUrl: string
}

// Matches the placeholder we put in iso_checksum_url for archived Debian releases:
// https://cdimage.debian.org/cdimage/archive/latest-12/amd64/iso-cd/SHA256SUMS
const DEBIAN_ARCHIVE_LATEST_RE =
    /^(https:\/\/cdimage\.debian\.org\/cdimage\/archive\/)latest-(\d+)(\/.*SHA256SUMS)$/

const resolveDebianArchiveUrl = async (
    base: string,
    major: number,
    suffix: string
): Promise<string> => {
    const indexRes = await fetchWithRetry(base)
    if (!indexRes.ok)
        throw new Error(`Debian archive index → HTTP ${indexRes.status}`)
    const html = await indexRes.text()
    // Find all N.minor.patch/ directory links in the index
    const versionRe = new RegExp(`href="${major}\\.(\\d+)\\.(\\d+)/"`, 'g')
    let best: { minor: number; patch: number } | undefined
    let m: RegExpExecArray | null
    while ((m = versionRe.exec(html)) !== null) {
        const minor = parseInt(m[1]!),
            patch = parseInt(m[2]!)
        if (
            !best ||
            minor > best.minor ||
            (minor === best.minor && patch > best.patch)
        )
            best = { minor, patch }
    }
    if (!best) throw new Error(`No Debian ${major}.x.y found in archive index`)
    return `${base}${major}.${best.minor}.${best.patch}${suffix}`
}

/**
 * Fetch a checksum file and return the text its vendor signature covers.
 *
 * The ISO URL is derived from the URL this *asked for*, never from where a
 * redirect landed: a mirror that answers the checksum request must not get to
 * choose where the ISO comes from too.
 */
const fetchChecksumFile = async (
    url: string,
    signingKey: string,
    signature: string | undefined
): Promise<{ content: string; baseUrl: string }> => {
    // Resolve Debian archive "latest-N" placeholder before fetching
    const debMatch = DEBIAN_ARCHIVE_LATEST_RE.exec(url)
    if (debMatch) {
        const [, base, majorStr, suffix] = debMatch
        url = await resolveDebianArchiveUrl(base!, parseInt(majorStr!), suffix!)
    }

    const res = await fetchWithRetry(url)
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
    const raw = await res.text()

    let detached: Uint8Array | undefined
    if (signature && signature !== 'clearsigned') {
        // A bare file name, resolved next to the checksum file, so it follows
        // the latest-N resolution above.
        const sigUrl = new URL(signature, url).href
        const sigRes = await fetchWithRetry(sigUrl)
        if (!sigRes.ok) throw new Error(`GET ${sigUrl} → HTTP ${sigRes.status}`)
        detached = new Uint8Array(await sigRes.arrayBuffer())
    }
    const content = await verifiedChecksumText(
        raw,
        await loadSigningKey(signingKey),
        detached
    )
    const baseUrl = url.slice(0, url.lastIndexOf('/') + 1)
    return { content, baseUrl }
}

const parseChecksumFile = (
    content: string,
    filenameRe: RegExp
): { filename: string; sha256: string } | undefined => {
    const matches: { filename: string; sha256: string }[] = []

    // BSD-style: "SHA256 (filename) = hash" — used by AlmaLinux, Rocky Linux
    const bsdRe = /^SHA256 \((.+?)\) = ([0-9a-fA-F]{64})$/gm
    let m: RegExpExecArray | null
    while ((m = bsdRe.exec(content)) !== null) {
        if (filenameRe.test(m[1]!))
            matches.push({ filename: m[1]!, sha256: m[2]!.toLowerCase() })
    }
    if (matches.length > 0) return matches.at(-1)!

    // GNU-style: "hash  filename" or "hash *filename" — used by Ubuntu, Debian
    const gnuRe = /^([0-9a-fA-F]{64})\s+\*?(\S+\.iso)$/gm
    while ((m = gnuRe.exec(content)) !== null) {
        if (filenameRe.test(m[2]!))
            matches.push({ filename: m[2]!, sha256: m[1]!.toLowerCase() })
    }
    return matches.at(-1)
}

export const resolveIsoUpdate = async (
    recipe: RecipeInfo
): Promise<IsoUpdate | undefined> => {
    if (!recipe.isoChecksumUrl || !recipe.isoFilenameRe) return undefined
    // Fail closed: a pin is what every later build trusts, so it is only ever
    // written from a checksum file the vendor's key signed.
    if (!recipe.isoSigningKey)
        throw new Error(
            `${recipe.name} has iso_checksum_url but no # iso_signing_key; refusing to pin an unsigned checksum`
        )
    const { content, baseUrl } = await fetchChecksumFile(
        recipe.isoChecksumUrl,
        recipe.isoSigningKey,
        recipe.isoChecksumSig
    )
    const match = parseChecksumFile(content, new RegExp(recipe.isoFilenameRe))
    if (!match)
        throw new Error(
            `no entry matching /${recipe.isoFilenameRe}/ in ${recipe.isoChecksumUrl}`
        )
    return {
        filename: match.filename,
        sha256: match.sha256,
        isoUrl: baseUrl + match.filename,
    }
}

export const applyIsoUpdate = async (
    recipe: RecipeInfo,
    update: IsoUpdate
): Promise<boolean> => {
    const raw = await readFile(recipe.path, 'utf8')
    const oldIsoFilename = recipe.isoTargetPath?.split('/').pop()
    const newIsoFilename = `packer-${update.filename}`

    let out = raw
    out = out.replace(/^(# iso_url:\s*).+$/m, `$1${update.isoUrl}`)
    out = out.replace(
        /^(# iso_target_path:\s*\$\{var\.iso_cache_dir}\/).+$/m,
        `$1${newIsoFilename}`
    )
    // [0-9a-fA-F]: recipe pins may be pasted from vendors that publish
    // uppercase hashes; a case-sensitive match would silently leave the old
    // pin while iso_url advances, producing a permanently failing build.
    out = out.replace(
        /(\biso_checksum\s*=\s*"sha256:)[0-9a-fA-F]{64}(")/,
        `$1${update.sha256}$2`
    )
    if (oldIsoFilename && oldIsoFilename !== newIsoFilename)
        out = out.replaceAll(oldIsoFilename, newIsoFilename)

    if (out === raw) return false
    await writeFile(recipe.path, out)
    return true
}
