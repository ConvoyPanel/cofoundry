import type { Env } from '@/env.ts'
import type { RecipeInfo } from '@/config.ts'
import { captureRemote } from '@/build/remote.ts'
import { shellQuote } from '@/util.ts'

/**
 * Proxmox storage types whose volumes are regular files on a mounted path,
 * i.e. `pvesm path <volid>` yields a local file `test -f` accepts. Only these
 * can hold the file-backed qcow2 that the disk-shrink post-processor
 * (recipes/_shared/post/shrink-disk.sh) resizes with `qemu-img resize --shrink`.
 * Block/dataset backends (zfspool, lvmthin, rbd, ...) make that script refuse —
 * hours into the build, inside export-and-cleanup.sh's `set -e` — so they must
 * be rejected before Packer ever starts.
 *
 * `glusterfs` is deliberately absent: although the volume is qcow2 on a FUSE
 * mount, GlusterfsPlugin::path() returns a `gluster://server/volume/...` URI
 * for VM images, so the shrink script's `test -f "$path"` guard would still
 * refuse it at post-processor time.
 */
export const FILE_BACKED_STORAGE_TYPES: ReadonlySet<string> = new Set([
    'dir',
    'nfs',
    'cifs',
    'btrfs',
])

// `pvesm status --storage X` prints a header row plus one row per storage
// (`Name Type Status ...`). Match the name column explicitly instead of
// assuming row order so unrelated output can never be misread as a type. A
// nonexistent storage yields empty stdout (awk terminates the pipe cleanly),
// which the caller reports as "could not determine".
export const storageTypeCommand = (storage: string): string =>
    `pvesm status --storage ${shellQuote(storage)} 2>/dev/null | ` +
    `awk -v s=${shellQuote(storage)} 'NR > 1 && $1 == s { print $2; exit }'`

/**
 * Fail fast when a recipe requests a post-build disk shrink (final_disk_size)
 * but CF_STORAGE cannot hold file-backed qcow2 images. Shrinking on ZFS/LVM
 * volumes is not implemented; without this preflight the refusal only surfaces
 * in the vzdump post-processor after the full install.
 */
export const assertShrinkStorageSupported = async (
    env: Env,
    recipes: RecipeInfo[],
    exec: typeof captureRemote = captureRemote
): Promise<void> => {
    const shrinking = recipes.filter(recipe => recipe.finalDiskSize)
    if (shrinking.length === 0) return

    const storage = env.CF_STORAGE
    const names = shrinking.map(recipe => recipe.name).join(', ')
    const type = (
        await exec(env.SSH_TARGET, storageTypeCommand(storage))
    ).trim()
    if (!type) {
        throw new Error(
            `${names}: final_disk_size needs a disk shrink, but storage "${storage}" ` +
                `was not reported by \`pvesm status\` on the node — check CF_STORAGE`
        )
    }
    if (FILE_BACKED_STORAGE_TYPES.has(type)) return
    throw new Error(
        `${names}: final_disk_size requires file-backed qcow2 disks, but storage ` +
            `"${storage}" has type "${type}" — the post-build shrink ` +
            `(recipes/_shared/post/shrink-disk.sh) only supports dir-style storage. ` +
            `Point CF_STORAGE at a dir-backed storage or remove final_disk_size from the recipe.`
    )
}
