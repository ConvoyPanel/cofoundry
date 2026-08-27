import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { execa } from 'execa'

const roots: string[] = []

afterEach(async () => {
    await Promise.all(
        roots.splice(0).map(root => rm(root, { recursive: true, force: true }))
    )
})

// Git Bash on Windows needs POSIX-style paths in env vars and argv; a no-op
// elsewhere.
const bashPath = (p: string) =>
    process.platform === 'win32'
        ? p
              .replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`)
              .replace(/\\/g, '/')
        : p

const NAME = 'windows-server-2025-amd64'
const SYSTEM_CONTENT = 'system-disk-content'
const EFI_CONTENT = 'efi-varstore-content'
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

// A Windows template: two images with DIFFERENT hashes. The single-artifact
// shape could not express this, which is the whole reason this script moved
// from CF_UPLOAD_CMD (once per image) to CF_SIDECAR_UPLOAD_CMD (once per
// template).
const SIDECAR = {
    schema_version: '2',
    name: NAME,
    display: 'Windows Server 2025 Datacenter',
    arch: 'amd64',
    group: 'windows-server',
    suggested_vmid: 2002,
    built_at: '2026-08-04T16:53:31Z',
    disks: [
        {
            slot: 'scsi0',
            role: 'system',
            format: 'qcow2',
            file: `${NAME}-${sha(SYSTEM_CONTENT)}.qcow2`,
            url: '',
            sha256: sha(SYSTEM_CONTENT),
            size: SYSTEM_CONTENT.length,
            virtual_size: '32G',
            options: { discard: 'on' },
        },
        {
            slot: 'efidisk0',
            role: 'efivars',
            format: 'raw',
            file: `${NAME}-${sha(EFI_CONTENT)}.efivars.raw`,
            url: '',
            sha256: sha(EFI_CONTENT),
            size: EFI_CONTENT.length,
            options: {
                'efitype': '4m',
                'pre-enrolled-keys': 1,
                'ms-cert': '2023k',
            },
        },
    ],
    hardware: {
        ostype: 'win11',
        bios: 'ovmf',
        machine: 'q35',
        scsihw: 'virtio-scsi-single',
        cpu: 'host',
        agent: 1,
        net_model: 'virtio',
        tpm: 'v2.0',
    },
    minimum: { cores: 2, memory: 4096 },
}

// Two online nodes (fake TEST-NET-3 IPs so they never match a real local
// interface) plus one offline node without an "ip" field, mirroring the real
// pmxcfs format.
const MEMBERS = `{
"nodename": "pve1",
"version": 3,
"cluster": { "name": "cf", "version": 2, "nodes": 3, "quorate": 1 },
"nodelist": {
  "pve1": { "id": 1, "online": 1, "ip": "203.0.113.11"},
  "pve2": { "id": 2, "online": 1, "ip": "203.0.113.12"},
  "pve3": { "id": 3, "online": 0}
  }
}
`

type Fixture = {
    root: string
    dump: string
    out: string
    sidecar: string
    callsLog: string
    env: Record<string, string>
    args: string[]
}

const setup = async (): Promise<Fixture> => {
    const root = await mkdtemp(join(tmpdir(), 'cofoundry-cluster-'))
    roots.push(root)

    const bin = join(root, 'bin')
    const dump = join(root, 'dump')
    const out = join(root, 'out')
    await Promise.all([mkdir(bin), mkdir(dump), mkdir(out)])

    const sidecar = join(out, `${NAME}.json`)
    const members = join(root, 'members.json')
    const callsLog = join(root, 'calls.log')
    await Promise.all([
        writeFile(sidecar, JSON.stringify(SIDECAR, null, 2)),
        writeFile(join(out, `${NAME}.qcow2`), SYSTEM_CONTENT),
        writeFile(join(out, `${NAME}.efivars.raw`), EFI_CONTENT),
        writeFile(members, MEMBERS),
        writeFile(callsLog, ''),
    ])

    // `ip` prints nothing so no cluster IP is ever treated as local — every
    // node goes through the ssh/scp stubs. python3 is deliberately NOT stubbed:
    // the script renders its qm flags with it, so a stub would test nothing.
    const stubs: Record<string, string> = {
        ip: '#!/usr/bin/env bash\nexit 0\n',
        ssh: `#!/usr/bin/env bash
