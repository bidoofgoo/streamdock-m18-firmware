#!/usr/bin/env node
//
// Compiles patch/rollover.c for the M18 and writes the machine code to
// patch/rollover.hex, which tools/patch.js applies. Only needed after changing
// the C source: the .hex file is committed.
//
// Needs a RISC-V clang. Zig bundles one: set ZIG to how you run it, e.g.
//   ZIG=zig                  (zig on PATH, the default)
//   ZIG="python -m ziglang"  (pip install ziglang)
//
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATCH = join(dirname(fileURLToPath(import.meta.url)), '..', 'patch');
const [zig, ...zigArgs] = (process.env.ZIG ?? 'zig').split(' ');
const work = mkdtempSync(join(tmpdir(), 'm18-patch-'));

function run(...args) {
  const r = spawnSync(zig, [...zigArgs, ...args], { cwd: PATCH, stdio: 'inherit' });
  if (r.error) throw new Error(`cannot run ${zig}: ${r.error.message} (set ZIG, see the top of this file)`);
  if (r.status !== 0) throw new Error(`zig ${args[0]} failed`);
}

try {
  const elf = join(work, 'rollover.elf');
  const bin = join(work, 'rollover.bin');
  run('cc', '-target', 'riscv32-freestanding-none', '-mcpu=generic_rv32+m+c', '-Os', '-mrelax',
    '-ffreestanding', '-fno-builtin', '-fno-stack-protector', '-ffunction-sections',
    '-fno-asynchronous-unwind-tables', '-fno-unwind-tables', '-nostdlib', '-Wall', '-Wextra', '-Werror',
    '-Wl,-T,rollover.ld', '-Wl,--gc-sections', '-Wl,-e,rollover_thread', '-o', elf, 'rollover.c');
  run('objcopy', '-O', 'binary', '-j', '.text', elf, bin);
  const code = readFileSync(bin);
  const hex = code.toString('hex').replace(/(.{64})/g, '$1\n').trim();
  writeFileSync(join(PATCH, 'rollover.hex'), `${hex}\n`);
  console.log(`patch/rollover.hex: ${code.length} bytes`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
