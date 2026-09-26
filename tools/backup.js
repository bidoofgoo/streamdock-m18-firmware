#!/usr/bin/env node
//
// Reads the whole SPI NOR flash of a Stream Dock M18 to a file, over USB, using
// the ArtInChip upgrade tool that ships with the vendor's own VSD Craft install.
// See BACKUP.md for what this does, why, and the risks.
//
// Nothing here writes flash. Every upgcmd call goes through allow(), which only
// lets through read commands, a RAM fill inside a scratch window, and three
// shell commands (spinor init, spinor read, reset). Windows only, because the
// vendor tool is.
//
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CHUNK, DEFAULT_UPGCMD, RAM, connect, fail, verifyImage } from './upgrade.js';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = name => argv.includes(`--${name}`);

if (has('help') || argv.length === 0) {
  console.log(`usage: npm run backup -- <out.bin> [options]      e.g. backups/my-m18.bin

  --upgcmd=<path>   upgcmdHid.exe (default: VSD Craft's UpDateToolV3 folder)
  --twice           read everything a second time and require identical results
  --keep-upgrade    stay in upgrade mode afterwards instead of resetting

Reads the full 16 MB flash. Read-only. See BACKUP.md first.`);
  process.exit(argv.length === 0 ? 1 : 0);
}

const OUT = resolve(argv.find(a => !a.startsWith('--')));
const UPGCMD = flag('upgcmd', DEFAULT_UPGCMD);

/**
 * The only gate to upgcmd. The vendor tool can erase and write flash (image,
 * write, spinor erase/write, efuse, jtag), so everything not explicitly a read
 * is refused here rather than trusted to the call sites.
 */
function allow(args) {
  const [cmd, ...rest] = args;
  if (['-l', 'lspart', 'log', 'read', 'readl'].includes(cmd)) return;
  if (cmd === 'fill') {
    const [addr, len] = rest.map(Number);
    if (addr >= RAM && addr + len <= RAM + CHUNK) return;
  }
  if (cmd === 'shcmd') {
    const sh = rest.join(' ');
    if (/^spinor init \d$/.test(sh) || /^spinor read 0x[0-9a-f]+ 0x[0-9a-f]+ 0x[0-9a-f]+$/.test(sh) || sh === 'reset') return;
  }
  throw new Error(`refusing upgcmd ${args.join(' ')}: not on the read-only allow list`);
}

async function main() {
  if (!existsSync(UPGCMD)) fail(`upgcmd not found at ${UPGCMD}. Install VSD Craft, or pass --upgcmd=<path>.`);
  if (existsSync(OUT)) fail(`${OUT} already exists. Refusing to overwrite a backup.`);

  const dock = connect({ upgcmd: UPGCMD, allow });
  try {
    await dock.enterUpgrade();
    dock.initFlash();

    const image = dock.readFlash('pass 1');
    if (has('twice')) {
      const again = dock.readFlash('pass 2');
      if (!again.equals(image)) fail('the two passes differ. The flash reads are not stable; do not trust this dump.');
      console.log('pass 1 and pass 2 are identical');
    }

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, image);
    console.log(`wrote ${OUT}`);
    console.log(`md5 ${createHash('md5').update(image).digest('hex')}`);

    console.log('verifying:');
    const { problems, version } = verifyImage(image);
    if (version) console.log(`  firmware version ${version}`);

    if (!has('keep-upgrade')) console.log(await dock.reset());

    if (problems.length) fail(problems.join('\n      '));
    console.log('\nBackup looks good. Keep a copy somewhere safe, and do not share it.');
  } finally {
    dock.close();
  }
}

main().catch(err => fail(err.message));
