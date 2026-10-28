'use strict';
// x86 引导扇区（16 位实模式）。
//   1. 切到 80x25 文本模式，把说明文字写进 0xB800 显存
//   2. 同样的文字再从 COM1 串口吐一遍 —— 客户机没装 Tools 截不了图，
//      但 serial.log 能证明它到底执行到了哪一条指令
//   3. 停机
//
// 机器码全部手工编码，没有汇编器、没有第三方库。

const VIDEO = 0xB800;
const ORIGIN = 0x7C00;
const IMAGE_SIZE = 4096;
const UART = 0x3F8;

function screenLines() {
  const L = new Array(25).fill('');
  const put = (row, col, text) => { L[row] = (L[row] || '').padEnd(col, ' ') + text; };
  const center = (row, text) => put(row, Math.max(0, Math.floor((80 - text.length) / 2)), text);

  center(2, 'L U M E N   O S   1 . 0');
  center(3, 'LUX-32 runtime - a self-built ISA hosted on x86');
  put(4, 0, ' ' + '-'.repeat(78));

  put(6, 2, 'THIS DISC BOOTED. LUX-32 MACHINE CODE RUNS ON THIS CPU NEXT.');
  put(7, 2, 'The kernel and tools on this disc target LUX-32, an instruction set');
  put(8, 2, 'written for this project - not x86. So this disc carries a runtime:');
  put(9, 2, 'the LUX-32 processor is emulated in software on top of your CPU.');

  put(11, 2, 'Interpreter status is mirrored to COM1: 115200 8N1.');
  put(12, 2, 'Full machine without emulation: open LUMENOS.HTM in a browser.');

  put(14, 2, 'On this disc:');
  put(15, 4, 'README.TXT   notes');
  put(16, 4, 'LUMENOS.HTM  the entire computer, one file');
  put(17, 4, 'LUMEN.LMI    the LUX-32 bootable image');
  put(18, 4, 'LUMEN.MAN    architecture manual');
  put(19, 4, 'SOURCE.ZIP   assembler, compiler, kernel, programs');

  put(21, 2, 'Drawn by hand-encoded x86 machine code in the El Torito boot image,');
  put(22, 2, 'then mirrored to the serial port for verification.');

  put(24, 2, 'BIOS boot stopped here on purpose. Ctrl+Alt+Del to restart.');
  return L;
}

