//
// Shared plumbing for talking to a Stream Dock M18 in its bootloader's upgrade
// mode, through the ArtInChip upgrade tool that ships with VSD Craft.
//
// Every upgcmd call goes through the allow function the calling tool passes to
// connect(). The backup tool passes a read-only list; the restore tool a list
// that also allows erasing and writing flash, within bounds.
//
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import HID from 'node-hid';
import { verifyFit } from './fit.js';

export const DEFAULT_UPGCMD = 'C:\\Program Files (x86)\\VSD Craft\\UpDateToolV3\\upgcmdHid.exe';

const DOCK = { vendorId: 0x5548, productId: 0x1000, usagePage: 0xffa0 }; // normal mode, vendor interface
const REPORT_SIZE = 1024;         // output reports must be exactly this long, or the dock drops them
const UPGRADE_VID = 0x33c3;       // ArtInChip upgrade mode (seen as 33C3:8899 in HID mode)
export const FLASH_SIZE = 0x1000000; // 16 MB; a mirror check catches a smaller part
export const CHUNK = 0x40000;     // 256 KB per round trip, well under a second each
export const RAM = 0x40100000;    // PSRAM scratch window of CHUNK bytes, verified unused by the bootloader
const SENTINEL = 0xa5;
const APPNEW = [0x43, 0x52, 0x54, 0x00, 0x00, 0x41, 0x50, 0x50, 0x4e, 0x45, 0x57]; // "CRT\0\0APPNEW"

// Partition map as reported by `upgcmdHid lspart spi-nor` on a VSDM18 unit,
// plus the unpartitioned (erased) tail.
export const PARTS = [
  ['spl', 0x000000, 0x080000],
  ['env', 0x080000, 0x020000],
  ['env_r', 0x0a0000, 0x020000],
  ['os', 0x0c0000, 0x200000],
  ['rodata', 0x2c0000, 0xa00000],
  ['data', 0xcc0000, 0x100000],
  ['tail', 0xdc0000, 0x240000],
];

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const hex = n => '0x' + n.toString(16);

