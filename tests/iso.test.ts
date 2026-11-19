import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as openpgp from 'openpgp'
import { isoUrlCandidates, verifiedChecksumText } from '@/iso.ts'
import { isoChecksum } from '@/build/prefetch.ts'
import { loadRecipe } from '@/config.ts'

const recipesDir = fileURLToPath(new URL('../recipes/', import.meta.url))
const keysDir = fileURLToPath(new URL('../keys/', import.meta.url))

describe('isoUrlCandidates', () => {
    test('adds each vendor archive location after the recipe URL', () => {
        const cases: [string, string][] = [
            [
                'https://cdimage.debian.org/cdimage/release/current/amd64/iso-cd/debian-13.7.0-amd64-netinst.iso',
                'https://cdimage.debian.org/cdimage/archive/13.7.0/amd64/iso-cd/debian-13.7.0-amd64-netinst.iso',
            ],
            [
                'https://releases.ubuntu.com/24.04/ubuntu-24.04.5-live-server-amd64.iso',
                'https://old-releases.ubuntu.com/releases/24.04.5/ubuntu-24.04.5-live-server-amd64.iso',
            ],
            [
                'https://releases.ubuntu.com/26.04/ubuntu-26.04-live-server-amd64.iso',
                'https://old-releases.ubuntu.com/releases/26.04/ubuntu-26.04-live-server-amd64.iso',
            ],
            [
                'https://repo.almalinux.org/almalinux/9/isos/x86_64/AlmaLinux-9.8-x86_64-minimal.iso',
                'https://vault.almalinux.org/9.8/isos/x86_64/AlmaLinux-9.8-x86_64-minimal.iso',
            ],
            [
                'https://download.rockylinux.org/pub/rocky/9/isos/x86_64/Rocky-9.8-x86_64-minimal.iso',
                'https://dl.rockylinux.org/vault/rocky/9.8/isos/x86_64/Rocky-9.8-x86_64-minimal.iso',
            ],
        ]
        for (const [url, archive] of cases)
            expect(isoUrlCandidates(url)).toEqual([url, archive])
    })

    test('leaves URLs it does not recognize alone', () => {
        const url =
            'https://cdimage.debian.org/cdimage/archive/12.15.0/amd64/iso-cd/debian-12.15.0-amd64-netinst.iso'
        expect(isoUrlCandidates(url)).toEqual([url])
        expect(isoUrlCandidates('https://example.com/x.iso')).toEqual([
            'https://example.com/x.iso',
        ])
    })
})

describe('verifiedChecksumText', () => {
    const sums = 'aaaa  debian-13.7.0-amd64-netinst.iso\n'

    const keyPair = async () =>
        openpgp.generateKey({
            type: 'ecc',
            curve: 'curve25519Legacy',
            userIDs: [{ name: 'test' }],
            format: 'object',
        })

    test('accepts a detached signature by the pinned key', async () => {
        const { privateKey, publicKey } = await keyPair()
        const signature = await openpgp.sign({
            message: await openpgp.createMessage({ text: sums }),
            signingKeys: privateKey,
            detached: true,
            format: 'binary',
        })
        expect(await verifiedChecksumText(sums, [publicKey], signature)).toBe(
            sums
        )
    })

    test('returns the signed body of a clearsigned file', async () => {
        const { privateKey, publicKey } = await keyPair()
        const clear = await openpgp.sign({
            message: await openpgp.createCleartextMessage({ text: sums }),
            signingKeys: privateKey,
        })
        const text = await verifiedChecksumText(clear, [publicKey])
        expect(text.trim()).toBe(sums.trim())
    })

    test('rejects a file signed by any other key', async () => {
        const signer = await keyPair()
        const pinned = await keyPair()
        const signature = await openpgp.sign({
            message: await openpgp.createMessage({ text: sums }),
            signingKeys: signer.privateKey,
            detached: true,
            format: 'binary',
        })
        await expect(
            verifiedChecksumText(sums, [pinned.publicKey], signature)
        ).rejects.toThrow('did not verify')
    })

    test('rejects a checksum file altered after signing', async () => {
        const { privateKey, publicKey } = await keyPair()
        const signature = await openpgp.sign({
            message: await openpgp.createMessage({ text: sums }),
            signingKeys: privateKey,
            detached: true,
            format: 'binary',
        })
        await expect(
            verifiedChecksumText(
                sums.replace('aaaa', 'bbbb'),
                [publicKey],
                signature
            )
        ).rejects.toThrow('did not verify')
    })

    test('rejects an unsigned file when no detached signature is named', async () => {
        const { publicKey } = await keyPair()
        await expect(verifiedChecksumText(sums, [publicKey])).rejects.toThrow(
            'not clearsigned'
        )
    })
})

describe('recipe ISO pins', () => {
    const linux = readdirSync(recipesDir)
        .filter(f => f.endsWith('.pkr.hcl') && !f.startsWith('windows-'))
        .map(f => basename(f, '.pkr.hcl'))

    test('every Linux recipe names a committed signing key and pins its ISO', async () => {
        expect(linux.length).toBeGreaterThan(0)
        for (const name of linux) {
            const recipe = await loadRecipe(name)
            expect(recipe.isoSigningKey, name).toBeDefined()
            expect(
                existsSync(join(keysDir, `${recipe.isoSigningKey}.asc`)),
                name
            ).toBe(true)
            expect(recipe.isoChecksumSig, name).toBeDefined()
            expect(recipe.isoSha256, name).toMatch(/^[0-9a-f]{64}$/)
        }
    })

    test('the build checks the ISO against the pin, not the live checksum file', async () => {
        for (const name of linux) {
            const recipe = await loadRecipe(name)
            expect(isoChecksum(recipe), name).toEqual({
                sha256: recipe.isoSha256!,
            })
        }
    })

    test('every committed key file holds exactly the key its name says', async () => {
        // The trust anchors. A key file swapped for another key would make
        // `cf update` pin whatever that key signed; fingerprints are from the
        // vendors' own HTTPS pages (see keys/README.md).
        const expected: Record<string, string> = {
            'almalinux-8': 'bc5eddcadf502c077f1582882ae81e8aced7258b',
            'almalinux-9': 'bf18ac2876178908d6e71267d36cb86cb86b3716',
            'almalinux-10': 'ee6db7b98f5bf5edd9da0de5dee5c11cc2a1e572',
            'debian-cd': 'df9b9c49eaa9298432589d76da87e80d6294be9b',
            'rocky-linux-8': '7051c470a929f454cebe37b715af5dac6d745a60',
            'rocky-linux-9': '21cb256ae16fc54c6e652949702d426d350d275d',
            'rocky-linux-10': 'fc226859c0860bf0ddb95b085b106c736fedfc85',
            'ubuntu-cdimage': '843938df228d22f7b3742bc0d94aa3f0efe21092',
        }
        const files = readdirSync(keysDir)
            .filter(f => f.endsWith('.asc'))
            .map(f => basename(f, '.asc'))
            .sort()
        expect(files).toEqual(Object.keys(expected).sort())
        for (const [name, fingerprint] of Object.entries(expected)) {
            const keys = await openpgp.readKeys({
                armoredKeys: readFileSync(join(keysDir, `${name}.asc`), 'utf8'),
            })
            expect(
                keys.map(k => k.getFingerprint()),
                name
            ).toEqual([fingerprint])
        }
    })
})
