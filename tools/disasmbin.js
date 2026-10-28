'use strict';
// 对构建产物（ISO 里的内核映像）做反汇编，用法：
//   node tools/disasmbin.js <标签> [字节数]
// 直接读 dist/LumenOS-x86.iso 的 El Torito 引导映像。

const fs = require('fs');
const path = require('path');
const { assemble } = require('./x86asm.js');

const ROOT = path.join(__dirname, '..');
const img = fs.readFileSync(path.join(ROOT, 'dist', 'LumenOS-x86.iso'));

// El Torito 引导映像在 ISO LBA 23（构建脚本固定）
const BOOT_LBA = 23;
const disk = img.slice(BOOT_LBA * 2048, BOOT_LBA * 2048 + 64 * 1024);
// 磁盘映像：0 扇区 stage1，2 扇区起 payload（8 字节头 + 内核）
const kernel = disk.slice(2 * 512 + 8);

let src = fs.readFileSync(path.join(ROOT, 'src', 'x86', 'kgfx.s'), 'utf8');
src += '\nfonthead:\n    db 1,2,3\n';
const r = assemble(src);

const label = process.argv[2] || 'draw_text';
const len = parseInt(process.argv[3] || '120', 10);
const addr = r.labels[label];
if (addr === undefined) { console.error('没有这个标签:', label); process.exit(1); }

const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const R8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const JCC = { 0x74: 'je', 0x75: 'jne', 0x7C: 'jl', 0x7D: 'jge', 0x7E: 'jle', 0x7F: 'jg',
  0x72: 'jb', 0x73: 'jae', 0x76: 'jbe', 0x77: 'ja', 0x78: 'js', 0x79: 'jns' };

