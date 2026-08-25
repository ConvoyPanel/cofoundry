import { describe, expect, test } from 'bun:test'
import {
    localArtifactName,
    recipeNameFromSidecar,
    renderUploadTemplate,
    uploadVariables,
} from '@/upload/template.ts'
import type { DiskImage } from '@/registry/schema.ts'
import type { Sidecar } from '@/upload/model.ts'

const system = {
    slot: 'scsi0',
    role: 'system',
    format: 'qcow2',
    file: 'windows-server-2025-amd64-abc123.qcow2',
    sha256: 'abc123',
    size: 1,
} as DiskImage

const efivars = {
    slot: 'efidisk0',
    role: 'efivars',
    format: 'raw',
    file: 'windows-server-2025-amd64-def456.efivars.raw',
    sha256: 'def456',
    size: 540672,
} as DiskImage

const sidecar = {
    name: 'windows-server-2025-amd64',
    arch: 'amd64',
    group: 'windows-server',
    disks: [system, efivars],
} as Sidecar

describe('upload templates', () => {
    test('derives the bare recipe name and compatibility aliases', () => {
        expect(recipeNameFromSidecar(sidecar)).toBe('windows-server-2025')
        expect(uploadVariables(sidecar, system, '/tmp/artifact')).toMatchObject(
            {
                file: '/tmp/artifact',
                recipe: 'windows-server-2025',
                name: 'windows-server-2025',
                arch: 'amd64',
                group: 'windows-server',
            }
        )
    })

    test('renders sha256 and filename per disk, not per template', () => {
        // A template ships several images with different hashes. Rendering the
        // template's placeholders once would publish the varstore under the
        // system disk's name and hash.
        expect(uploadVariables(sidecar, system, '/tmp/a')).toMatchObject({
            sha256: 'abc123',
            filename: 'windows-server-2025-amd64-abc123.qcow2',
        })
        expect(uploadVariables(sidecar, efivars, '/tmp/b')).toMatchObject({
            sha256: 'def456',
            filename: 'windows-server-2025-amd64-def456.efivars.raw',
        })
    })

    test('maps a published name back to the file in the output dir', () => {
        // The exporter writes <template><ext> locally but publishes
        // <template>-<sha256><ext>.
        expect(localArtifactName(sidecar, system)).toBe(
            'windows-server-2025-amd64.qcow2'
        )
        expect(localArtifactName(sidecar, efivars)).toBe(
            'windows-server-2025-amd64.efivars.raw'
        )
    })

    test('replaces repeated placeholders', () => {
        expect(
            renderUploadTemplate('{{recipe}}/{{recipe}}', {
                recipe: 'debian-12',
            })
        ).toBe('debian-12/debian-12')
    })
})