set -uo pipefail
printf 'ssh %s\\n' "$*" >>"$CALLS_LOG"
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    root@*) shift ;;
    *) args+=("$1"); shift ;;
  esac
done
if [ "\${args[0]:-}" = bash ] && [ "\${args[1]:-}" = -s ]; then
  exec bash -s
fi
exec bash -c "\${args[*]}"
`,
        scp: `#!/usr/bin/env bash
set -euo pipefail
printf 'scp %s\\n' "$*" >>"$CALLS_LOG"
args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    -q) shift ;;
    -o) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
dest="\${args[1]#*:}"
cp -f "\${args[0]}" "$dest"
# Corrupt only the varstore: a template whose SECOND image failed to transfer
# is exactly the case a single-artifact checksum could not catch.
if [ "\${SCP_CORRUPT_EFI:-}" = "1" ] && [[ "\${args[0]}" == *.efivars.raw ]]; then
  printf 'CORRUPT' >>"$dest"
fi
`,
        qm: `#!/usr/bin/env bash
set -uo pipefail
printf 'qm %s\\n' "$*" >>"$CALLS_LOG"
case "\${1:-}" in
  status) if [ "\${QM_HAS_VM:-}" = "1" ]; then exit 0; else exit 1; fi ;;
  config) if [ "\${QM_REAL_VM:-}" = "1" ]; then echo "name: tenant"; else echo "template: 1"; fi ;;
  create) if [ "\${QM_CREATE_FAIL:-}" = "1" ]; then exit 1; fi ;;
esac
exit 0
`,
        pvesh: `#!/usr/bin/env bash
