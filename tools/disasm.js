'use strict';
// x86 汇编结果的简易反汇编器（16 位实模式子集），用于排查自己的汇编器 bug。
// 用法: node tools/disasm.js src/x86/kmain.s [标签名] [字节数]
const fs = require('fs');
const path = require('path');
const { assemble } = require('./x86asm.js');

const R16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di'];
const R8 = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];
const ARITH = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
const JCC = { 0x84: 'je', 0x85: 'jne', 0x82: 'jb', 0x83: 'jae', 0x8C: 'jl', 0x8D: 'jge', 0x8E: 'jle', 0x8F: 'jg' };

function disasm(buf, from, len, org) {
  const out = [];
  let p = from;
  const u8 = () => buf[p++];
  // 解析 ModRM 的 r/m 部分，返回内存操作数文本
  const memTarget = (m) => {
    const mod = (m >> 6) & 3;
    const rm = m & 7;
    if (mod === 3) return null;                 // 寄存器形式
    if (mod === 0) {
      if (rm === 4) return '[si]';
      if (rm === 5) return '[di]';
      if (rm === 6) return '[0x' + u16().toString(16) + ']';
      if (rm === 7) return '[bx]';
      return '[bx+si]';
    }
    if (mod === 1) { const d = u8(); return '[bx+si+' + (d > 127 ? d - 256 : d) + ']'; }
    const d = u16(); return '[bx+si+' + (d > 32767 ? d - 65536 : d) + ']';
  };
  const u16 = () => { const v = buf.readUInt16LE(p); p += 2; return v; };
  const i16 = () => { const v = buf.readInt16LE(p); p += 2; return v; };
  while (p < from + len) {
    const at = p;
    const op = u8();
    let s;
    if (op >= 0xB0 && op <= 0xB7) s = `mov ${R8[op - 0xB0]}, 0x${u8().toString(16)}`;
    else if (op >= 0xB8 && op <= 0xBF) s = `mov ${R16[op - 0xB8]}, 0x${u16().toString(16)}`;
    else if (op === 0x8A || op === 0x8B || op === 0x88 || op === 0x89) {
      const m = u8();
      const t = memTarget(m);
      const is8 = (op === 0x8A || op === 0x88);
      const R = is8 ? R8 : R16;
      const reg = R[(m >> 3) & 7], rm = R[m & 7];
      if (op === 0x8A) s = `mov ${reg}, ${t || rm}`;
      else if (op === 0x8B) s = `mov ${reg}, ${t || rm}`;
      else if (op === 0x88) s = `mov ${t || rm}, ${reg}`;
      else s = `mov ${t || rm}, ${reg}`;
    }
    else if (op === 0x80) { const m = u8(); s = `${ARITH[m >> 3]} ${R8[m & 7]}, 0x${u8().toString(16)}`; }
    else if (op === 0x81) { const m = u8(); s = `${ARITH[m >> 3]} ${R16[m & 7]}, 0x${u16().toString(16)}`; }
    else if (op === 0x3C) s = `cmp al, 0x${u8().toString(16)}`;
    else if (op === 0x3D) s = `cmp ax, 0x${u16().toString(16)}`;
    else if (op === 0x04) s = `add al, 0x${u8().toString(16)}`;
    else if (op === 0x2C) s = `sub al, 0x${u8().toString(16)}`;
    else if (op === 0x24) s = `and al, 0x${u8().toString(16)}`;
    else if (op === 0x0F) {
      const op2 = u8();
      const t = i16();
      if (JCC[op2]) s = `${JCC[op2]} -> 0x${(org + p + t).toString(16)}`;
      else s = `db 0x0f ${op2.toString(16)}`;
    } else if (op === 0xE8) { const t = i16(); s = `call -> 0x${(org + p + t).toString(16)}`; }
    else if (op === 0xE9) { const t = i16(); s = `jmp -> 0x${(org + p + t).toString(16)}`; }
    else if (op === 0xEB) { const t = (u8() << 24) >> 24; s = `jmp short -> 0x${(org + p + t).toString(16)}`; }
    else if (op === 0x84 || op === 0x85) {
      const m = u8(); const t = memTarget(m);
      const R = (op === 0x84) ? R8 : R16;
      s = `test ${R[(m >> 3) & 7]}, ${t || R[m & 7]}`;
    }
    else if (op === 0xFE) { const m = u8(); s = `${(m >> 3) === 0 ? 'inc' : 'dec'} ${R8[m & 7]}`; }
    else if (op === 0x31 || op === 0x21 || op === 0x09 || op === 0x01 || op === 0x29 || op === 0x39) {
      const m = u8(); const t = memTarget(m);
      const dg = { 0x31: 'xor', 0x21: 'and', 0x09: 'or', 0x01: 'add', 0x29: 'sub', 0x39: 'cmp' }[op];
      s = `${dg} ${R16[(m >> 3) & 7]}, ${t || R16[m & 7]}`;
    }
    else if (op === 0x83) { const m = u8(); const t = memTarget(m); const dg = ['add','or','adc','sbb','and','sub','xor','cmp'][m >> 3]; s = `${dg} ${t || R16[m & 7]}, ${u8()}`; }
    else if (op >= 0x30 && op <= 0x37) { const m = u8(); s = `xor ${R8[m & 7]}, ${R8[(m >> 3) & 7]}`; }
    else if (op >= 0x40 && op <= 0x47) s = `inc ${R16[op - 0x40]}`;
    else if (op >= 0x48 && op <= 0x4F) s = `dec ${R16[op - 0x48]}`;
    else if (op >= 0x50 && op <= 0x57) s = `push ${R16[op - 0x50]}`;
    else if (op >= 0x58 && op <= 0x5F) s = `pop ${R16[op - 0x58]}`;
    else if (op === 0xAC) s = 'lodsb';
    else if (op === 0xAA) s = 'stosb';
    else if (op === 0xD1) { const m = u8(); s = `shl/shr ${R16[m & 7]} (${(m >> 3) === 4 ? 'shl' : 'shr'})`; }
    else if (op === 0xC1) { const m = u8(); const c = u8(); s = `${(m >> 3) === 4 ? 'shl' : 'shr'} ${R16[m & 7]}, ${c}`; }
    else if (op === 0xF7) { const m = u8(); s = `div ${R16[m & 7]}`; }
    else if (op === 0xCD) s = `int 0x${u8().toString(16)}`;
    else if (op === 0xEC) s = 'in al, dx';
    else if (op === 0xEE) s = 'out dx, al';
    else if (op === 0xFA) s = 'cli';
    else if (op === 0xFB) s = 'sti';
    else if (op === 0xFC) s = 'cld';
    else if (op === 0x90) s = 'nop';
    else if (op === 0xF4) s = 'hlt';
    else if (op === 0xC3) s = 'ret';
    else if (op === 0x8E) { const m = u8(); const sg = ['es', 'cs', 'ss', 'ds'][(m >> 3) & 3]; s = `mov ${sg}, ${R16[m & 7]}`; }
    else if (op === 0x8C) { const m = u8(); const sg = ['es', 'cs', 'ss', 'ds'][(m >> 3) & 3]; s = `mov ${R16[m & 7]}, ${sg}`; }
    else s = `db 0x${op.toString(16)}`;
    out.push(`0x${(org + at).toString(16).padStart(5, '0')}:  ${s}`);
  }
  return out;
}

const src = process.argv[2] || 'src/x86/kmain.s';
const label = process.argv[3] || 'putc';
const len = parseInt(process.argv[4] || '60', 10);
const r = assemble(fs.readFileSync(path.join(__dirname, '..', src), 'utf8'));
const buf = Buffer.from(r.code);
const org = 0x7C00;
const start = r.labels[label] - org;
if (start === undefined) { console.error('没有这个标签:', label); process.exit(1); }
console.log(disasm(buf, start, len, org).join('\n'));
