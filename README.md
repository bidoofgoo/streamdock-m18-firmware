# streamdock-m18-firmware

Firmware patches for the **Mirabox / VSDinside Stream Dock M18**. The first goal is
**multi-key rollover**: pressing several keys at once and having every press and release
reported over USB, so the dock can play chords.

> **Status: work in progress. There is nothing to flash yet.**

## Why

The stock firmware reports one key at a time. While any key is held, every other key is
invisible, and presses in that window are lost rather than queued. That is fine for a macro pad
and useless for music. It is a firmware limitation, not a hardware one: the key scan waits on the
first pressed key until it is released. See §7 of the protocol reference in
[streamdock-m18](https://github.com/bidoofgoo/streamdock-m18/blob/main/PROTOCOL.md).

## How it will work

This repository will **not** contain or distribute vendor firmware. It will contain a **patch
script** that you apply to a backup of **your own** dock:

1. Back up your dock's flash with
   [`npm run firmware-backup`](https://github.com/bidoofgoo/streamdock-m18/blob/main/FIRMWARE-BACKUP.md)
   from streamdock-m18. Keep that file safe: it is your way back.
2. Run the patch script on the backup. It checks that it recognises your firmware version
   exactly, and refuses anything else.
3. Flash the patched image back.

The patch keeps the existing key report format and only changes *when* reports are sent: one
down or up event per key that changes, for any number of keys. Hosts that already speak the M18
protocol, including the streamdock-m18 driver and `dockd`, then get chords with no changes on
their side.

See [DESIGN.md](DESIGN.md) for the details and the open questions.

## Hardware facts this relies on

- SoC: **ArtInChip D13x** (RISC-V), firmware built on ArtInChip's Luban-Lite SDK.
- Flash: 16 MB SPI NOR. The firmware is a FIT image in the `os` partition, protected by CRC32
  and MD5 only.
- The bootloader reports **no secure boot, no encrypted boot, no anti-rollback**, so a patched
  image is accepted.
- The vendor's own upgrade path works over USB. No programmer or soldering is needed.

## Safety and legal

- **Flashing firmware can leave your dock unusable** until you restore a backup. Don't start
  without a verified backup.
- **You patch your own copy.** Vendor firmware is not included here and must not be committed
  (`*.bin` and `*.img` are git-ignored). Don't share patched images either.
- The patch is written against specific firmware builds. It is published for interoperability,
  so the dock can be used with other software. That is the purpose EU law protects for reverse
  engineering. Check your own jurisdiction.

## Related

- [streamdock-m18](https://github.com/bidoofgoo/streamdock-m18): the USB HID protocol
  reference, the Node driver, `dockd`, and the firmware backup tool.

## Licence

MIT, for the code in this repository. The firmware it patches remains the vendor's.