printf 'pvesh %s\\n' "$*" >>"$CALLS_LOG"
echo '[{"storage":"local-lvm","active":1,"shared":0,"type":"lvmthin","avail":100}]'
`,
    }
    await Promise.all(
        Object.entries(stubs).map(async ([name, body]) => {
            await writeFile(join(bin, name), body)
            await chmod(join(bin, name), 0o755)
        })
    )

    return {
        root,
        dump,
        out,
        sidecar,
        callsLog,
        env: {
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            PVE_DUMP_DIR: bashPath(dump),
            CF_MEMBERS_FILE: bashPath(members),
            CF_BUILT_VMID: '4001',
            CALLS_LOG: bashPath(callsLog),
        },
        args: [resolve('scripts/cf-cluster-templates.sh'), bashPath(sidecar)],
    }
}

const calls = async (fx: Fixture) =>
    (await readFile(fx.callsLog, 'utf8')).split('\n').filter(Boolean)

// cf-cluster-templates.sh is Proxmox-node orchestration: it drives ssh, scp,
// qm, and `mapfile < <(...)` process substitution that hang under Git Bash on
// Windows. The script only ever runs on a Linux node, so gate the suite to
// POSIX rather than exercise it under an environment it never targets — the
// same rationale as the python-dependent prefetch tests.
const suite = process.platform === 'win32' ? describe.skip : describe

suite('cf-cluster-templates', () => {
    test('stages every image and creates a template on each online node', async () => {
        const fx = await setup()
        const result = await execa('bash', fx.args, {
            env: fx.env,
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(0)
        expect(result.all).toContain('[ok] template 14001')
        expect(result.all).toContain('[ok] template 24001')
        expect(result.all).toContain('2/2 node(s) ok, 0 failed, 1 offline')
        expect(result.all).toContain('[offline] pve3 (id 3)')

        // Both images travel to both nodes.
        expect((await calls(fx)).filter(c => c.startsWith('scp'))).toHaveLength(
            4
        )

        const creates = (await calls(fx)).filter(c => c.startsWith('qm create'))
        expect(creates).toHaveLength(2)
        expect(creates[0]).toContain('qm create 14001')
        expect(creates[1]).toContain('qm create 24001')

        const templates = (await calls(fx)).filter(c =>
            c.startsWith('qm template')
        )
        expect(templates).toEqual(['qm template 14001', 'qm template 24001'])

        // Success clears the staged images and the node-side temp sidecar.
        expect(await readdir(fx.dump)).toEqual([])
    })

    test('renders the hardware profile into the create command', async () => {
        const fx = await setup()
        await execa('bash', fx.args, { env: fx.env, reject: false })
        const create = (await calls(fx)).find(c => c.startsWith('qm create'))!

        expect(create).toContain('--ostype win11')
        expect(create).toContain('--bios ovmf')
        expect(create).toContain('--scsihw virtio-scsi-single')
        expect(create).toContain('--cpu host')
        expect(create).toContain('--agent 1')
        // Sized from `minimum`, not the build's 4/8192.
        expect(create).toContain('--cores 2')
        expect(create).toContain('--memory 4096')
        // Bare machine type: Proxmox re-pins it per node for Windows guests.
        expect(create).toContain('--machine q35')

        // Both images import from their staged absolute paths, varstore
        // options included.
        expect(create).toContain(`--scsi0 local-lvm:0,import-from=`)
        expect(create).toContain(`${NAME}.qcow2,discard=on`)
        expect(create).toContain(
            `${NAME}.efivars.raw,efitype=4m,pre-enrolled-keys=1,ms-cert=2023k`
        )

        // Allocated fresh, never imported.
        expect(create).toContain('--tpmstate0 local-lvm:0,version=v2.0')
        expect(create).toContain('--ide2 local-lvm:cloudinit')
        expect(create).toContain('--net0 virtio,bridge=vmbr0')
        expect(create).toContain('--boot order=scsi0')
        // net_model/tpm name things to allocate; qm would reject them as flags.
        expect(create).not.toContain('--net_model')
        expect(create).not.toContain('--tpm ')
    })

    test('leaves the existing template alone when any single image is corrupt', async () => {
        const fx = await setup()
        const result = await execa('bash', fx.args, {
            env: { ...fx.env, SCP_CORRUPT_EFI: '1', QM_HAS_VM: '1' },
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(1)
        expect(result.all).toContain('checksum mismatch')
        expect(result.all).toContain('0/2 node(s) ok, 2 failed, 1 offline')

        const log = await calls(fx)
        // A template whose varstore failed to transfer is unbootable — better
        // to skip the node than replace a working template with that.
        expect(log.some(c => c.includes('qm destroy'))).toBe(false)
        expect(log.some(c => c.startsWith('qm create'))).toBe(false)
        // Sources survive untouched.
        expect(
            await readFile(join(fx.out, `${NAME}.efivars.raw`), 'utf8')
        ).toBe(EFI_CONTENT)
    })

    test('keeps the staged images and reports state when the create fails', async () => {
        const fx = await setup()
        const result = await execa('bash', fx.args, {
            env: { ...fx.env, QM_CREATE_FAIL: '1' },
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(1)
        expect(result.all).toContain('0/2 node(s) ok, 2 failed, 1 offline')
        // No prior template existed, so the message must not claim one was
        // destroyed — only that none was created and the images are retained.
        expect(result.all).toContain('no template was created at 14001')
        expect(result.all).toContain('for a manual retry')
        expect((await readdir(fx.dump)).sort()).toEqual(
            [`${NAME}.qcow2`, `${NAME}.efivars.raw`].sort()
        )
    })

    test('warns the node is left without a template when create fails after destroy', async () => {
        const fx = await setup()
        const result = await execa('bash', fx.args, {
            env: { ...fx.env, QM_CREATE_FAIL: '1', QM_HAS_VM: '1' },
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(1)
        expect(result.all).toContain(
            'previous template at 14001 was already destroyed'
        )
        expect(result.all).toContain('now has NO template at 14001')
    })

    test('never clobbers a real VM sitting at the target VMID', async () => {
        const fx = await setup()
        const result = await execa('bash', fx.args, {
            env: { ...fx.env, QM_HAS_VM: '1', QM_REAL_VM: '1' },
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(0)
        expect(result.all).toContain('is a real (non-template) VM')
        const log = await calls(fx)
        expect(log.some(c => c.includes('qm destroy'))).toBe(false)
        expect(log.some(c => c.startsWith('qm create'))).toBe(false)
    })

    test('fails before touching any node when a named image is missing', async () => {
        const fx = await setup()
        await rm(join(fx.out, `${NAME}.efivars.raw`))
        const result = await execa('bash', fx.args, {
            env: fx.env,
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(1)
        expect(result.all).toContain('named by the sidecar is missing')
        expect(await calls(fx)).toEqual([])
    })

    test('rejects a base VMID that would collide with the next node', async () => {
        const fx = await setup()
        const result = await execa('bash', fx.args, {
            env: { ...fx.env, CF_BUILT_VMID: '10001' },
            all: true,
            reject: false,
        })

        expect(result.exitCode).toBe(1)
        expect(result.all).toContain('must be < CF_TEMPLATE_VMID_OFFSET')
    })
})
