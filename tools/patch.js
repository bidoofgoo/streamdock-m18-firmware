#!/usr/bin/env node
//
// Applies the multi-key rollover patch to a backup of your own M18. See
// DESIGN.md for what it changes and patch/rollover.c for the new code.
//
// Takes a full flash backup (16 MB, from `npm run backup`) or just the `os`
// partition (2 MB), and writes the same kind of file with the patch applied.
// It only accepts the exact firmware build it was written for, and never
// touches the input file. Nothing here talks to the device.
//
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSegment, replaceSegment, verifyFit } from './fit.js';

// The one build this patch knows. The md5 is of the raw `seg0` code segment.
const BUILD = {
  version: 'V3.VSDM18_HXJDF.02.020',
  seg0Size: 0xa8fe8,
  seg0Md5: '2076c62d9b0f8306b0cb41c17afc9126',
  base: 0x40210000,
};
// The version string the dock reports over HID becomes this, so hosts can tell
// a patched dock apart. Same length (the firmware copies exactly 22 bytes), and
// still numeric and higher than any vendor release, so VSD Craft never offers
// an "update" over it. 420 marks the rollover patch on 02.020 (and it's funny).
const VERSION = { at: 0x402965d4, to: 'V3.VSDM18_HXJDF.02.420' };
const OS_OFFSET = 0xc0000; // in the full flash image
const OS_SIZE = 0x200000;
const FLASH_SIZE = 0x1000000;

// Where the new code goes: from the stock scan's normal-mode tail to the end
// of the stock thread entry. patch/rollover.ld must agree.
const CAVE = { start: 0x40245f2e, end: 0x4024615c };

// Instructions to change. `was` is the stock encoding (checked before
// patching, little-endian hex); `to` is the new target.
const EDITS = [
  // thread create: `addi a1, a1, ...` after `auipc a1, 2` at 0x40244438 gives the entry
  { at: 0x4024443c, was: '938585ce', kind: 'addi', base: 0x40246438, to: CAVE.start, why: 'thread entry' },
  // stock scan, normal mode, per row: skip to that row's release-and-continue label
  { at: 0x40245d2c, was: '6301f720', kind: 'branch', to: 0x40245c90, why: 'row PC.0 normal-mode branch' },
  { at: 0x40245d6e, was: '6302f724', kind: 'branch', to: 0x40245cca, why: 'row PB.2 normal-mode branch' },
  { at: 0x40245db0, was: '6301f71c', kind: 'branch', to: 0x40245d04, why: 'row PB.1 normal-mode branch' },
];

const argv = process.argv.slice(2);
const files = argv.filter(a => !a.startsWith('--'));
if (argv.includes('--help') || files.length !== 2) {
  console.log(`usage: npm run patch -- <backup.bin> <patched.bin> [--force]

  <backup.bin>   full 16 MB flash backup, or the 2 MB os partition
  <patched.bin>  output, same size as the input
  --force        overwrite <patched.bin> if it exists

Applies the multi-key rollover patch for ${BUILD.version} only.`);
  process.exit(files.length === 2 ? 0 : 1);
}

const fail = msg => { console.error(`error: ${msg}`); process.exit(1); };
const hex32 = n => `0x${n.toString(16).padStart(8, '0')}`;
const md5 = buf => createHash('md5').update(buf).digest('hex');

const [IN, OUT] = files.map(f => resolve(f));
if (IN === OUT) fail('output must be a different file from the input');
if (existsSync(OUT) && !argv.includes('--force')) fail(`${OUT} exists (use --force to overwrite)`);

const input = readFileSync(IN);
let osPart;
if (input.length === FLASH_SIZE) osPart = input.subarray(OS_OFFSET, OS_OFFSET + OS_SIZE);
else if (input.length === OS_SIZE) osPart = input;
else fail(`expected a ${FLASH_SIZE} byte flash backup or a ${OS_SIZE} byte os partition, got ${input.length} bytes`);

// 1. The input must be intact and exactly the known build.
const check = verifyFit(osPart);
if (check.problems.length) fail(`the os partition does not verify: ${check.problems.join('; ')}`);
const seg0 = extractSegment(osPart, 'seg0');
if (!seg0.includes(BUILD.version)) fail(`this is not ${BUILD.version}; the patch refuses other firmware`);
if (seg0.length !== BUILD.seg0Size || md5(seg0) !== BUILD.seg0Md5) {
  fail(`the firmware says ${BUILD.version} but is not the build this patch knows (md5 ${md5(seg0)}). Not patching.`);
}

// 2. Patch the code segment.
const at = addr => addr - BUILD.base;
const code = Buffer.from(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'patch', 'rollover.hex'), 'latin1')
  .replace(/\s+/g, ''), 'hex');
const room = CAVE.end - CAVE.start;
if (code.length === 0 || code.length > room) fail(`patch code is ${code.length} bytes, room for ${room}`);

for (const e of EDITS) {
  const cur = seg0.subarray(at(e.at), at(e.at) + 4).toString('hex');
  if (cur !== e.was) fail(`unexpected instruction at ${hex32(e.at)} (${e.why}): ${cur}`);
  let word = seg0.readUInt32LE(at(e.at));
  if (e.kind === 'addi') {
    const imm = e.to - e.base;
    if (imm < -2048 || imm > 2047) fail(`addi offset out of range at ${hex32(e.at)}`);
    word = ((word & 0x000fffff) | ((imm & 0xfff) << 20)) >>> 0;
  } else {
    const imm = e.to - e.at;
    if (imm < -4096 || imm > 4094 || imm & 1) fail(`branch offset out of range at ${hex32(e.at)}`);
    const i = imm & 0x1fff;
    word = ((word & 0x01fff07f)
      | (((i >> 12) & 1) << 31) | (((i >> 5) & 0x3f) << 25)
      | (((i >> 1) & 0xf) << 8) | (((i >> 11) & 1) << 7)) >>> 0;
  }
  seg0.writeUInt32LE(word, at(e.at));
}

// Version string: same length, NUL after it untouched.
if (VERSION.to.length !== BUILD.version.length) fail('internal: version strings differ in length');
if (seg0.toString('latin1', at(VERSION.at), at(VERSION.at) + BUILD.version.length + 1) !== BUILD.version + '\0') {
  fail(`version string not found at ${hex32(VERSION.at)}`);
}
seg0.write(VERSION.to, at(VERSION.at), 'latin1');

// Unused cave bytes become zero, which decodes as an illegal instruction.
seg0.fill(0, at(CAVE.start), at(CAVE.end));
code.copy(seg0, at(CAVE.start));

// 3. Repack with fresh hashes, check the result, write it out.
const newOs = replaceSegment(osPart, 'seg0', seg0);
const recheck = verifyFit(newOs);
if (recheck.problems.length) fail(`patched partition does not verify: ${recheck.problems.join('; ')}`);

let output = newOs;
if (input.length === FLASH_SIZE) {
  output = Buffer.from(input);
  newOs.copy(output, OS_OFFSET);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, output);

console.log(`${BUILD.version}: patched, now reports ${VERSION.to}`);
console.log(`  new scan thread: ${code.length} bytes at ${hex32(CAVE.start)}`);
for (const e of EDITS) console.log(`  ${hex32(e.at)}: ${e.why} -> ${hex32(e.to)}`);
for (const line of recheck.lines) console.log(`  ${line}`);
console.log(`wrote ${OUT} (md5 ${md5(output)})`);
console.log('This file is for your own dock only. Do not share it.');
