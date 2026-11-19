import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as openpgp from 'openpgp'

/**
 * Where a vendor serves a point-release ISO after the next point release
 * supersedes it.
 *
 * Every vendor moves the old ISO out of its release directory on the day the
 * next one ships, so a recipe pinned to `debian-13.7.0` or `AlmaLinux-9.8`
 * starts 404ing without anything in the repo changing. That made debian-13
 * unbuildable for weeks, and on 2026-11-16 the AlmaLinux 9 and 10 pins were
 * 404ing the same way. Each vendor keeps the superseded ISO, byte for byte,
 * under an archive path, so the pinned checksum still applies there.
 *
 * Returns the recipe's own URL first, then the archive location if the URL
 * matches a vendor layout this knows. A URL it does not recognize comes back
 * alone.
 */
export const isoUrlCandidates = (url: string): string[] => {
    const archived: [RegExp, (m: RegExpMatchArray) => string][] = [
        // cdimage/release/{current,13.7.0}/… → cdimage/archive/13.7.0/…
        [
            /^https:\/\/cdimage\.debian\.org\/cdimage\/release\/[^/]+\/(.+\/debian-(\d+\.\d+\.\d+)-[^/]+\.iso)$/,
            m => `https://cdimage.debian.org/cdimage/archive/${m[2]}/${m[1]}`,
        ],
        // releases.ubuntu.com/24.04/ubuntu-24.04.4-… → old-releases…/releases/24.04.4/…
        [
            /^https:\/\/releases\.ubuntu\.com\/[^/]+\/(ubuntu-(\d+\.\d+(?:\.\d+)?)-[^/]+\.iso)$/,
            m => `https://old-releases.ubuntu.com/releases/${m[2]}/${m[1]}`,
        ],
        // repo.almalinux.org/almalinux/9/isos/… → vault.almalinux.org/9.8/isos/…
        [
            /^https:\/\/repo\.almalinux\.org\/almalinux\/[^/]+\/(isos\/[^/]+\/AlmaLinux-(\d+\.\d+)-[^/]+\.iso)$/,
            m => `https://vault.almalinux.org/${m[2]}/${m[1]}`,
        ],
        // {dl,download}.rockylinux.org/pub/rocky/9/isos/… → dl…/vault/rocky/9.8/isos/…
        [
            /^https:\/\/(?:dl|download)\.rockylinux\.org\/pub\/rocky\/[^/]+\/(isos\/[^/]+\/Rocky-(\d+\.\d+)-[^/]+\.iso)$/,
            m => `https://dl.rockylinux.org/vault/rocky/${m[2]}/${m[1]}`,
        ],
    ]
    for (const [re, archive] of archived) {
        const m = url.match(re)
        if (m) return [url, archive(m)]
    }
    return [url]
}

const KEYS_DIR = fileURLToPath(new URL('../keys/', import.meta.url))

/** A recipe's signing-key name must be a bare file stem under keys/. */
const SAFE_KEY_NAME = /^[a-z0-9][a-z0-9.-]*$/

export const loadSigningKey = async (
    name: string,
    keysDir: string = KEYS_DIR
): Promise<openpgp.Key[]> => {
    if (!SAFE_KEY_NAME.test(name))
        throw new Error(`invalid iso_signing_key name: ${name}`)
    return openpgp.readKeys({
        armoredKeys: await readFile(`${keysDir}${name}.asc`, 'utf8'),
    })
}

const CLEARSIGNED = '-----BEGIN PGP SIGNED MESSAGE-----'

/**
 * Verify a vendor checksum file against the vendor's signing key and return
 * the text the signature covers.
 *
 * A checksum file fetched over HTTPS only proves which server answered, and
 * Debian's ISO downloads redirect to third-party mirrors. The signature is what
 * ties the hashes to the vendor. Two shapes exist: a clearsigned file
 * (AlmaLinux's CHECKSUM), where the returned text is the signed body rather
 * than the raw download, and a detached signature beside the file (Debian's
 * SHA256SUMS.sign, Ubuntu's SHA256SUMS.gpg, Rocky's CHECKSUM.asc).
 *
 * Throws on anything short of a valid signature by one of `keys`.
 */
export const verifiedChecksumText = async (
    content: string,
    keys: openpgp.Key[],
    detachedSignature?: Uint8Array
): Promise<string> => {
    let text: string
    let verification: openpgp.VerifyMessageResult<string>
    if (detachedSignature) {
        const armored = new TextDecoder().decode(detachedSignature)
        const signature = armored.includes('-----BEGIN PGP SIGNATURE-----')
            ? await openpgp.readSignature({ armoredSignature: armored })
            : await openpgp.readSignature({
                  binarySignature: detachedSignature,
              })
        text = content
        verification = await openpgp.verify({
            message: await openpgp.createMessage({ text: content }),
            signature,
            verificationKeys: keys,
        })
    } else {
        if (!content.trimStart().startsWith(CLEARSIGNED))
            throw new Error(
                'checksum file is not clearsigned and the recipe names no detached signature'
            )
        const message = await openpgp.readCleartextMessage({
            cleartextMessage: content,
        })
        text = message.getText()
        verification = await openpgp.verify({
            message,
            verificationKeys: keys,
        })
    }
    // One good signature by a trusted key is what gpgv accepts too. The text
    // it covers is the whole file, so an extra signature by some other key
    // (a vendor co-signing with a new key) changes nothing about what is
    // trusted.
    const failures: string[] = []
    for (const sig of verification.signatures) {
        try {
            await sig.verified
            return text
        } catch (err) {
            failures.push(err instanceof Error ? err.message : String(err))
        }
    }
    throw new Error(
        `checksum signature did not verify against the pinned key: ${failures.join('; ') || 'no signatures'}`
    )
}
