# Cofoundry

Builds Proxmox VM templates from unattended Linux and Windows Server ISO
installations, then exports importable disk images that
[Coport](docs/coport.md) turns back into clonable templates on a Proxmox node.

Requires Proxmox VE 9 — `qm create --import-from` is what makes an image
installable without an archive.

## Documentation

| Document                             | Description                                                        |
| ------------------------------------ | ------------------------------------------------------------------ |
| [Setup](docs/setup.md)               | First-time setup — Proxmox node, GitHub Actions, R2, local dev     |
| [Usage](docs/usage.md)               | Building, verifying, publishing, cleanup                           |
| [Recipes](docs/recipes.md)           | Supported templates and how to add new ones                        |
| [Windows recipes](docs/windows.md)   | Windows configuration, load-bearing settings, failure reference    |
| [Disk images](docs/disk-images.md)   | The published artifact format and the Proxmox behaviour it needs   |
| [Architecture](docs/architecture.md) | Source layout and implementation boundaries                        |
| [Debugging](docs/debugging.md)       | How to debug a build without burning hours                         |
| [Diagnostics](docs/diagnostics.md)   | How build-failure evidence is recorded and collected               |
| [Coport](docs/coport.md)             | Node-side installer that imports published images                  |

[docs/windows-log.md](docs/windows-log.md) is the dated Windows experiment log —
history rather than reference. `docs/handoffs/` holds point-in-time session
snapshots; see [AGENTS.md](AGENTS.md#documentation-layout) for what goes where.
