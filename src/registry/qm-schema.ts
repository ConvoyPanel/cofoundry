/**
 * What `qm create` accepts on the node a template is being installed onto.
 *
 * A published template carries the hardware profile and disk options captured
 * from the machine that built it, and Proxmox keeps adding to that schema:
 * `ms-cert` on `efidisk0` arrived in PVE 9.1. Installing such a template on an
 * older node than the builder fails the whole create:
 *
 *     qm create exited with code 255: 400 Parameter verification failed.
 *     efidisk0: invalid format - format error
 *     efidisk0: ms-cert: property is not defined in schema and the schema
 *     does not allow additional properties
 *
 * Capture is a denylist on purpose (see `Hardware` in schema.ts) so new fields
 * reach consumers, which leaves the compatibility question here: ask the local
 * `qm` what it understands and drop what it does not. That is always the right
 * trade for these keys — every option a template publishes is image metadata
 * or a storage hint, and with `import-from` the imported bytes are what
 * actually define the disk (docs/disk-images.md).
 */

/** Option name -> the keys accepted inside its value, e.g. `scsi[n]` -> `discard`. */
export type QmCreateSchema = Map<string, Set<string>>

/** Verbose usage is the only place `qm` prints each option's inner keys. */
export const QM_HELP_COMMAND = ['qm', 'help', 'create', '--verbose']

/**
 * `  --efidisk0 [file=]<volume> [,efitype=<2m|4m>] [,format=<enum>]` — two
 * spaces and the flag start a block; the signature then wraps onto tab-indented
 * lines, and the prose description follows on the same indent.
 */
const OPTION_LINE = /^ {2}--(\S+)\s*(.*)$/
/** A wrapped signature line always resumes with the next `[,key=…]` group. */
const CONTINUATION = /^\t\s*(\[,.*)$/
/** `[file=]`, `[,efitype=<2m|4m>]` — a key is whatever follows a bracket. */
const FORMAT_KEY = /\[,?([A-Za-z0-9_-]+)=/g

/**
 * Parses `qm help create --verbose`. Unparseable input yields an empty schema,
 * which every consumer treats as "unknown" rather than "supports nothing".
 */
export const parseQmCreateSchema = (help: string): QmCreateSchema => {
    const schema: QmCreateSchema = new Map()
    let option: string | undefined
    let signature = ''

    const flush = (): void => {
        if (!option) return
        const keys = new Set<string>()
        for (const [, key] of signature.matchAll(FORMAT_KEY))
            if (key) keys.add(key)
        schema.set(option, keys)
        option = undefined
        signature = ''
    }

    for (const line of help.split('\n')) {
        const header = OPTION_LINE.exec(line)
        if (header) {
            flush()
            option = header[1]
            signature = header[2] ?? ''
            continue
        }
        const wrapped = option ? CONTINUATION.exec(line) : null
        if (wrapped) signature += ` ${wrapped[1]}`
        else flush()
    }
    flush()

    return schema
}

/**
 * Indexed slots are documented once under a placeholder — `--scsi[n]`,
 * `--net[n]`, `--serial[n]` — while single slots keep their number
 * (`--efidisk0`, `--tpmstate0`). Try the literal name first, then the family.
 */
const entry = (
    schema: QmCreateSchema,
    option: string
): Set<string> | undefined =>
    schema.get(option) ?? schema.get(option.replace(/\d+$/, '[n]'))

/** False only when the schema is known and this option is not in it. */
export const supportsOption = (
    schema: QmCreateSchema | undefined,
    option: string
): boolean => !schema?.size || entry(schema, option) !== undefined

/**
 * False only when the schema is known, lists this option, and lists inner keys
 * that do not include `key`. An option printed with no inner keys is a scalar
 * we cannot reason about, so nothing is dropped from it.
 */
export const supportsFormatKey = (
    schema: QmCreateSchema | undefined,
    option: string,
    key: string
): boolean => {
    const keys = schema?.size ? entry(schema, option) : undefined
    return !keys?.size || keys.has(key)
}
