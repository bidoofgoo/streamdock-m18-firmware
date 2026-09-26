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
// or a failed buffer allocation, runs only the stock scan, forever. The three
// plain buttons do not report then, but the display keys work as stock and,
// more to the point, so does the host connection, so a restore can be run.
//
// Original code. Every vendor address it uses is listed in rollover.ld.
//
#include <stdint.h>

void *memset(void *s, int c, unsigned n);
void *rt_malloc(unsigned size);
void rt_thread_mdelay(int ms);
int hid_send(void *buf, int len);          // -2 while the endpoint is busy
void pin_write(const char *name, int level);
int pin_read(const char *name);
void stock_scan(void);

#define MODE_AWAKE (*(volatile uint8_t *)0x402b7475)
#define MODE_HOST (*(volatile uint32_t *)0x402b7478)

// The firmware's pin name strings sit 8 bytes apart: rows PC.0 PB.2 PB.1,
// columns PC.5..PC.1, then PA.8 and PE.11. PB.11 lives elsewhere.
#define PIN(i) ((const char *)(0x40297020 + 8 * (i)))
#define PIN_PB11 ((const char *)0x40293d6c)

#define TICK_MS 10
#define NKEYS 18

// Bit n of the key state is key id n + 1 for the 15 display keys; bits 15..17
// are the plain buttons 0x25, 0x30, 0x31.
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

// Without a diode per key, three keys on the corners of a rectangle make the
// fourth read as pressed. The M18 tested (02.020, HXJDF) shows no such ghosts,
// so this is off by default. Build with -DGHOST_FILTER for a board without
// diodes: a scan where two rows share two or more columns is then ignored.
#ifdef GHOST_FILTER
static int ghosted(uint32_t s) {
  uint32_t a = s & 31, b = (s >> 5) & 31, c = (s >> 10) & 31;
  uint32_t x = a & b, y = a & c, z = b & c;
  return (x & (x - 1)) | (y & (y - 1)) | (z & (z - 1));
}
#else
static int ghosted(uint32_t s) { (void)s; return 0; }
#endif

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
  int cur = 0;
  for (;;) {
    if (safe || MODE_AWAKE != 1 || MODE_HOST != 1) {
      stable = last = 0;
      stock_scan();
      rt_thread_mdelay(30);
      continue;
    }
    uint32_t now = read_keys();
    // Debounce: act only on a state read the same on two ticks in a row.
    if (now == last && !ghosted(now)) {
      for (int k = 0; k < NKEYS; k++) {
        uint32_t bit = 1u << k;
        if (!((now ^ stable) & bit)) continue;
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
