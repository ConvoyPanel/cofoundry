import { describe, expect, test } from 'bun:test'
import {
    parseQmCreateSchema,
    supportsFormatKey,
    supportsOption,
} from '@/registry/qm-schema.ts'

/** Verbatim excerpt of `qm help create --verbose` on Proxmox VE 9.2.2. */
const help = await Bun.file(
    new URL('./fixtures/qm-help-create.txt', import.meta.url)
).text()

/** The same node one release earlier: PVE 9.0 had no `ms-cert` on efidisk0. */
const olderHelp = help.replace(' [,ms-cert=<enum>]', '')

const schema = parseQmCreateSchema(help)
const older = parseQmCreateSchema(olderHelp)

describe('parseQmCreateSchema', () => {
    test('collects the inner keys of a wrapped signature', () => {
        expect([...(schema.get('efidisk0') ?? [])].sort()).toEqual([
            'efitype',
            'file',
            'format',
            'import-from',
            'ms-cert',
            'pre-enrolled-keys',
            'size',
        ])
    })

    test('stops at the prose description', () => {
        // "Configure a disk for storing EFI vars. Use the special syntax
        // STORAGE_ID:SIZE_IN_GiB…" follows the signature on the same indent.
        expect(schema.get('efidisk0')?.has('STORAGE_ID')).toBe(false)
        expect(schema.get('agent')?.has('Enable/disable')).toBe(false)
    })

    test('records scalar options with no inner keys', () => {
        expect(schema.get('acpi')).toEqual(new Set())
        expect(schema.get('bios')).toEqual(new Set())
    })

    test('unparseable output is an empty schema, not a set of nothing', () => {
        expect(parseQmCreateSchema('').size).toBe(0)
        expect(parseQmCreateSchema('qm: unknown command').size).toBe(0)
    })
})

describe('supportsOption', () => {
    test('resolves indexed slots through their [n] family', () => {
        expect(supportsOption(schema, 'scsi0')).toBe(true)
        expect(supportsOption(schema, 'serial0')).toBe(true)
        expect(supportsOption(schema, 'efidisk0')).toBe(true)
    })

    test('rejects an option the node does not document', () => {
        expect(supportsOption(schema, 'virtiofs0')).toBe(false)
    })

    test('an unknown schema accepts everything', () => {
        expect(supportsOption(undefined, 'virtiofs0')).toBe(true)
        expect(supportsOption(new Map(), 'virtiofs0')).toBe(true)
    })
})

describe('supportsFormatKey', () => {
    test('separates a key the node has from one it does not', () => {
        expect(supportsFormatKey(schema, 'efidisk0', 'ms-cert')).toBe(true)
        expect(supportsFormatKey(older, 'efidisk0', 'ms-cert')).toBe(false)
        expect(supportsFormatKey(older, 'efidisk0', 'pre-enrolled-keys')).toBe(
            true
        )
    })

    test('reads an indexed slot from its family', () => {
        expect(supportsFormatKey(schema, 'scsi0', 'discard')).toBe(true)
        expect(supportsFormatKey(schema, 'scsi0', 'nonsense')).toBe(false)
    })

    test('keeps everything when the option or schema is unknown', () => {
        expect(supportsFormatKey(schema, 'virtiofs0', 'anything')).toBe(true)
        expect(supportsFormatKey(schema, 'acpi', 'anything')).toBe(true)
        expect(supportsFormatKey(undefined, 'efidisk0', 'ms-cert')).toBe(true)
    })
})
