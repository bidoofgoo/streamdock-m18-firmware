# streamdock-m18-firmware

Firmware backup and patches for the **Mirabox / VSDinside Stream Dock M18**. The first patch
goal is **multi-key rollover**: pressing several keys at once and having every press and release
reported over USB, so the dock can play chords.

> [!CAUTION]
> ## ⚠️ Your backup is irreplaceable ⚠️
>
> The firmware on current units is **not published by the vendor. You cannot download it.**
> This repository can make a backup of your dock, and restore it. But **if you overwrite your
> dock's firmware and that backup is gone, it is gone: nothing can restore your dock.**
>
> **Make the backup first. Keep at least two copies, in different places. Check their md5.**

> **Status:** the [firmware backup](BACKUP.md) works and is verified. The
> [restore tool](RESTORE.md) works: tested with a full rewrite of the firmware partition. The
> rollover patch works on a 02.020 unit (flashed 2026-09-26): up to 11 keys at once, every
> press and release reported. Two keys in one column have a small hardware limit, see
> [PATCH.md](PATCH.md).

## Back up your dock first

```bash
npm install
npm run backup -- backups/my-m18.bin --twice
```

This reads the dock's complete 16 MB flash over USB, read-only, with the vendor's own upgrade tool
from VSD Craft. It needs Windows and about 40 seconds. **Read [BACKUP.md](BACKUP.md) first.** It is
worth doing even if you never patch anything: newer units ship firmware the vendor does not
publish.

## Restore a backup

```bash
npm run restore -- backups/my-m18.bin --dry-run   # shows what would change, writes nothing
npm run restore -- backups/my-m18.bin
```

Writes your backup back, only where the dock differs, with every block read back and checked.
It saves what was on the dock before writing, and never touches the bootloader unless asked.
**Read [RESTORE.md](RESTORE.md) first**, and do its test ladder once before you rely on it.

## Why

The stock firmware reports one key at a time. While any key is held, every other key is
invisible, and presses in that window are lost rather than queued. That is fine for a macro pad
and useless for music. That part is a firmware limitation, not a hardware one: the key scan
waits on the first pressed key until it is released. (The key matrix has no diodes, which
brings one smaller hardware limit for keys in the same column; see [PATCH.md](PATCH.md).) See §7 of the protocol reference in
[streamdock-m18](https://github.com/bidoofgoo/streamdock-m18/blob/main/PROTOCOL.md).

## How it works

This repository does **not** contain or distribute vendor firmware. It contains a **patch
script** that you apply to a backup of **your own** dock:

1. Back up your dock's flash with `npm run backup` (above). **Keep that file safe: it is your
   only way back.**
2. Prove that restoring works on your dock ([RESTORE.md](RESTORE.md#first-time-the-test-ladder)).
3. Run `npm run patch -- backups/my-m18.bin backups/my-m18-rollover.bin`. It checks that it
   recognises your firmware build exactly, and refuses anything else.
4. Flash it: `npm run restore -- backups/my-m18-rollover.bin --only=os`, then try it with
   `npm run keytest`.

**Step by step, with safe mode and how to go back: [PATCH.md](PATCH.md).**

The patch keeps the existing key report format and only changes *when* reports are sent: one
down or up event per key that changes, for several keys at once (with the column limit in
[PATCH.md](PATCH.md)). Hosts that already speak the M18
protocol, including the streamdock-m18 driver and `dockd`, then get chords with no changes on
their side.

See [DESIGN.md](DESIGN.md) for the details.

## Hardware facts this relies on

- SoC: **ArtInChip D13x** (RISC-V), firmware built on ArtInChip's Luban-Lite SDK.
- Flash: 16 MB SPI NOR. The firmware is a FIT image in the `os` partition, protected by CRC32
  and MD5 only.
- The bootloader reports **no secure boot, no encrypted boot, no anti-rollback**, so a patched
  image is accepted.
- The vendor's own upgrade path works over USB. No programmer or soldering is needed.

## Safety and legal

- **Flashing firmware can leave your dock unusable** until you restore a backup. Don't start
  without a verified backup, stored in more than one place. **Without it, there is no way back.**
- **You patch your own copy.** Vendor firmware is not included here and must not be committed
  (`*.bin` and `*.img` are git-ignored). Don't share patched images either.
- The patch is written against specific firmware builds. It is published for interoperability,
  so the dock can be used with other software. That is the purpose EU law protects for reverse
  engineering. Check your own jurisdiction.

## Related

- [streamdock-m18](https://github.com/bidoofgoo/streamdock-m18): the USB HID protocol
  reference, the Node driver and `dockd`.

## Licence

MIT, for the code in this repository. The firmware it patches remains the vendor's.
