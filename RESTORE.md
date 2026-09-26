# Restoring a backup to the M18

How to write a backup made with `npm run backup` back to your own Stream Dock M18, over USB.

> [!CAUTION]
> **Your backup is the only way back.** The firmware on current units (for example
> `V3.VSDM18_HXJDF.02.020`) is **not published by the vendor**. You cannot download it anywhere.
> If you overwrite your dock's firmware and lose your backup, **nothing can restore it**.
>
> - Make the backup with `npm run backup -- backups/my-m18.bin --twice` **before** anything else.
> - Keep **at least two copies in different places**: another disk, a USB stick, cloud storage.
> - Check the copies with their md5 (the backup prints it).

> [!NOTE]
> **Status:** tested on one 02.020 unit (2026-09-26): dry run, selftest, and a full rewrite of
> the `os` partition (32 blocks plus `env`/`env_r`), after which the dock started normally.
> The fall-back into upgrade mode after a *failed* os write is read from the bootloader code and
> has not been seen on a dock. Do the [test ladder](#first-time-the-test-ladder) once on yours.

## Quick start

```bash
npm run restore -- backups/my-m18.bin --dry-run   # read the dock, show what would change, write nothing
npm run restore -- backups/my-m18.bin             # restore
```

Quit VSD Craft (tray icon too) and `dockd` first, as for the backup.

| option | |
|---|---|
| `--dry-run` | read the dock and report what differs. Writes nothing |
| `--selftest` | prove erase, write and read on the last 64 KB of flash (unused), then erase it again. Needs no backup file |
| `--only=<regions>` | restore only these regions, e.g. `--only=os` |
| `--rewrite=<regions>` | also rewrite these regions where they already match, e.g. `--rewrite=os` to test the write path |
| `--include-spl` | allow writing the bootloader. See [The bootloader](#the-bootloader-spl) |
| `--yes` | do not ask for confirmation |
| `--snapshot-dir=<dir>` | where to save the dock's contents before writing (default `backups/`) |
| `--upgcmd=<path>` | where `upgcmdHid.exe` is |

Regions: `spl`, `env`, `env_r`, `os`, `rodata`, `data`, `tail` (see the
[flash layout](BACKUP.md#flash-layout)). The default is all of them except `spl`.

## What it does

1. **Checks the backup** before touching the dock: 16 MB, `AIC ` boot header, not mirrored, and
   the os CRC32 and MD5 must match. A damaged file is refused.
2. **Enters upgrade mode** and initialises the flash, exactly like the backup.
3. **Reads the whole dock** and compares it with the backup, per 64 KB block. It refuses if the
   bootloader on the dock differs from the one in the backup: that usually means the backup is
   from another unit.
4. **Saves what is on the dock now** to `backups/dock-before-restore-<date>-<time>.bin` in
   this repository, so the restore itself can be undone. The `backups/` folder is git-ignored,
   and restore never writes anywhere else (use `--snapshot-dir` to choose another folder).
   Snapshots are never overwritten; delete old ones yourself.
5. **Asks for confirmation** (type `restore`).
6. **Writes only the blocks that differ.** Per block: copy it to the dock's RAM (`upgcmdHid
   write`), `spinor erase`, `spinor write`, then read it back and compare. A mismatch is
   retried once, then the tool stops.
7. **Reads the whole flash again** and checks every restored region against the backup.
8. **Resets** the dock and checks that it comes back in normal mode.

Two backups of the same unit usually differ in one byte of `env` or `env_r` (a save counter,
see [BACKUP.md](BACKUP.md#verification)), and `data` changes in normal use. So a restore of an
untouched dock typically writes a few blocks there. That is expected.

## If something goes wrong

**Leave the dock plugged in and run the same command again.** Restore is safe to repeat: it
only writes what still differs.

**If the dock does not start after a failed restore:** unplug and replug it. With a damaged
`os`, the bootloader cannot start the firmware and **falls into the same USB upgrade mode by
itself** (it shows up as `33C3:8899`). That is the mode restore uses, so just run the restore
again.

This comes from the bootloader code on a 02.020 unit (tinySPL, built Jul 2026): after the
firmware CRC check fails, `nor_boot` returns and the bootloader runs `aicupg hid usb 0`, the same
path as a software request for upgrade mode. It has not been seen happen on a real dock yet.

**Every command fails, "reported an error", or it hangs:** the upgrade session has hung. Unplug,
wait a few seconds, replug, and run the command again.

## The bootloader (spl)

Restore never writes the `spl` region unless you pass `--include-spl`. The bootloader is what
provides the USB upgrade mode. If it is damaged, the only way back is the chip's boot ROM USB mode,
and **recovery through the boot ROM has not been worked out or tested**. There is no reason to
write it when restoring your own backup to your own unit, because it never changes.

## First time: the test ladder

Each step is only worth doing if the previous one passed.

1. **Backup, twice, and store it safely.** `npm run backup -- backups/my-m18.bin --twice`, then copy
   the file to two other places and compare the md5.
2. **Dry run.** `npm run restore -- backups/my-m18.bin --dry-run`. Nothing is written. Expected: `spl`
   same, a few blocks in `env`/`env_r`/`data` at most.
3. **Selftest.** `npm run restore -- --selftest`. It writes a test pattern to the last 64 KB
   of flash, which is outside every partition and erased, reads it back, and erases it again.
   This proves the whole write path without touching anything the dock uses.
4. **Real restore of the firmware, with identical data.**
   `npm run restore -- backups/my-m18.bin --rewrite=os`. This erases and rewrites the full `os`
   partition with the same bytes. If it fails halfway, the bootloader drops into upgrade mode
   and you run it again. Afterwards the dock must start and work normally.
5. Only then: flash anything modified (see [DESIGN.md](DESIGN.md)).

## Safety

Every `upgcmdHid` call goes through one allow list:

| allowed | limits |
|---|---|
| `-l`, `lspart`, `log`, `read`, `readl` | read-only |
| `fill` | RAM only, inside the 256 KB scratch window at `0x40100000` |
| `write` | RAM only, to the start of that window |
| `shcmd "spinor init <n>"`, `shcmd "reset"` | |
| `shcmd "spinor read ..."` | into the scratch window |
| `shcmd "spinor erase <off> 0x10000"` | one 64 KB block, inside the regions being restored |
| `shcmd "spinor write <ram> <off> 0x10000"` | from the scratch window, one 64 KB block, inside the regions being restored |

`image`, `dump`, `erase`, efuse, jtag and everything else are refused. `spl` is outside the
allowed regions unless `--include-spl` is given.
