"""Check that every partition on a disk image ends inside a target size.

Usage: partition-end.py <raw-head-of-disk> <target-size>

<raw-head-of-disk> is the first MiB of the disk as raw bytes (shrink-disk.sh
extracts it with `qemu-img dd`). <target-size> uses qemu-img's suffixes: K, M,
G and T are powers of 1024, and a bare number is bytes.

Exits 0 when the last partition fits, 1 when it does not, and 2 when the head
holds no partition table this understands. Shrinking a qcow2 below its last
partition silently cuts the filesystem off, so anything but a clear "fits" must
stop the shrink.
"""

import struct
import sys

SECTOR = 512
# The backup GPT is a header plus 32 sectors of entries at the very end of the
# disk. A partition may end no later than the sector before them.
GPT_BACKUP_SECTORS = 33


def parse_size(text: str) -> int:
    units = {"K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}
    text = text.strip().upper().removesuffix("B")
    if text and text[-1] in units:
        return int(float(text[:-1]) * units[text[-1]])
    return int(text)


def gpt_last_sector(head: bytes) -> int:
    header = head[SECTOR : 2 * SECTOR]
    entries_lba, count, size = struct.unpack_from("<QII", header, 72)
    last = 0
    for i in range(count):
        start = entries_lba * SECTOR + i * size
        entry = head[start : start + size]
        if len(entry) < 48:
            raise ValueError("partition entries extend past the bytes read")
        if entry[:16] == bytes(16):
            continue
        _first, end = struct.unpack_from("<QQ", entry, 32)
        last = max(last, end)
    return last


def mbr_last_sector(head: bytes) -> int:
    last = 0
    for i in range(4):
        entry = head[446 + 16 * i : 446 + 16 * (i + 1)]
        kind = entry[4]
        start, count = struct.unpack_from("<II", entry, 8)
        if kind == 0 or count == 0:
            continue
        # An extended partition's own extent covers its logical partitions.
        last = max(last, start + count - 1)
    return last


def main() -> int:
    head = open(sys.argv[1], "rb").read()
    target = parse_size(sys.argv[2])
    sectors = target // SECTOR

    if head[SECTOR : SECTOR + 8] == b"EFI PART":
        table, last = "gpt", gpt_last_sector(head)
        limit = sectors - GPT_BACKUP_SECTORS - 1
    elif head[510:512] == b"\x55\xaa":
        table, last = "mbr", mbr_last_sector(head)
        limit = sectors - 1
    else:
        print("no GPT or MBR partition table in the image head")
        return 2

    print(f"{table}: last partition ends at sector {last}; {sys.argv[2]} allows {limit}")
    return 0 if last <= limit else 1


if __name__ == "__main__":
    sys.exit(main())
