/*
 * Places rollover.c in firmware V3.VSDM18_HXJDF.02.020, over code the patch
 * makes unused (0x40245f2e..0x4024615c, 558 bytes):
 *   0x40245f2e  the stock scan's normal-mode tail for the three rows (the
 *               patch retargets the three branches into it)
 *   0x40245ff8  the plain-button routine (only called from the thread entry)
 *   0x40246120  the stock thread entry (only referenced by thread create)
 */
memset           = 0x40211aa8;
rt_malloc        = 0x40223326;
rt_thread_mdelay = 0x40221bb4;
hid_send         = 0x4023d666;
stock_scan       = 0x40245c34;
pin_write        = 0x402465fc;
pin_read         = 0x40246622;

ENTRY(rollover_thread)
MEMORY { cave (rx) : ORIGIN = 0x40245f2e, LENGTH = 558 }
SECTIONS {
  .text : {
    KEEP(*(.text.rollover_thread))
    *(.text .text.* .rodata .rodata.* .srodata .srodata.*)
  } > cave
  /* Code only: any data or bss would have nowhere to live, so fail instead. */
  .data : { *(.data .data.* .sdata .sdata.* .bss .bss.* .sbss .sbss.*) } > cave
  ASSERT(SIZEOF(.data) == 0, "rollover.c must not use writable globals")
  /DISCARD/ : { *(.comment .riscv.attributes .eh_frame .eh_frame_hdr) }
}
