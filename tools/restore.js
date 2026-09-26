#!/usr/bin/env node
//
// Writes a full flash backup (from `npm run backup`) back to a Stream Dock M18,
// over USB, with the ArtInChip upgrade tool from VSD Craft. See RESTORE.md.
//
// Safety, in order:
//   - The backup must verify on its own (size, boot header, os hashes).
//   - The dock is read first. That snapshot is saved to backups/ in this
//     repository (git-ignored) before anything is written, so a restore can
//     itself be undone. It never writes next to the backup you pass in.
//   - Only 64 KB blocks that differ are written, and the bootloader (spl) never
//     is unless --include-spl is given. A broken os, env, rodata or data
//     partition leaves the bootloader able to enter upgrade mode by itself; a
//     broken spl may not.
//   - Every block is read back and compared after writing, and the whole
//     flash once more at the end.
//   - upgcmd calls go through allow(): reads, RAM writes inside the scratch
//     window, and spinor erase/write of whole blocks inside the chosen regions.
//
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CHUNK, DEFAULT_UPGCMD, FLASH_SIZE, PARTS, RAM, connect, fail, hex, verifyImage } from './upgrade.js';

const REPO_BACKUPS = join(dirname(fileURLToPath(import.meta.url)), '..', 'backups');
const BLOCK = 0x10000; // 64 KB: erase unit that every SPI NOR supports
const SELFTEST_BLOCK = FLASH_SIZE - BLOCK; // last block of the unpartitioned, erased tail

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = name => argv.includes(`--${name}`);
const list = name => flag(name, '').split(',').filter(Boolean);

const USAGE = `usage: npm run restore -- <backup.bin> [options]
       npm run restore -- --selftest

  --dry-run          read the dock and report what would change. Writes nothing
  --selftest         prove erase, write and read on the last 64 KB of flash
                     (unused, erased), then erase it again. Needs no backup
  --only=<parts>     restore only these regions, e.g. --only=os
  --rewrite=<parts>  also rewrite these regions where they already match, to
                     exercise the write path on known-good data, e.g. --rewrite=os
  --include-spl      allow writing the bootloader. See RESTORE.md first
  --yes              do not ask for confirmation
  --snapshot-dir=<d> where to save the dock's contents before writing
                     (default: backups/ in this repository)
  --upgcmd=<path>    upgcmdHid.exe (default: VSD Craft's UpDateToolV3 folder)

Regions: ${PARTS.map(p => p[0]).join(', ')}. Default: all except spl.
Read BACKUP.md and RESTORE.md first.`;

if (has('help') || argv.length === 0) {
  console.log(USAGE);
  process.exit(argv.length === 0 ? 1 : 0);
}

const IN = argv.find(a => !a.startsWith('--'));
const UPGCMD = flag('upgcmd', DEFAULT_UPGCMD);
const SELFTEST = has('selftest');
const INCLUDE_SPL = has('include-spl');
const SNAP_DIR = resolve(flag('snapshot-dir', REPO_BACKUPS));
const partNames = PARTS.map(p => p[0]);
for (const n of [...list('only'), ...list('rewrite')]) if (!partNames.includes(n)) fail(`unknown region ${n}. Known: ${partNames.join(', ')}`);
if (list('only').includes('spl') || list('rewrite').includes('spl')) {
  if (!INCLUDE_SPL) fail('spl is the bootloader. Writing it needs --include-spl; read RESTORE.md first.');
}
const regions = PARTS.filter(([n]) => (list('only').length ? list('only').includes(n) : true) && (n !== 'spl' || INCLUDE_SPL));
const rewrite = new Set(list('rewrite'));
for (const n of rewrite) if (!regions.some(r => r[0] === n)) fail(`--rewrite=${n} is outside the regions being restored`);

// What restore may write. Anything else is refused before it reaches upgcmd.
const writable = SELFTEST ? [[SELFTEST_BLOCK, BLOCK]] : regions.map(([, off, len]) => [off, len]);
const inWritable = (off, len) => writable.some(([o, l]) => off >= o && off + len <= o + l);

