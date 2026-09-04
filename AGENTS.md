# Agent Notes

## Development

- Prefer arrow functions in `src/` and `tests/`.
- Put shared helpers in `src/util.ts`; do not duplicate helpers such as
  `shellQuote` inside feature modules.
- Route logging through `src/log.ts`. All log levels write to stderr so stdout
  remains safe for machine-readable output.
- Before committing, run `bun run prettier --write src/ tests/`, `bun test`, and
  `bun run typecheck`.

## Documentation layout

Three kinds of writing live under `docs/`. Keep them apart — mixing them is why
the reference docs became unreadable.

| Kind            | Lives in                            | Shape                                                                         |
| --------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| Reference       | `docs/*.md`                         | Present tense, current truth. No dates, no narrative, no superseded theories. |
| Experiment log  | `docs/windows-log.md`               | Dated entries. Every Windows experiment, including failed ones.               |
| Session handoff | `docs/handoffs/YYYY-MM-DD-topic.md` | Point-in-time snapshot for resuming work. Never linked from the README.       |

- A reference doc states what is true now. When a finding changes that, edit the
  statement — do not append a dated entry recording that you changed it.
- Anything carrying a date, a run number, a PR number, or an `OPEN`/`SOLVED`
  marker belongs in the log or a handoff, never in a reference doc.
- Handoffs are disposable. Delete one once its work has landed; if it taught
  something durable, move that into the reference doc first.

## Debugging a build

- Read `docs/debugging.md` **before** starting a debugging session on a build
  failure. A Windows build costs 1-3h and its provisioners run only at the end,
  so the default loop is one hypothesis per three hours; that document is how to
  avoid paying it.
- Two things there are worth knowing before you need them:
  `qm set <vmid> --protection 1` preserves a failing build VM from packer's
  cleanup, and `pwsh` runs on Linux so `recipes/_shared/windows/*.ps1` can be
  parse-checked in milliseconds instead of a rebuild.
- Anything that fails inside a guest must report through packer's stdout. An
  error telling the reader to inspect a log on a VM that packer deletes seconds
  later is not a diagnostic.

## Recipe changes

- Read `docs/recipes.md` before changing or adding a recipe.
- Before changing a Windows HCL file, answer file, or provisioner, read
  `docs/windows.md`. Record every new Windows experiment in `docs/windows-log.md`,
  including failed attempts.
- Never infer a Proxmox `ostype` from a release name. Look up the enum in the
  Proxmox `qemu-server` schema first; see `docs/windows.md#proxmox-os-type`.
- Keep exported disks as small as the measured installed image permits. Before
  increasing a final disk size, confirm it against
  `qemu-img info --output=json` on the exported image (`actual-size` versus
  `virtual-size`).
- Debian preseed files must be committed with the
  `__PACKER_SSH_PUBLIC_KEY__` placeholder, never an injected real key.
