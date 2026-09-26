# Design: multi-key rollover patch

Working design for the first patch. It describes behaviour and approach. It deliberately reproduces
no vendor code.

## What the stock firmware does

From the key scan in the public `V3.VSDM18.02.015` image, confirmed in `V3.VSDM18_HXJDF.02.020`
(read from our own unit's backup):

- A dedicated RTOS thread (`keyboard scan`, RT-Thread) runs the scan every 30 ms.
- The 15 display keys are a **3 x 5 matrix**: three row pins driven low one at a time, five
  column pins read back (active low).
- For each row: read the columns. If a key is down, **block in a 10 ms loop until it is
  released**, emit the event, then move on. Nothing else is scanned while blocked.
- The column read maps the 5-bit pattern through a lookup table that only recognises one low
  column per row. 02.020 adds a 10 ms re-read before decoding.
- The three plain buttons are **separate GPIOs** (active low), not part of the matrix, read by
  their own routine that blocks in the same way.
- Blocking and reporting only happen in the normal mode (device awake and connected). The other
  modes use a key press to wake or sleep the device and are left alone by the patch.
- The report is sent asynchronously (DMA from the caller's buffer; the send returns "busy" while
  the endpoint is still transferring). Back-to-back reports need a second buffer or must wait.

Key ids, as the stock firmware reports them:

| row / column | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|
| top | 1 | 2 | 3 | 4 | 5 |
| middle | 6 | 7 | 8 | 9 | 10 |
| bottom | 11 | 12 | 13 | 14 | 15 |

This matches the event numbering measured on hardware (PROTOCOL.md §7 in streamdock-m18); the firmware's row pins run bottom to top in scan order. The three plain
buttons report `0x25`, `0x30` and `0x31`.

## What the patch should do

Replace the scan body with a non-blocking one:

```
every scan tick:
    state = 0
    for each row:
        drive row low, settle, read 5 columns, release row
        state |= columns << (row * 5)
    add the 3 plain buttons
    changed = state ^ previous
    for each set bit in changed:
        emit a key report (same format as today) with that key's id and down/up
    previous = state
```

- **Same report format** as the stock firmware (`ACK\0\0OK\0` header, key id, state; see
  PROTOCOL.md §7). Hosts need no change.
- **One report per change**, sent in the same tick. The host's input queue handles bursts
  already, since it did for rapid tapping.
- **Debounce:** the stock blocking loop masked bounce. Without it, require a key to read the same
  in two consecutive ticks before reporting a change, or keep a per-key counter.
- **Key ids:** reuse the firmware's own row/column to key id mapping, so the ids stay exactly as
  documented.

## Open questions

1. **Diodes.** Is there a diode per key? Without them, three keys forming a rectangle make a
   fourth appear (ghosting). Needs a look at the PCB. If there are none, the patch should detect
   ghost patterns and suppress them, rather than report phantom keys.
2. ~~**02.020 layout.**~~ Done: same design as 02.015 at shifted addresses.
3. **Space.** Does the new scan fit in place of the old one, or does it need a code cave or an
   appended segment? The FIT image has room: the `os` partition is 2 MB and the image is
   about 680 KB.
4. **Checksums.** After patching, recompute the FIT segment's CRC32 and MD5. The bootloader
   checks them. `tools/fit.js` does this; an unchanged segment repacks byte-identically.
5. **Flashing and restoring.** Establish and test the write path on a known-good image (the
   unmodified backup) before flashing anything patched. The vendor's `upgcmdHid image` takes an
   AIC image; `spinor write` in the bootloader shell is the low-level alternative.
6. ~~**Aux buttons.**~~ Separate GPIOs, active low.

## Plan

1. ~~Confirm the scan in 02.020 and map it: functions, key id table, report sender.~~ Done.
2. ~~Tooling: unpack the `os` FIT from a backup, repack it with fixed hashes, and a round-trip test
   (unpack, repack with no change, byte-identical).~~ Done (`tools/fit.js`).
3. ~~Restore path: flash the *unmodified* backup back and confirm the dock still works.~~ Done
   (`npm run restore`, see RESTORE.md).
4. ~~The patch itself, behind an exact version check.~~ Done and flashed on a 02.020 unit
   (2026-09-26): `npm run keytest` showed two- and three-key chords, every press and release
   reported, on all 15 display keys. Not yet tried: four-key chords (ghost check), the plain
   buttons, safe mode, sleep and wake.
5. Host side: an optional "rollover" capability flag in streamdock-m18, detected from the
   firmware version string.

## Implementation (02.020)

`patch/rollover.c` is the new `keyboard scan` thread entry, built with `npm run build-patch`
(needs zig as a RISC-V C compiler) into `patch/rollover.hex`, which is committed.
`npm run patch -- <backup.bin> <out.bin>` applies it to a full backup or an `os` partition. It
refuses anything but the exact 02.020 `seg0` (md5 checked) and checks every instruction it
changes first.

- **Where:** 494 of 558 bytes at `0x40245f2e..0x4024615c`: the stock scan's normal-mode tail, the
  plain-button routine and the old thread entry, none of which the patched firmware reaches.
- **Edits:** the thread-create `addi` now points at the new entry; the three per-row
  "normal mode" branches in the stock scan jump to that row's release-and-continue label
  instead, so a mode change mid-scan cannot reach the overwritten code.
- **Behaviour:** normal mode (both mode flags 1): scan all 15 keys and the 3 plain buttons every
  10 ms, act on a state seen on two ticks in a row, ignore scans with a ghost rectangle, send
  one stock-format report per changed key from two alternating DMA buffers (retry on busy for
  about 20 ms, then retry that key next tick). The buffers (2 x 512 bytes) come from `rt_malloc`
  (0x40223326) once at start and are never freed. Any other mode: call the stock scan every 30 ms,
  so sleep and wake are unchanged.
- **Stack:** the entry frame is 0x50 bytes, less than the stock entry plus its plain-button
  routine (0x10 + 0x220), so the thread never goes deeper than stock did.
- **Safe mode:** holding the left plain button (PA.8) while plugging in, or a failed
  `rt_malloc`, runs only the stock scan loop. Display keys then work as stock and the plain
  buttons are silent. Meant as a way back to a working dock (and to `npm run restore`) if the
  new scan ever misbehaves.
- **Version string:** the dock then reports `V3.VSDM18_HXJDF.02.420` instead of `...02.020`
  (one string at 0x402965d4, copied as exactly 22 bytes). Still numeric and above every vendor
  release, so VSD Craft does not offer an "update". Hosts can recognise the patched firmware by
  that exact string (last field 420).
- **Known limits:** a real four-key rectangle chord is ignored as a possible ghost until a key
  is released (drop the check once the PCB is known to have diodes). Keys held while the dock
  leaves normal mode get no "up" report.

## Running from RAM (tried 2026-09-26: does not work yet)

`npm run ramtest -- <image>` copies the os segment to 0x40210000 in upgrade mode, verifies it,
and `upgcmdHid exec`s a trampoline that mimics the bootloader's "Run APP" (interrupts off,
`th.dcache.call`, `th.icache.iall`, a0 = 4, a1 = boot-parameter block 0x406f2468, jump).

With the **stock** 02.020 image this loads and verifies, but the dock never re-enumerates after
the jump (not as a dock, not in upgrade mode). A replug boots the flash firmware normally; nothing
is written to flash. Likely cause: upgrade mode leaves state that a normal boot does not (the
bootloader's USB controller and interrupts are live, and `exec` is called from inside its
command handler). Not investigated further yet.

Recovery facts found on the way (02.020 bootloader):
- A failed os CRC makes the bootloader fall through to `aicupg hid usb 0` (USB upgrade mode).
- The pre-boot program enters upgrade mode if **PA.0 reads low at power-on** (default, no PBP
  pin config in the header). A last resort that needs the case opened.