function allow(args) {
  const [cmd, ...rest] = args;
  if (['-l', 'lspart', 'log', 'read', 'readl'].includes(cmd)) return;
  if (cmd === 'fill') {
    const [addr, len] = rest.map(Number);
    if (addr >= RAM && addr + len <= RAM + CHUNK) return;
  }
  if (cmd === 'write' && Number(rest[0]) === RAM && rest.length === 2) return; // file size checked by the caller
  if (cmd === 'shcmd') {
    const sh = rest.join(' ');
    if (/^spinor init \d$/.test(sh) || sh === 'reset') return;
    let m = sh.match(/^spinor read (0x[0-9a-f]+) (0x[0-9a-f]+) (0x[0-9a-f]+)$/);
    if (m && Number(m[1]) === RAM && Number(m[3]) <= CHUNK) return;
    m = sh.match(/^spinor erase (0x[0-9a-f]+) (0x[0-9a-f]+)$/);
    if (m && Number(m[1]) % BLOCK === 0 && Number(m[2]) === BLOCK && inWritable(Number(m[1]), BLOCK)) return;
    m = sh.match(/^spinor write (0x[0-9a-f]+) (0x[0-9a-f]+) (0x[0-9a-f]+)$/);
    if (m && Number(m[1]) === RAM && Number(m[2]) % BLOCK === 0 && Number(m[3]) === BLOCK && inWritable(Number(m[2]), BLOCK)) return;
  }
  throw new Error(`refusing upgcmd ${args.join(' ')}: not on the restore allow list`);
}

const md5 = buf => createHash('md5').update(buf).digest('hex');
const mb = n => `${(n / 1048576).toFixed(2)} MB`;
const regionOf = off => PARTS.find(([, o, l]) => off >= o && off < o + l)[0];
const stamp = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

async function confirm(question) {
  if (has('yes')) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question}\nType "restore" to continue, anything else to stop: `);
  rl.close();
  if (answer.trim() !== 'restore') fail('stopped. Nothing was written.');
}

/** Writes one block and reads it back, once more on a mismatch. */
function writeVerified(dock, off, data) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    dock.writeBlock(off, data);
    const back = dock.readBlock(off, data.length);
    if (back.equals(data)) return;
    console.log(`\n  block ${hex(off)} read back different (attempt ${attempt})`);
  }
  fail(`block ${hex(off)} (${regionOf(off)}) did not verify after two writes.
Leave the dock plugged in and run the same command again. If the os was being
written, the dock now starts in upgrade mode by itself, which is what restore needs.`);
}

async function selftest(dock) {
  const erased = Buffer.alloc(BLOCK, 0xff);
  console.log(`selftest on ${hex(SELFTEST_BLOCK)}..${hex(FLASH_SIZE)} (unpartitioned tail)`);
  const before = dock.readBlock(SELFTEST_BLOCK, BLOCK);
  if (!before.equals(erased)) fail(`the selftest block is not erased (0xFF), so something may use it. Not touching it.`);
  const pattern = Buffer.alloc(BLOCK);
  for (let i = 0, x = 0x12345678; i < BLOCK; i++) { x = (x * 1103515245 + 12345) >>> 0; pattern[i] = x >>> 24; }
  dock.writeBlock(SELFTEST_BLOCK, pattern);
  const written = dock.readBlock(SELFTEST_BLOCK, BLOCK);
  console.log(`  write + read back: ${written.equals(pattern) ? 'ok' : 'MISMATCH'}`);
  dock.writeBlock(SELFTEST_BLOCK, erased); // programming 0xFF after an erase leaves it erased
  const after = dock.readBlock(SELFTEST_BLOCK, BLOCK);
  console.log(`  erase back to 0xFF: ${after.equals(erased) ? 'ok' : 'MISMATCH'}`);
  if (!written.equals(pattern) || !after.equals(erased)) fail('selftest failed. Do not restore until this is understood.');
  console.log('selftest passed: the dock can erase, write and read its flash over this path.');
}

async function main() {
  if (!existsSync(UPGCMD)) fail(`upgcmd not found at ${UPGCMD}. Install VSD Craft, or pass --upgcmd=<path>.`);

  let target;
  if (!SELFTEST) {
    if (!IN) fail('which backup? See --help.');
    const file = resolve(IN);
    if (!existsSync(file)) fail(`${file} not found`);
    target = readFileSync(file);
    console.log(`backup ${file}\n  md5 ${md5(target)}`);
    const { problems, version } = verifyImage(target);
    if (problems.length) fail(`this backup does not verify, refusing to write it:\n      ${problems.join('\n      ')}`);
    console.log(`  firmware version ${version ?? 'unknown'}`);
  }

  const dock = connect({ upgcmd: UPGCMD, allow });
  try {
    await dock.enterUpgrade();
    dock.initFlash();
    if (SELFTEST) {
      await selftest(dock);
      console.log(await dock.reset());
      return;
    }

    // Read what is on the dock now, and keep it.
    const current = dock.readFlash('reading the dock');
    const { version: curVersion } = verifyImage(current, { quiet: true });
    console.log(`  on the dock now: md5 ${md5(current)}, firmware ${curVersion ?? 'unknown or damaged'}`);

    const splLen = PARTS[0][2];
    if (!INCLUDE_SPL && !current.subarray(0, splLen).equals(target.subarray(0, splLen))) {
      fail(`the bootloader (spl) on the dock differs from the one in the backup.