export function fail(msg) {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

/** Returns the helpers for one session, with every upgcmd call gated by `allow`. */
export function connect({ upgcmd, allow }) {
  /**
   * Runs upgcmd with a timeout. The tool exits 0 even when it prints [ERROR],
   * and a failed command usually leaves the bootloader's USB session hung, so
   * any error line is fatal unless the caller says otherwise.
   */
  function upg(args, { timeout = 30_000, errorsExpected = false, onError } = {}) {
    allow(args);
    const r = spawnSync(upgcmd, args, { encoding: 'utf8', timeout });
    const out = (r.stdout || '') + (r.stderr || '');
    const die = onError ?? fail;
    if (r.error?.code === 'ETIMEDOUT') die(`upgcmd ${args[0]} timed out after ${timeout / 1000}s.`);
    else if (r.error) die(`could not run ${upgcmd}: ${r.error.message}`);
    else if (/\[ERROR/.test(out) && !errorsExpected) die(`upgcmd ${args.join(' ')} reported an error.\n${out.trim()}`);
    return out;
  }

  const dockInterface = () => HID.devices().find(d =>
    d.vendorId === DOCK.vendorId && d.productId === DOCK.productId && d.usagePage === DOCK.usagePage);

  // Enumeration only, so checking never touches the dock.
  function mode() {
    if (HID.devices().some(x => x.vendorId === UPGRADE_VID)) return 'upgrade';
    return dockInterface() ? 'normal' : 'none';
  }

  async function waitFor(want, seconds) {
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      if (mode() === want) return i + 1;
    }
    return 0;
  }

  async function enterUpgrade() {
    const now = mode();
    if (now === 'upgrade') return console.log('dock already in upgrade mode');
    if (now !== 'normal') fail('no Stream Dock M18 found. Plug it in, and quit VSD Craft and dockd.');
    let dev;
    try {
      dev = new HID.HID(dockInterface().path);
    } catch (err) {
      fail(`could not open the dock (${err.message}). Is VSD Craft or dockd still running?`);
    }
    // Report ID byte 0 (no report IDs), then the command, zero padded to a full report.
    const report = Buffer.alloc(REPORT_SIZE + 1);
    Buffer.from(APPNEW).copy(report, 1);
    dev.write(report);
    try { dev.close(); } catch { /* the dock is already rebooting */ }
    const s = await waitFor('upgrade', 10);
    if (!s) fail('dock did not come back in upgrade mode within 10s. Replug it to recover.');
    console.log(`upgrade mode after ${s}s`);
  }

  function initFlash() {
    upg(['shcmd', 'spinor init 0']);
    // shcmd never reports shell failures, so confirm through the device log.
    // The log is cleared on read.
    const log = upg(['log']);
    if (!log.includes('probe spinor flash success')) fail(`spinor init did not probe the flash. Device log:\n${log.trim()}`);
  }

  const work = mkdtempSync(join(tmpdir(), 'm18-'));
  const scratch = join(work, 'chunk.bin');
  const close = () => rmSync(work, { recursive: true, force: true });

  /** Reads `len` bytes (at most CHUNK) of flash at `off`, through the RAM window. */
  function readBlock(off, len, opts) {
    // A shell failure is silent, so without the sentinel a failed read would
    // hand back the previous block as if it were this one.
    upg(['fill', hex(RAM), hex(len), hex(SENTINEL)], opts);
    upg(['shcmd', `spinor read ${hex(RAM)} ${hex(off)} ${hex(len)}`], opts);
    upg(['read', hex(RAM), hex(len), scratch], { timeout: 60_000, ...opts });
    const data = readFileSync(scratch);
    if (data.length !== len) fail(`short read at ${hex(off)}: ${data.length} bytes`);
    if (data.every(b => b === SENTINEL)) fail(`block at ${hex(off)} still holds the RAM sentinel: the flash read did not happen`);
    return data;
  }

  function readFlash(label) {
    const image = Buffer.alloc(FLASH_SIZE);
    const t0 = Date.now();
    for (let off = 0; off < FLASH_SIZE; off += CHUNK) {
      readBlock(off, CHUNK).copy(image, off);
      process.stdout.write(`\r${label}: ${((off + CHUNK) / 1048576).toFixed(2)} / 16 MB`);
    }
    console.log(` (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    return image;
  }

  /** Erases and programs one flash block from `data`, through the RAM window. No verification. */
  function writeBlock(off, data) {
    writeFileSync(scratch, data);
    upg(['write', hex(RAM), scratch], { timeout: 60_000 });
    upg(['shcmd', `spinor erase ${hex(off)} ${hex(data.length)}`], { timeout: 60_000 });
    upg(['shcmd', `spinor write ${hex(RAM)} ${hex(off)} ${hex(data.length)}`], { timeout: 60_000 });
  }

  async function reset() {
    // The device reboots before it can acknowledge, so upgcmd always reports a
    // USB error here. Whether the reset worked is judged by re-enumeration.
    upg(['shcmd', 'reset'], { errorsExpected: true });
    const s = await waitFor('normal', 15);
    if (s) return `dock back to normal after ${s}s`;
    if (mode() === 'upgrade') return 'the dock came back in UPGRADE mode: the firmware did not start';
    return 'dock did not come back by itself. Unplug and replug it.';
  }

  return { upg, mode, waitFor, enterUpgrade, initFlash, readBlock, readFlash, writeBlock, reset, close };
}

/** Checks a full flash image against everything it can vouch for itself. */
export function verifyImage(image, { quiet = false } = {}) {
  const problems = [];
  if (image.length !== FLASH_SIZE) return { problems: [`expected ${FLASH_SIZE} bytes, got ${image.length}`], version: null };
  if (image.toString('latin1', 0, 4) !== 'AIC ') problems.push('spl does not start with the "AIC " boot header');
  if (image.subarray(0, 0x100000).equals(image.subarray(0x800000, 0x900000))) {
    problems.push('first 1 MB repeats at 8 MB: the flash is probably 8 MB and the dump is mirrored');
  }

  const [, osOff, osSize] = PARTS.find(p => p[0] === 'os');
  const os = image.subarray(osOff, osOff + osSize);
  const { lines, problems: fitProblems, fit } = verifyFit(os);
  if (!quiet) for (const line of lines) console.log(`  os ${line}`);
  problems.push(...fitProblems);
  const seg = fit?.segments[0];
  const version = seg ? os.toString('latin1', seg.offset, seg.offset + seg.size).match(/V3\.[A-Z0-9_]+\.\d+\.\d+/)?.[0] ?? null : null;
  return { problems, version };
}