function disasm(buf, from, len) {
  const out = [];
  let p = from;
  const u8 = () => buf[p++];
  const u16 = () => { const v = buf[p] | (buf[p + 1] << 8); p += 2; return v; };
  const s8 = () => { const v = (buf[p] << 24) >> 24; p += 1; return v; };
  const mem = (m) => {
    const mod = (m >> 6) & 3, reg = (m >> 3) & 7, rm = m & 7;
    if (mod === 3) return R8[rm];      // 寄存器形式
    let txt = '[';
    if (mod === 0) {
      if (rm === 6) txt += '0x' + u16().toString(16);
      else if (rm === 4) txt += 'si';
      else if (rm === 5) txt += 'di';
      else if (rm === 3) txt += 'bx';
      else txt += 'bx+si';
    } else {
      const d = mod === 1 ? s8() : u16();
      const base = { 0: 'bx+si', 1: 'bx+di', 2: 'bp+si', 3: 'bp+di', 4: 'si', 5: 'di', 6: 'bp', 7: 'bx' }[rm];
      txt += base + (d ? (d > 0 ? '+' + d : String(d)) : '');
    }
    txt += ']';
    return txt + ', ' + R8[reg];
  };
  const start = p;
  while (p - start < len) {
    const at = p;
    const op = u8();
    let s = 'db 0x' + op.toString(16);
    if (op === 0x88) s = 'mov ' + mem(u8());
    else if (op === 0x89) { const m = u8(); s = 'mov ' + R16[(m >> 3) & 7] + ', ' + mem(m); }
    else if (op === 0x8A) { const m = u8(); const r8 = R8[m & 7]; s = 'mov ' + r8 + ', ' + mem(m); }
    else if (op === 0x8B) { const m = u8(); s = 'mov ' + R16[(m >> 3) & 7] + ', ' + mem(m); }
    else if (op === 0xBE) s = 'mov si, 0x' + u16().toString(16);
    else if (op === 0xBF) s = 'mov di, 0x' + u16().toString(16);
    else if (op === 0xB8) s = 'mov ' + R16[0] + ', 0x' + u16().toString(16);
    else if (op === 0xBB) s = 'mov bx, 0x' + u16().toString(16);
    else if (op === 0xB9) s = 'mov cx, 0x' + u16().toString(16);
    else if (op === 0xBA) s = 'mov dx, 0x' + u16().toString(16);
    else if (op === 0xB0) s = 'mov ' + R8[op - 0xB0] + ', 0x' + u8().toString(16);
    else if (op === 0xB7) s = 'mov bh, 0x' + u8().toString(16);
    else if (op === 0xB4) s = 'mov ah, 0x' + u8().toString(16);
    else if (op === 0x31) s = 'xor ' + R16[u8() & 7] + ', ' + R16[(u8() >> 3) & 7];
    else if (op === 0x33) { const m = u8(); s = 'xor ' + R16[(m >> 3) & 7] + ', ' + mem(m); }
    else if (op === 0x03) { const m = u8(); s = 'add ' + R16[(m >> 3) & 7] + ', ' + mem(m); }
    else if (op === 0x01) { const m = u8(); s = 'add ' + mem(m) + ', ' + R16[(m >> 3) & 7]; }
    else if (op === 0x2B) { const m = u8(); s = 'sub ' + R16[(m >> 3) & 7] + ', ' + mem(m); }
    else if (op === 0x29) { const m = u8(); s = 'sub ' + mem(m) + ', ' + R16[(m >> 3) & 7]; }
    else if (op === 0x81) { const m = u8(); s = 'op' + ((m >> 3) & 7) + ' ' + R16[m & 7] + ', 0x' + u16().toString(16); }
    else if (op === 0xC7) { const m = u8(); s = 'mov word ' + mem(m) + ', 0x' + u16().toString(16); }
    else if (op === 0xC6) { const m = u8(); s = 'mov byte ' + mem(m) + ', 0x' + u8().toString(16); }
    else if (op === 0x3C) s = 'cmp al, 0x' + u8().toString(16);
    else if (op === 0x3D) s = 'cmp ax, 0x' + u16().toString(16);
    else if (op === 0x84) s = 'test ' + mem(u8());
    else if (op === 0x85) s = 'test ' + R16[(u8() >> 3) & 7] + ', ' + R16[u8() & 7];
    else if (op === 0xA8) s = 'test al, 0x' + u8().toString(16);
    else if (op === 0xA9) s = 'test ax, 0x' + u16().toString(16);
    else if (op === 0xD0) { const m = u8(); const r8 = R8[m & 7]; const c = u8(); s = 'shl ' + r8 + ', ' + c; }
    else if (op === 0xD1) { const m = u8(); const c = u8(); s = 'shl ' + R16[m & 7] + ', ' + c; }
    else if (op === 0xD3) { const m = u8(); const c = u8(); s = 'shr ' + R16[m & 7] + ', ' + c; }
    else if (op === 0xD2) { const m = u8(); const c = u8(); s = 'sar ' + R16[m & 7] + ', ' + c; }
    else if (op === 0xFE) { const m = u8(); const c = u8(); s = 'inc/dec byte ' + R8[m & 7] + ', ' + c; }
    else if (op === 0xFF) { const m = u8(); s = 'inc/dec/call/jmp ' + mem(m); }
    else if (op === 0xE8) { const d = s8(); s = 'call 0x' + (0x8000 + p + d).toString(16); }
    else if (op === 0xE9) { const d = s8(); s = 'jmp 0x' + (0x8000 + p + d).toString(16); }
    else if (op === 0xEB) { const d = s8(); s = 'jmp short 0x' + (0x8000 + p + d).toString(16); }
    else if (op === 0xEA) { const o = u16(), sg = u16(); s = 'jmp 0x' + sg.toString(16) + ':' + o.toString(16); }
    else if (op === 0xE2) { const d = s8(); s = 'loop 0x' + (0x8000 + p + d).toString(16); }
    else if (op === 0x74 || op === 0x75 || op === 0x7C || op === 0x7D || op === 0x7E || op === 0x7F ||
             op === 0x72 || op === 0x73 || op === 0x76 || op === 0x77) { const d = s8(); s = JCC[op] + ' 0x' + (0x8000 + p + d).toString(16); }
    else if (op >= 0x70 && op <= 0x7F) { const d = s8(); s = JCC[op] + ' 0x' + (0x8000 + p + d).toString(16); }
    else if (op === 0x0F) { const op2 = u8(); const d = s8(); s = 'j' + (JCC[op2 - 0x10] || 'cc') + ' 0x' + (0x8000 + p + d).toString(16); }
    else if (op >= 0x50 && op <= 0x57) s = 'push ' + R16[op - 0x50];
    else if (op >= 0x58 && op <= 0x5F) s = 'pop ' + R16[op - 0x58];
    else if (op === 0x8E) { const m = u8(); s = 'mov ' + ['es', 'cs', 'ss', 'ds'][(m >> 3) & 3] + ', ' + R16[m & 7]; }
    else if (op === 0xEC) s = 'in al, dx';
    else if (op === 0xEE) s = 'out dx, al';
    else if (op === 0xCD) s = 'int 0x' + u8().toString(16);
    else if (op === 0xAC) s = 'lodsb';
    else if (op === 0xAA) s = 'stosb';
    else if (op === 0xA4) s = 'movsb';
    else if (op === 0xA5) s = 'movsw';
    else if (op === 0xF3) { const o = u8(); s = (o === 0xA4 ? 'rep movsb' : o === 0xAA ? 'rep stosb' : 'rep ?'); }
    else if (op === 0xFC) s = 'cld';
    else if (op === 0xFD) s = 'std';
    else if (op === 0xF8) s = 'clc';
    else if (op === 0xF9) s = 'stc';
    else if (op === 0xFB) s = 'sti';
    else if (op === 0xFA) s = 'cli';
    else if (op === 0xC3) s = 'ret';
    else if (op === 0x90) s = 'nop';
    else if (op === 0xF4) s = 'hlt';
    else if (op === 0xF7) { const m = u8(); s = 'mul/div ' + R16[m & 7]; }
    else if (op === 0xF6) { const m = u8(); s = 'mul/div ' + R8[m & 7]; }
    else if (op === 0xFE) s = 'inc/dec byte';
    else if (op === 0x8E) s = 'mov seg';
    else if (op === 0x26 || op === 0x2E || op === 0x36 || op === 0x3E) s = 'seg prefix 0x' + op.toString(16);
    out.push('0x' + (0x8000 + at).toString(16) + ':  ' + s);
  }
  return out;
}

console.log(disasm(kernel, addr - 0x8000, len).join('\n'));
