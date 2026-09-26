//
// Multi-key rollover for the Stream Dock M18, firmware V3.VSDM18_HXJDF.02.020.
//
// Replaces the "keyboard scan" thread entry. In normal mode (awake and
// connected) it scans the whole 3 x 5 matrix and the three plain buttons every
// tick, debounces, and sends one key report per key that changed, in the stock
// report format. In every other mode it calls the stock scan, so sleep and wake
// behave exactly as before.
//
// Safe mode: holding the left plain button (PA.8) while plugging the dock in,
// until the screen is up, or a failed buffer allocation, runs only the stock
// scan, forever. No key reports at all then (the stock scan's normal-mode
// reporting is what this patch replaces), but none of the new scan code runs
// and the host connection works, so a restore can be run.
//
// Original code. Every vendor address it uses is listed in rollover.ld.
//
#include <stdint.h>

void *memset(void *s, int c, unsigned n);
void *rt_malloc(unsigned size);
void rt_thread_mdelay(int ms);
int hid_send(void *buf, int len);          // -2 while the endpoint is busy
void pin_write(const char *name, int level);   // also sets the pin to output
int pin_read(const char *name);
void stock_scan(void);

#define MODE_AWAKE (*(volatile uint8_t *)0x402b7475)
#define MODE_HOST (*(volatile uint32_t *)0x402b7478)

// The firmware's pin name strings sit 8 bytes apart: rows PC.0 PB.2 PB.1,
// columns PC.5..PC.1, then PA.8 and PE.11. PB.11 lives elsewhere.
#define PIN(i) ((const char *)(0x40297020 + 8 * (i)))
#define PIN_PB11 ((const char *)0x40293d6c)

#define TICK_MS 10
#define STABLE_READS 2  // a change counts once read the same this many ticks in a row
#define NKEYS 18

// Bit n of the key state is key id n + 1 for the 15 display keys; bits 15..17
// are the plain buttons 0x25, 0x30, 0x31.
//
// Idle rows are driven high, like the stock scan. The matrix has no diodes, so
// releasing them instead (tried) makes phantom keys appear; driving them high
// keeps phantoms out, at a price: with two keys held in one column the two rows
// fight through the shared column, and one of those keys can flicker or stay
// hidden until the other is released. Keys in one row are unaffected. See
// column_busy() for how the flicker is kept out of the reports.
static uint32_t read_keys(void) {
  uint32_t s = 0;
  for (int r = 0; r < 3; r++) {
    pin_write(PIN(r), 0);
    for (int c = 0; c < 5; c++)
      if (!pin_read(PIN(3 + c))) s |= 1u << (10 - 5 * r + c);
    pin_write(PIN(r), 1);
  }
  if (!pin_read(PIN(8))) s |= 1u << 15;
  if (!pin_read(PIN_PB11)) s |= 1u << 16;
  if (!pin_read(PIN(9))) s |= 1u << 17;
  return s;
}

// Without a diode per key, three keys on the corners of a rectangle can make
// the fourth read as pressed. The M18 has no diodes, but with idle rows driven
// high no phantoms showed up in testing, so this is off by default. Build with
// -DGHOST_FILTER to also ignore any scan where two rows share two or more columns.
#ifdef GHOST_FILTER
static int ghosted(uint32_t s) {
  uint32_t a = s & 31, b = (s >> 5) & 31, c = (s >> 10) & 31;
  uint32_t x = a & b, y = a & c, z = b & c;
  return (x & (x - 1)) | (y & (y - 1)) | (z & (z - 1));
}
#else
static int ghosted(uint32_t s) { (void)s; return 0; }
#endif

// True if another display key in the same column as bit k reads pressed. A
// held key is then not reported up: in this matrix that "up" is usually the
// column fight hiding it, not a release. It is reported once the column is
// clear, so a real release there arrives late rather than a false one early.
static int column_busy(uint32_t now, int k) {
  if (k >= 15) return 0;
  int c = k % 5;
  uint32_t col = (1u << c) | (1u << (c + 5)) | (1u << (c + 10));
  return (now & col & ~(1u << k)) != 0;
}

void rollover_thread(void *param) {
  (void)param;
  // Reports go out by DMA straight from these buffers, so they alternate: a
  // buffer is only rewritten after the endpoint has accepted the next one.
  // They come from the heap, allocated once and never freed, so this thread
  // needs no more stack than the stock one did.
  static const uint8_t header[8] = {'A', 'C', 'K', 0, 0, 'O', 'K', 0};
  uint8_t (*buf)[0x200] = 0;
  if (pin_read(PIN(8))) buf = rt_malloc(2 * 0x200);
  int safe = !buf;
  if (!safe) {
    memset(buf, 0, 2 * 0x200);
    for (int i = 0; i < 8; i++) buf[0][i] = buf[1][i] = header[i];
  }

  uint32_t stable = 0, last = 0;
  int cur = 0, same = 0;
  for (;;) {
    if (safe || MODE_AWAKE != 1 || MODE_HOST != 1) {
      stable = last = 0;
      same = 0;
      stock_scan();
      rt_thread_mdelay(30);
      continue;
    }
    uint32_t now = read_keys();
    // Debounce: act only on a state read the same on STABLE_READS ticks in a row.
    same = now == last ? same + (same < STABLE_READS) : 1;
    if (same >= STABLE_READS && !ghosted(now)) {
      for (int k = 0; k < NKEYS; k++) {
        uint32_t bit = 1u << k;
        if (!((now ^ stable) & bit)) continue;
        if ((stable & bit) && column_busy(now, k)) continue;  // up held back, see column_busy()
        uint8_t *q = buf[cur];
        q[9] = k < 15 ? k + 1 : k == 15 ? 0x25 : k + 0x20;
        q[10] = (now & bit) != 0;
        int tries = 0;
        while (hid_send(q, 0x200) == -2 && ++tries < 20) rt_thread_mdelay(1);
        if (tries == 20) break;  // host not reading: retry this key next tick
        stable ^= bit;
        cur ^= 1;
      }
    }
    last = now;
    rt_thread_mdelay(TICK_MS);
  }
}
