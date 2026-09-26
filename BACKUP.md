# Backing up the M18 firmware

How to read the complete flash of your own Stream Dock M18 to a file, over USB, with no extra
hardware. You end up with a verified 16 MB image of exactly what your unit shipped with.

> [!CAUTION]
> **Keep this backup safe, in at least two places.** The firmware on current units cannot be
> downloaded anywhere. If your dock's firmware is ever overwritten and this file is lost, there
> is no way to get it back.

**Why bother:** newer units run firmware that the vendor does not publish. VSD Craft only offers
older versions, so a firmware update or any experiment would leave you with no way back. A
backup is that way back, and it is the starting point if you want to study or modify the
firmware.

**What this repository does not contain:** firmware, firmware dumps, or any vendor software. The
backup uses the ArtInChip upgrade tool that is already inside your own VSD Craft install. Don't
share your dump either: it is the vendor's code.

## Before you start

> [!WARNING]
> This puts your dock into its bootloader's upgrade mode. That mode exists to erase and rewrite
> the flash. The procedure here only reads, and the script refuses every write command (see
> [Safety](#safety)), but you are using a factory tool on your own device at your own risk. It
> may affect your warranty.
> VSD Craft's licence terms may forbid reverse engineering. Whether that holds depends on where
> you live. In the EU, interoperability is a protected exception.

You need:

- Windows, with **VSD Craft** installed. The script uses
  `C:\Program Files (x86)\VSD Craft\UpDateToolV3\upgcmdHid.exe`.
- This repository, with `npm install` done.
- The dock plugged in, and nothing else holding it: **quit VSD Craft** (including its tray icon),
  and `dockd` if you use [streamdock-m18](https://github.com/bidoofgoo/streamdock-m18).

## Quick start

```bash
npm run backup -- backups/my-m18.bin --twice
```

Takes about 40 seconds with `--twice`. Output from a successful run:

```
upgrade mode after 1s
pass 1: 16.00 / 16 MB (20s)
pass 2: 16.00 / 16 MB (19s)
pass 1 and pass 2 are identical
wrote ...\backups\my-m18.bin
md5 <32 hex digits>
verifying:
  os seg0: 0xa8fe8 bytes, crc32 ok, md5 ok
  firmware version V3.VSDM18_HXJDF.02.020
dock back to normal after 3s

Backup looks good. Keep a copy somewhere safe, and do not share it.
```

| option | |
|---|---|
| `--twice` | read the whole flash twice and require identical results. Recommended |
| `--upgcmd=<path>` | where `upgcmdHid.exe` is, if VSD Craft is installed elsewhere |
| `--keep-upgrade` | leave the dock in upgrade mode afterwards (replug it to get out) |

The script refuses to overwrite an existing file.

## What it does

The dock contains an **ArtInChip D13x** SoC (RISC-V) running ArtInChip's Luban-Lite SDK.
Firmware updates go through the chip's standard upgrade mode. The script uses that path, but
stops at reading.

1. **Enter upgrade mode.** It sends the vendor command `CRT\0\0APPNEW` (the same framing as every
   other command in the
   [protocol reference](https://github.com/bidoofgoo/streamdock-m18/blob/main/PROTOCOL.md)).
   The firmware sets a reboot reason and resets.
   The bootloader sees the reason and stays in HID upgrade mode, and the dock re-enumerates as
   `33C3:8899`. This is the step VSD Craft's updater performs before flashing.
2. **Initialise the flash.** It runs `spinor init 0` in the bootloader's shell through
   `upgcmdHid shcmd`, then confirms "probe spinor flash success" in the device log.
3. **Copy 256 KB at a time.** It runs `spinor read` to copy a block of flash into the chip's RAM,
   then `upgcmdHid read` to fetch that RAM to the PC. 64 rounds cover the full 16 MB.
4. **Reset.** It runs `shcmd reset`. A normal reset boots the regular firmware, and the dock is
   back in about 3 seconds.

`upgcmdHid` has a `dump` command meant for exactly this, but on the bootloader in current units
it hangs (see [Troubleshooting](#troubleshooting)). Hence the RAM detour.

## Verification

The script checks what the image can vouch for itself:

- The **OS partition is a FIT image with an embedded CRC32 and MD5** per code segment. Both must
  match, which proves the firmware was read without errors.
- The bootloader starts with the `AIC ` boot header.
- The first megabyte does not repeat at 8 MB, which rules out a smaller chip mirrored.
- With `--twice`, both passes are byte-identical.
- Every 256 KB block is checked against a RAM sentinel. The bootloader shell does not report
  failures, so without this a failed read would silently repeat the previous block. The script
  fills the RAM with `0xA5` before each read and aborts if the pattern is still there.

It also prints the firmware version string it finds.

**Two backups taken at different times can differ by one byte**, at `0x80004` or `0xa0004`.
Those are the save counters of the environment block and its redundant copy (`env` / `env_r`).
The dock saves to them alternately by itself during normal use. The settings themselves stay the
same. Everything else should be identical.

## Flash layout

16 MB SPI NOR, as reported by `upgcmdHid lspart spi-nor`:

| partition | offset | size | contents |
|---|---|---|---|
| `spl` | `0x000000` | 512 KB | bootloader |
| `env` | `0x080000` | 128 KB | environment (settings), redundant pair with `env_r` |
| `env_r` | `0x0a0000` | 128 KB | environment copy |
| `os` | `0x0c0000` | 2 MB | the firmware, a FIT image |
| `rodata` | `0x2c0000` | 10 MB | UI assets |
| `data` | `0xcc0000` | 1 MB | writable storage |
| | `0xdc0000` | 2.25 MB | unpartitioned, erased (`0xFF`) |

The bootloader reports no secure boot, no encrypted boot and no anti-rollback (`upgcmdHid -l`).

## Troubleshooting

**Every `upgcmdHid` command fails, or the script says a command "reported an error":** the
bootloader's USB session has hung. This happens after any failed command. **Unplug the dock,
wait a few seconds, plug it back in.** A cold start clears the reboot reason, and the dock boots
its normal firmware.

**The dock stays in upgrade mode** (it shows up as `33C3:8899` instead of `5548:1000`): same
fix, unplug and replug.

**Known ways to hang the session** (all harmless, just replug):

- `upgcmdHid dump spi-nor <partition> <file>`: the device never answers the read-start.
- `upgcmdHid lspart` with a wrong media name. Only `spi-nor` works.
- `upgcmdHid lsmedia` fails outright ("no available storage media devices").

**"spinor init did not probe the flash":** your unit may wire the flash to a different SPI bus.
The script only tries bus 0. Please open an issue with the device log it prints.

## Safety

`upgcmdHid` can erase and write flash, efuses and more. The script sends every call through a
single allow list and refuses anything else:

| allowed | why |
|---|---|
| `-l`, `lspart`, `log`, `read`, `readl` | read-only queries |
| `fill` | RAM only, and only inside the 256 KB scratch window at `0x40100000` |
| `shcmd "spinor init <n>"` | probes the flash chip |
| `shcmd "spinor read <ram> <offset> <size>"` | copies flash **to** RAM |
| `shcmd "reset"` | reboots |

Everything else, including `image`, `write`, `spinor erase`, `spinor write`, efuse and jtag
commands, is refused before it reaches the device.

Restoring a backup needs those write commands. That is a separate tool with its own, bounded
allow list: see [RESTORE.md](RESTORE.md).

## Tested on

| | |
|---|---|
| firmware | `V3.VSDM18_HXJDF.02.020` (bootloader: tinySPL, built Jul 2026) |
| VSD Craft | 3.10.205 |
| `upgcmdHid` | V1.4.5 (Dec 2024) |

Other M18 variants (`VSD_M18`, `M18E`, `M18V3_C`) use the same SoC and the same updater path, so
this should work there too. Reports welcome.

## Related

- [DESIGN.md](DESIGN.md): the firmware patches this repository builds on top of such a backup,
  starting with multi-key rollover.
- [streamdock-m18](https://github.com/bidoofgoo/streamdock-m18): the USB HID protocol reference
  (including `APPNEW`) and the Node driver.
