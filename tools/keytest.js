#!/usr/bin/env node
//
// Connects to the dock like a host does and prints every key event until you
// stop pressing, so you can see whether several keys held at once are all
// reported (rollover). Quit VSD Craft and dockd first: only one program can
// hold the dock.
//
import { fileURLToPath } from 'node:url';
import HID from 'node-hid';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = n => '0x' + n.toString(16);

/**
 * Opens the dock, runs the connect handshake and prints key events. Stops
 * `idle` seconds after the last key goes up, or after `seconds` at most.
 * Returns whether rollover was seen.
 */
export async function listen(seconds, idle = 4) {
  const info = HID.devices().find(d => d.vendorId === 0x5548 && d.productId === 0x1000 && d.usagePage === 0xffa0);
  if (!info) { console.log('no dock found. Is it plugged in, and are VSD Craft and dockd closed?'); return false; }
  const dev = new HID.HID(info.path);
  const send = body => { const r = Buffer.alloc(1025); Buffer.from(body).copy(r, 1); dev.write(r); };
  const crt = s => [0x43, 0x52, 0x54, 0, 0, ...Buffer.from(s, 'latin1')];
  // DIS before CONNECT resets any half-open session (see streamdock-m18).
  send(crt('DIS')); send(crt('CONNECT')); send(crt('STP'));
  const keepalive = setInterval(() => send([...crt('LIG\0\0'), 80]), 8000);

  const held = new Set();
  let rollover = false;
  let most = 0;
  let lastEvent = 0;
  const name = id => id <= 15 ? `key ${id}` : { 0x25: 'left button', 0x30: 'middle button', 0x31: 'right button' }[id] ?? `id ${hex(id)}`;
  dev.on('data', buf => {
    if (buf.toString('latin1', 0, 8) !== 'ACK\0\0OK\0' || !buf[9]) return;
    const [id, down] = [buf[9], buf[10]];
    if (down && held.size && !held.has(id)) rollover = true;
    down ? held.add(id) : held.delete(id);
    most = Math.max(most, held.size);
    lastEvent = Date.now();
    console.log(`  ${name(id).padEnd(13)} ${down ? 'down' : 'up  '}   held: ${[...held].map(name).join(', ') || '-'}`);
  });
  dev.on('error', () => {});
  console.log(`listening (stops ${idle}s after your last key, at most ${seconds}s). Go!`);
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    await sleep(200);
    if (lastEvent && held.size === 0 && Date.now() - lastEvent > idle * 1000) break;
  }
  clearInterval(keepalive);
  try { dev.close(); } catch { /* gone */ }
  console.log(rollover
    ? `\nROLLOVER SEEN: up to ${most} keys held at once, all reported.`
    : '\nno rollover seen (the stock firmware never reports a second key while one is held).');
  return rollover;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = Number(process.argv[2] ?? 30);
  listen(Number.isFinite(s) && s > 0 ? s : 30).then(() => process.exit(0));
}
