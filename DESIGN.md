# Design: multi-key rollover patch

Working design for the first patch. It describes behaviour and approach. It deliberately reproduces
no vendor code.

## What the stock firmware does

From the key scan in the public `V3.VSDM18.02.015` image; still to be confirmed in
`V3.VSDM18_HXJDF.02.020`:

- A dedicated RTOS thread (`keyboard scan`, RT-Thread) runs the scan every 30 ms.
- The 15 display keys are a **3 x 5 matrix**: three row pins driven low one at a time, five
  column pins read back (active low).
- For each row: read the columns. If a key is down, **block in a 10 ms loop until it is
  released**, emit the event, then move on. Nothing else is scanned while blocked.
- The column read maps the 5-bit pattern through a lookup table that only recognises one low
  column per row.
- The three plain buttons are handled separately; their pins are not identified yet.

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
2. **02.020 layout.** Find the same functions in the HXJDF 02.020 build (from the user's own
   backup). The thread name string and the pin name strings (`PC.0`, `PB.2`, ...) are good
   anchors.
3. **Space.** Does the new scan fit in place of the old one, or does it need a code cave or an
   appended segment? The FIT image has room: the `os` partition is 2 MB and the image is
   about 680 KB.
4. **Checksums.** After patching, recompute the FIT segment's CRC32 and MD5. The bootloader
   checks them.
5. **Flashing and restoring.** Establish and test the write path on a known-good image (the
   unmodified backup) before flashing anything patched. The vendor's `upgcmdHid image` takes an
   AIC image; `spinor write` in the bootloader shell is the low-level alternative.
6. **Aux buttons.** Are they in the matrix or on separate GPIOs?

## Plan

1. Confirm the scan in 02.020 and map it: functions, key id table, report sender.
2. Tooling: unpack the `os` FIT from a backup, repack it with fixed hashes, and a round-trip test
   (unpack, repack with no change, byte-identical).
3. Restore path: flash the *unmodified* backup back and confirm the dock still works.
4. The patch itself, behind an exact version check.
5. Host side: an optional "rollover" capability flag in streamdock-m18, detected from the
   firmware version string.
