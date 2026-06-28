import type { Template } from '@/registry/schema.ts'

// One thing to install: a template restored into a VMID on a storage volume.
export interface InstallItem {
    template: Template
    vmid: number
    storage: string
    overwrite: boolean
}
