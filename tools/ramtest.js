#!/usr/bin/env node
//
// Runs a firmware image on the dock from RAM, without writing flash: the way
// to try a patch before flashing it. Unplugging the dock afterwards boots the
// firmware in flash again, unchanged.
//
// How: enter upgrade mode, copy the image's os code segment to its load
// address with `upgcmdHid write`, read it back, put a small trampoline in the
// RAM scratch window, and `upgcmdHid exec` it. The trampoline does what the
// bootloader's own "Run APP" step does before starting the firmware: disable
// interrupts, write back the data cache, invalidate the instruction cache,
// pass the same boot arguments, and jump.
//
// upgcmd calls go through allow(): reads, RAM writes to exactly those two
// places, and exec of the trampoline. No flash command is allowed at all.
//
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listen } from './keytest.js';
import { extractSegment, parseFit, verifyFit } from './fit.js';
import { DEFAULT_UPGCMD, FLASH_SIZE, PARTS, RAM, connect, fail, hex, sleep } from './upgrade.js';

// Facts from the 02.020 bootloader (tinySPL, Jul 2026), see DESIGN.md.
const BOOT_A0 = 4;              // boot device the bootloader passes: SPI NOR
const BOOT_A1 = 0x406f2468;     // its boot-parameter block, which the firmware copies early on
const TRAMPOLINE = RAM;         // scratch window, verified unused by the bootloader
const APP_RAM_END = 0x406c0000; // the bootloader itself lives from here up

// RV32 + T-Head (XTheadCmo/XTheadSync) machine code, little endian words.
const trampoline = entry => {
  const lui = (rd, imm20) => ((imm20 & 0xfffff) << 12) | (rd << 7) | 0x37;
  const addi = (rd, rs, imm) => ((imm & 0xfff) << 20) | (rs << 15) | (rd << 7) | 0x13;
  const hi = v => ((v + 0x800) >>> 12) & 0xfffff;
  const lo = v => v & 0xfff;
  const [A0, A1, T0] = [10, 11, 5];
  const words = [
    0x30047073,                 // csrci mstatus, 8     interrupts off
    0x0ff0000f,                 // fence
    0x0180000b,                 // th.sync
    0x0010000b,                 // th.dcache.call       write back the whole data cache
    0x0180000b,                 // th.sync
    0x0100000b,                 // th.icache.iall       drop the whole instruction cache
    0x0180000b,                 // th.sync
    0x0000100f,                 // fence.i
    addi(A0, 0, BOOT_A0),       // li a0, 4
    lui(A1, hi(BOOT_A1)),       // la a1, boot params
    addi(A1, A1, lo(BOOT_A1)),
    lui(T0, hi(entry)),         // la t0, entry
    addi(T0, T0, lo(entry)),
    0x00028067,                 // jr t0
  ];
  const buf = Buffer.alloc(words.length * 4);
  words.forEach((w, i) => buf.writeUInt32LE(w >>> 0, i * 4));
  return buf;
};

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = name => argv.includes(`--${name}`);

if (has('help') || argv.length === 0) {
  console.log(`usage: npm run ramtest -- <image.bin> [options]

  <image.bin>       full flash image or os partition, e.g. your backup (to
                    check the RAM path with stock firmware) or the output of
                    npm run patch
  --listen=<s>      after it starts, connect and print key events for <s>
                    seconds (default 60, 0 to skip)
  --upgcmd=<path>   upgcmdHid.exe (default: VSD Craft's UpDateToolV3 folder)

Writes no flash. Unplug and replug the dock to go back to its own firmware.`);
  process.exit(argv.length === 0 ? 1 : 0);
}

const IN = argv.find(a => !a.startsWith('--'));
const UPGCMD = flag('upgcmd', DEFAULT_UPGCMD);
const LISTEN = Number(flag('listen', '60'));

