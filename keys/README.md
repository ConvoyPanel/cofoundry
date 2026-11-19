# ISO signing keys

`cf update` pins a recipe's ISO only from a checksum file signed by one of these
keys, and the build checks the downloaded ISO against that pin. A recipe names
its key with `# iso_signing_key:` and its signature with `# iso_checksum_sig:`
(a file name next to the checksum file, or `clearsigned`).

These files are trust anchors. Replace one only after checking the new
fingerprint against the vendor's own HTTPS page, and update the expected
fingerprint in `tests/iso.test.ts` in the same change.

| File                 | Fingerprint                                         | Signs                    | Source                                                   |
| -------------------- | --------------------------------------------------- | ------------------------ | -------------------------------------------------------- |
| `debian-cd.asc`      | `DF9B 9C49 EAA9 2984 3258 9D76 DA87 E80D 6294 BE9B` | `SHA256SUMS` (`.sign`)   | https://www.debian.org/CD/verify                         |
| `ubuntu-cdimage.asc` | `8439 38DF 228D 22F7 B374 2BC0 D94A A3F0 EFE2 1092` | `SHA256SUMS` (`.gpg`)    | https://ubuntu.com/tutorials/how-to-verify-ubuntu        |
| `almalinux-8.asc`    | `BC5E DDCA DF50 2C07 7F15 8288 2AE8 1E8A CED7 258B` | `CHECKSUM` (clearsigned) | https://almalinux.org/security/                          |
| `almalinux-9.asc`    | `BF18 AC28 7617 8908 D6E7 1267 D36C B86C B86B 3716` | `CHECKSUM` (clearsigned) | https://almalinux.org/security/                          |
| `almalinux-10.asc`   | `EE6D B7B9 8F5B F5ED D9DA 0DE5 DEE5 C11C C2A1 E572` | `CHECKSUM` (clearsigned) | https://almalinux.org/security/                          |
| `rocky-linux-8.asc`  | `7051 C470 A929 F454 CEBE 37B7 15AF 5DAC 6D74 5A60` | `CHECKSUM` (`.asc`)      | https://dl.rockylinux.org/pub/rocky/RPM-GPG-KEY-Rocky-8  |
| `rocky-linux-9.asc`  | `21CB 256A E16F C54C 6E65 2949 702D 426D 350D 275D` | `CHECKSUM` (`.asc`)      | https://dl.rockylinux.org/pub/rocky/RPM-GPG-KEY-Rocky-9  |
| `rocky-linux-10.asc` | `FC22 6859 C086 0BF0 DDB9 5B08 5B10 6C73 6FED FC85` | `CHECKSUM` (`.asc`)      | https://dl.rockylinux.org/pub/rocky/RPM-GPG-KEY-Rocky-10 |

AlmaLinux 8 checksums are signed by the 2023 key above. The
`RPM-GPG-KEY-AlmaLinux-8` file on repo.almalinux.org still holds the expired
2021 key, so this one comes from keyserver.ubuntu.com, checked against the
fingerprint almalinux.org publishes.
