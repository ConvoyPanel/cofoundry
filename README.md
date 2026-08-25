# Cofoundry

Builds Proxmox VM templates from unattended Linux and Windows Server ISO
installations, then exports `.vma.zst` artifacts that [Coport](docs/coport.md)
restores into clonable templates on a Proxmox node.

## Documentation

| Document                             | Description                                                             |
| ------------------------------------ | ----------------------------------------------------------------------- |
| [Setup](docs/setup.md)               | First-time setup — local dependencies, Proxmox node config, `.env`      |
| [Usage](docs/usage.md)               | Building templates, checking for updates, publishing, cleanup           |
| [Recipes](docs/recipes.md)           | Supported templates and how to add new ones                             |
| [Windows recipes](docs/windows.md)   | Windows configuration and troubleshooting                               |
| [Architecture](docs/architecture.md) | Source layout and implementation boundaries                             |
| [Disk images](docs/disk-images.md)   | Planned replacement of `.vma.zst` templates with importable disk images |
| [Diagnostics](docs/diagnostics.md)   | How build-failure evidence is recorded and collected                    |
| [Coport](docs/coport.md)             | Node-side installer that restores published templates via `qmrestore`   |
