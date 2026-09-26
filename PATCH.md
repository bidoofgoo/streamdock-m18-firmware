# Multi-key rollover patch

How to put the rollover patch on your own Stream Dock M18. Afterwards the dock reports every key
press and release, however many keys are held: chords work.

> [!CAUTION]
> **Your backup is your only way back.** The firmware this patch is built on is not published
> by the vendor. Make the backup, keep two copies in different places, and do the restore test
> ladder **before** flashing anything. See [BACKUP.md](BACKUP.md) and [RESTORE.md](RESTORE.md).

## What you get

- Every key reports its own down and up, for any number of keys at once. Tested with 11 held
  (8 display keys and all 3 plain buttons), including rectangle shapes such as 1 + 2 + 6 + 7.
- The **same report format** as stock. Software that already reads the M18's key events
  (the [streamdock-m18](https://github.com/bidoofgoo/streamdock-m18) driver, `dockd`) gets
  chords with no change.
- Faster, debounced reporting: the keys are scanned every 10 ms, where the stock firmware waited
  for each key to be released.
- The dock reports its version as **`V3.VSDM18_HXJDF.02.420`** instead of `...02.020`, so
  software can tell it is patched.

Everything else (screen, LEDs, sleep and wake) is the vendor's firmware, unchanged.

## Does it fit your dock?

Only one firmware build is supported: **`V3.VSDM18_HXJDF.02.020`**, and the patch checks the
exact bytes (md5 of the code segment). Your dock's version is printed by `npm run backup`. Any
other version is refused, and nothing is written.

## Steps

Windows, VSD Craft installed, `npm install` done. Quit VSD Craft (tray icon too) and `dockd`.

1. **Back up**, and store the file in two more places:
   ```bash
   npm run backup -- backups/my-m18.bin --twice
   ```
2. **Prove restore works on your dock**, the [test ladder](RESTORE.md#first-time-the-test-ladder):
   `--dry-run`, then `--selftest`, then `--rewrite=os`. The dock must work normally afterwards.
3. **Make the patched image** (on your PC only, nothing touches the dock):
   ```bash
   npm run patch -- backups/my-m18.bin backups/my-m18-rollover.bin
   ```
   It prints `patched, now reports V3.VSDM18_HXJDF.02.420` and `crc32 ok, md5 ok`.
4. **Flash it**:
   ```bash
   npm run restore -- backups/my-m18-rollover.bin --only=os
   ```
   This first saves what is on the dock to `backups/`, writes only the few blocks of the
   firmware that change (2 or 3), reads them back, and restarts the dock. About a minute.
5. **Try it**:
   ```bash
   npm run keytest
   ```
   The screen goes blank (that is the host connecting). Hold several keys at once; every one
   should appear. It stops 4 seconds after your last key, and prints `ROLLOVER SEEN` if a key
   went down while another was held.

## Going back to stock

```bash
npm run restore -- backups/my-m18.bin --only=os
```

The same tool, with your original backup. Only the firmware blocks that differ are written.

## Safe mode

If the patched key scan ever misbehaves: unplug the dock, **hold the left one of the three
buttons under the screen**, plug it in, and keep holding until the screen is on (about five
seconds). The new scan code then does not run at all.

In safe mode **no key reports anything**, on purpose: the patch replaces the stock key
reporting, so there is nothing else to fall back on. Everything else works, and above all the
USB connection does, so you can run the restore above. Plug in again without the button to get
rollover back.

## Good to know

- **Key events need a host.** Like the stock firmware, the dock only sends key events after a
  host has connected (`keytest`, `dockd`, VSD Craft).
- **Keys held while the dock goes to sleep** get no "up" event. Hosts should treat a sleep or a
  disconnect as "all keys up" (the streamdock-m18 driver does this on disconnect).
- **VSD Craft** has not been tested with the patched firmware. It identifies the dock by the
  unchanged `VSDM18_HXJDF` part of the version, and `02.420` is higher than any vendor release,
  so it should not offer a firmware "update". If it ever does, decline: that would overwrite the
  patch with an older vendor image that may not match your hardware.
- **Don't share patched images.** They contain the vendor's firmware. Share the patch script,
  which is what this repository is for.

## How it works

See [DESIGN.md](DESIGN.md): what the stock scan does, where the new code goes, every byte the
patch changes, and why.
