//
// Minimal FIT (flattened image tree) support for the M18's `os` partition:
// read the segments, check them against their embedded hashes, and swap a
// segment's bytes for new ones of the same size with the hashes recomputed.
//
// The header is left byte-for-byte as it is apart from the hash values, so an
// unchanged segment repacks to an identical partition.
//
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

const FDT_MAGIC = 0xd00dfeed;
const [BEGIN_NODE, END_NODE, PROP, NOP, END] = [1, 2, 3, 4, 9];

const digest = {
  crc32: data => { const b = Buffer.alloc(4); b.writeUInt32BE(crc32(data)); return b; },
  md5: data => createHash('md5').update(data).digest(),
};

/** Walks the device tree. Props keep their absolute offset so they can be patched in place. */
export function parseFit(buf) {
  if (buf.length < 40 || buf.readUInt32BE(0) !== FDT_MAGIC) return null;
  const total = buf.readUInt32BE(4);
  const offStruct = buf.readUInt32BE(8);
  const offStrings = buf.readUInt32BE(12);
  const name = o => buf.toString('latin1', offStrings + o, buf.indexOf(0, offStrings + o));
  const nodes = {};
  const path = [];
  let p = offStruct;
  for (;;) {
    const tok = buf.readUInt32BE(p); p += 4;
    if (tok === BEGIN_NODE) {
      const end = buf.indexOf(0, p);
      path.push(buf.toString('latin1', p, end));
      nodes[path.join('/')] ??= {};
      p = (end + 4) & ~3;
    } else if (tok === END_NODE) {
      path.pop();
    } else if (tok === PROP) {
      const len = buf.readUInt32BE(p);
      const offset = p + 8;
      nodes[path.join('/')][name(buf.readUInt32BE(p + 4))] = { offset, value: buf.subarray(offset, offset + len) };
      p = (offset + len + 3) & ~3;
    } else if (tok === NOP) {
      continue;
    } else if (tok === END) {
      break;
    } else {
      throw new Error(`bad FDT token ${tok} at ${p - 4}`);
    }
  }

  // External data (mkimage -E) starts after the header, 4-byte aligned.
  const dataBase = (total + 3) & ~3;
  const segments = [];
  for (const [path, props] of Object.entries(nodes)) {
    if (!props['data-size']) continue;
    const size = props['data-size'].value.readUInt32BE(0);
    const offset = dataBase + (props['data-offset']?.value.readUInt32BE(0) ?? 0);
    const hashes = Object.entries(nodes)
      .filter(([p]) => p.startsWith(`${path}/hash`))
      .map(([, h]) => ({ algo: h.algo.value.toString('latin1').replace(/\0+$/, ''), offset: h.value.offset, value: h.value.value }));
    segments.push({
      name: path.split('/').pop(),
      offset,
      size,
      load: props.load?.value.readUInt32BE(0),
      hashes,
    });
  }
  return { nodes, segments };
}

/** Checks every segment against its hashes. Returns one line per segment and a list of problems. */
export function verifyFit(buf) {
  const fit = parseFit(buf);
  if (!fit) return { lines: [], problems: ['not a FIT image'] };
  const lines = [];
  const problems = [];
  for (const seg of fit.segments) {
    const data = buf.subarray(seg.offset, seg.offset + seg.size);
    if (data.length !== seg.size) { problems.push(`${seg.name} runs past the end of the partition`); continue; }
    const results = seg.hashes.map(h => {
      if (!digest[h.algo]) return `${h.algo} unchecked`;
      const ok = digest[h.algo](data).equals(h.value);
      if (!ok) problems.push(`${seg.name} fails its ${h.algo}`);
      return `${h.algo} ${ok ? 'ok' : 'BAD'}`;
    });
    lines.push(`${seg.name}: 0x${seg.size.toString(16)} bytes, ${results.join(', ')}`);
  }
  return { lines, problems, fit };
}

/** Returns the named segment's bytes (a copy). */
export function extractSegment(buf, name) {
  const seg = parseFit(buf)?.segments.find(s => s.name === name);
  if (!seg) throw new Error(`no segment ${name}`);
  return Buffer.from(buf.subarray(seg.offset, seg.offset + seg.size));
}

/** Returns a copy of the partition with the segment replaced and its hashes recomputed. Same size only. */
export function replaceSegment(buf, name, data) {
  const seg = parseFit(buf)?.segments.find(s => s.name === name);
  if (!seg) throw new Error(`no segment ${name}`);
  if (data.length !== seg.size) throw new Error(`${name} is 0x${seg.size.toString(16)} bytes, got 0x${data.length.toString(16)}`);
  const out = Buffer.from(buf);
  data.copy(out, seg.offset);
  for (const h of seg.hashes) {
    if (!digest[h.algo]) throw new Error(`${name}: cannot recompute ${h.algo}`);
    digest[h.algo](data).copy(out, h.offset);
  }
  return out;
}