This backup may come from another unit or another bootloader version. Nothing was written.
See RESTORE.md before considering --include-spl.`);
    }

    // Plan: every 64 KB block in the chosen regions that differs, or all of them for --rewrite.
    const plan = [];
    for (const [name, off, len] of regions) {
      for (let b = off; b < off + len; b += BLOCK) {
        const same = current.subarray(b, b + BLOCK).equals(target.subarray(b, b + BLOCK));
        if (!same || rewrite.has(name)) plan.push(b);
      }
    }
    for (const [name, off, len] of PARTS) {
      const n = plan.filter(b => b >= off && b < off + len).length;
      const differs = !current.subarray(off, off + len).equals(target.subarray(off, off + len));
      const chosen = regions.some(r => r[0] === name);
      console.log(`  ${name.padEnd(7)} ${differs ? 'differs' : 'same   '}  ${chosen ? `${n} block(s) to write` : 'not restored'}`);
    }
    if (plan.length === 0) {
      console.log('\nThe dock already matches the backup in the chosen regions. Nothing to write.');
      console.log(await dock.reset());
      return;
    }
    if (has('dry-run')) {
      console.log(`\ndry run: would write ${plan.length} block(s), ${mb(plan.length * BLOCK)}. Nothing was written.`);
      console.log(await dock.reset());
      return;
    }

    mkdirSync(SNAP_DIR, { recursive: true });
    const snap = join(SNAP_DIR, `dock-before-restore-${stamp()}.bin`);
    if (existsSync(snap)) fail(`${snap} already exists`);
    writeFileSync(snap, current);
    console.log(`\nsaved what is on the dock now to ${snap}`);

    await confirm(`\nAbout to write ${plan.length} block(s) (${mb(plan.length * BLOCK)}) to the dock.`);

    const t0 = Date.now();
    plan.forEach((b, i) => {
      writeVerified(dock, b, target.subarray(b, b + BLOCK));
      process.stdout.write(`\rwriting: ${i + 1} / ${plan.length} blocks (${regionOf(b)})      `);
    });
    console.log(` (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

    const after = dock.readFlash('final check');
    const bad = regions.filter(([, off, len]) => !after.subarray(off, off + len).equals(target.subarray(off, off + len)));
    if (bad.length) fail(`after writing, these regions still differ from the backup: ${bad.map(r => r[0]).join(', ')}. Run the same command again.`);
    console.log('the dock matches the backup in every restored region');

    console.log(await dock.reset());
    console.log(`\nRestore done. The snapshot from before is ${snap}.`);
  } finally {
    dock.close();
  }
}

main().catch(err => fail(err.message));