function buildBootImage() {
  const text = screenLines().map((l) => l.padEnd(80, ' ').slice(0, 80)).join('');
  const payload = Buffer.from(text, 'ascii');

  const code = [];
  const labels = {};
  const p8 = [];
  const p16 = [];

  const b = (...v) => code.push(...v);
  const lab = (n) => { labels[n] = code.length; };
  const rel8 = (op, target) => { const p = code.length; b(op, 0); p8.push({ p, target, next: p + 2 }); };
  const near = (op, target) => { const p = code.length; b(op, 0, 0); p16.push({ p, target, next: p + 3 }); };
  const movSi = (target) => { const p = code.length; b(0xBE, 0, 0); p16.push({ p: p + 1, target, next: p + 3, abs: true }); };
  const movDx = (port) => b(0xBA, port & 0xFF, (port >> 8) & 0xFF);
  const movAl = (v) => b(0xB0, v & 0xFF);

  /* ---------- 进入文本模式 ---------- */
  b(0xFC);                                   // cld
  b(0xFB);                                   // sti
  b(0x31, 0xC0);                             // xor ax,ax
  b(0x8E, 0xD8);                             // mov ds,ax
  b(0xB8, 0x03, 0x00);                       // mov ax,3
  b(0xCD, 0x10);                             // int 10h

  /* ---------- 画屏：直接写显存 ---------- */
  b(0xB8, VIDEO & 0xFF, (VIDEO >> 8) & 0xFF); // mov ax,0xB800
  b(0x8E, 0xC0);                             // mov es,ax
  b(0x31, 0xFF);                             // xor di,di
  movSi('screen');
  b(0xB4, 0x0A);                             // mov ah,0x0A   亮绿
  lab('vloop');
  b(0xAC);                                   // lodsb
  b(0x84, 0xC0);                             // test al,al
  rel8(0x74, 'vdone');                       // jz
  b(0xAB);                                   // stosw
  rel8(0xEB, 'vloop');                       // jmp
  lab('vdone');

  /* ---------- COM1 初始化：115200 8N1，无中断 ---------- */
  movDx(UART + 3); movAl(0x80); b(0xEE);     // LCR = DLAB
  movDx(UART + 0); movAl(0x01); b(0xEE);     // DLL = 1
  movDx(UART + 1); movAl(0x00); b(0xEE);     // DLM = 0
  movDx(UART + 3); movAl(0x03); b(0xEE);     // 8N1
  movDx(UART + 2); movAl(0xC7); b(0xEE);     // FCR
  movDx(UART + 1); movAl(0x00); b(0xEE);     // IER = 0

  /* ---------- 握手串 ---------- */
  movSi('tag');
  near(0xE8, 'puts');

  /* ---------- 把 2000 字节屏幕转储到串口 ---------- */
  movSi('screen');
  b(0xB9, 0xD0, 0x07);                       // mov cx,2000
  lab('dloop');
  b(0x8A, 0x04);                             // mov al,[si]
  b(0x46);                                   // inc si
  near(0xE8, 'sc');
  b(0x49);                                   // dec cx
  rel8(0x75, 'dloop');                       // jnz
  movSi('endtag');
  near(0xE8, 'puts');

  lab('halt');
  b(0xEB, 0xFE);                             // jmp $

  /* ---------- puts：DS:SI 起、以 0 结尾 ---------- */
  lab('puts');
  b(0xAC);                                   // lodsb
  b(0x84, 0xC0);                             // test al,al
  rel8(0x74, 'puts_done');
  near(0xE8, 'sc');
  rel8(0xEB, 'puts');
  lab('puts_done');
  b(0xC3);                                   // ret

  /* ---------- sc：把 AL 送 COM1 ---------- */
  lab('sc');
  b(0x50);                                   // push ax
  b(0x52);                                   // push dx
  lab('sc_wait');
  movDx(UART + 5);                           // LSR
  b(0xEC);                                   // in al,dx
  b(0xA8, 0x20);                             // test al,0x20
  rel8(0x74, 'sc_wait');                     // jz
  b(0x5A);                                   // pop dx
  b(0x58);                                   // pop ax
  movDx(UART + 0);                           // THR
  b(0xEE);                                   // out dx,al
  b(0xC3);                                   // ret

  const codeSize = code.length;
  labels.screen = codeSize;
  labels.tag = codeSize + payload.length;
  labels.endtag = codeSize + payload.length + 8;

  const resolve = (e) => {
    const t = labels[e.target];
    if (t === undefined) throw new Error('未定义标签 ' + e.target);
    if (e.abs) return ORIGIN + t;
    return t - e.next;
  };
  for (const e of p8) {
    const d = resolve(e);
    if (d < -128 || d > 127) throw new Error('短跳转越界: ' + e.target);
    code[e.p + 1] = d & 0xFF;
  }
  for (const e of p16) {
    const d = resolve(e);
    if (e.abs) {
      code[e.p] = d & 0xFF;
      code[e.p + 1] = (d >> 8) & 0xFF;
    } else {
      code[e.p + 1] = d & 0xFF;
      code[e.p + 2] = (d >> 8) & 0xFF;
    }
  }

  const image = Buffer.alloc(IMAGE_SIZE, 0);
  Buffer.from(code).copy(image, 0);
  payload.copy(image, codeSize);
  Buffer.from('00-LUMEN-OS-END\r\n', 'ascii').copy(image, codeSize + payload.length);

  const total = codeSize + payload.length + 17;
  if (total > IMAGE_SIZE) throw new Error('引导映像超出 ' + IMAGE_SIZE + ' 字节 (需要 ' + total + ')');

  return { image, codeSize, total, screenAt: ORIGIN + codeSize };
}

module.exports = { buildBootImage, screenLines, IMAGE_SIZE };