let seg0, load, trampo;
function allow(args) {
  const [cmd, ...rest] = args;
  if (['-l', 'log', 'read', 'readl'].includes(cmd)) return;
  if (cmd === 'write' && rest.length === 2) {
    const addr = Number(rest[0]);
    if (addr === load && readFileSync(rest[1]).equals(seg0)) return;
    if (addr === TRAMPOLINE && readFileSync(rest[1]).equals(trampo)) return;
  }
  if (cmd === 'exec' && Number(rest[0]) === TRAMPOLINE && rest.length === 1) return;
  if (cmd === 'shcmd' && rest.join(' ') === 'reset') return;
  throw new Error(`refusing upgcmd ${args.join(' ')}: not on the RAM-test allow list`);
}

async function main() {
  if (!existsSync(UPGCMD)) fail(`upgcmd not found at ${UPGCMD}. Install VSD Craft, or pass --upgcmd=<path>.`);
  if (!IN || !existsSync(IN)) fail('which image? See --help.');

  const file = readFileSync(IN);
  const [, osOff, osSize] = PARTS.find(p => p[0] === 'os');
  const os = file.length === FLASH_SIZE ? file.subarray(osOff, osOff + osSize) : file;
  const check = verifyFit(os);
  if (check.problems.length) fail(`the os in ${IN} does not verify: ${check.problems.join('; ')}`);
  const segs = parseFit(os).segments;
  if (segs.length !== 1) fail(`expected one code segment, found ${segs.length}`);
  seg0 = extractSegment(os, 'seg0');
  load = segs[0].load;
  if (load !== 0x40210000 || load + seg0.length > APP_RAM_END) fail(`unexpected load address ${hex(load)}`);
  const version = seg0.toString('latin1').match(/V3\.[A-Z0-9_]+\.\d+\.\d+/)?.[0];
  console.log(`image ${IN}\n  ${check.lines.join('\n  ')}\n  firmware ${version}, load ${hex(load)}`);
  trampo = trampoline(load);

  const dock = connect({ upgcmd: UPGCMD, allow });
  const segFile = join(tmpdir(), `m18-ramtest-seg0-${process.pid}.bin`);
  const tFile = join(tmpdir(), `m18-ramtest-tramp-${process.pid}.bin`);
  const back = join(tmpdir(), `m18-ramtest-back-${process.pid}.bin`);
  try {
    await dock.enterUpgrade();
    writeFileSync(segFile, seg0);
    writeFileSync(tFile, trampo);

    console.log('copying the firmware to RAM');
    dock.upg(['write', hex(load), segFile], { timeout: 120_000 });
    dock.upg(['read', hex(load), hex(seg0.length), back], { timeout: 120_000 });
    if (!readFileSync(back).equals(seg0)) {
      console.log(await dock.reset());
      fail('the firmware read back from RAM differs. Nothing was started; the dock was reset.');
    }
    dock.upg(['write', hex(TRAMPOLINE), tFile]);
    dock.upg(['read', hex(TRAMPOLINE), hex(trampo.length), back]);
    if (!readFileSync(back).equals(trampo)) {
      console.log(await dock.reset());
      fail('the trampoline read back from RAM differs. Nothing was started; the dock was reset.');
    }
    console.log('both verified in RAM. Starting it.');

    // The device jumps away and never answers, so upgcmd errors or times out.
    dock.upg(['exec', hex(TRAMPOLINE)], { timeout: 8_000, errorsExpected: true, onError: () => {} });
    const s = await dock.waitFor('normal', 20);
    if (!s) {
      fail(`the dock did not come up as a normal dock within 20s (now: ${dock.mode()}).
Unplug and replug it: it then starts its own firmware from flash, unchanged.`);
    }
    console.log(`firmware running from RAM, dock up after ${s}s`);
    if (LISTEN > 0) await listen(LISTEN);
    console.log('\nDone. Unplug and replug the dock to go back to the firmware in flash.');
  } finally {
    dock.close();
  }
}

main().catch(err => fail(err.message));
