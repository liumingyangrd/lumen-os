'use strict';
// 调试工具：对比内核源码里的标签地址与镜像里实际编码出来的字节
const fs = require('fs');
const path = require('path');
const { assemble } = require('./x86asm.js');

const ROOT = path.join(__dirname, '..');
const img = fs.readFileSync(path.join(ROOT, 'dist', 'LumenOS-x86.iso'));
const kern = img.slice(23 * 2048 + 1032, 23 * 2048 + 1032 + 7000);

let src = fs.readFileSync(path.join(ROOT, 'src', 'x86', 'kgfx.s'), 'utf8');
src += '\nfonthead:\n    db 1,2,3\n';
const r = assemble(src);

for (const n of ['curx', 'cury', 'fgcol', 'bgcol', 'ascigly', 'fonthead']) {
  console.log('  ' + n.padEnd(9) + ' = 0x' + r.labels[n].toString(16));
}

// 找 mov word [curx],200 的编码：C7 06 <addr> C8 00
const pat = Buffer.from([0xC7, 0x06]);
let i = kern.indexOf(pat);
while (i >= 0 && i < 6000) {
  const addr = kern.readUInt16LE(i + 2);
  const imm = kern.readUInt16LE(i + 4);
  if (addr === r.labels.curx || addr === r.labels.cury) {
    console.log('  找到 mov word [' + (addr === r.labels.curx ? 'curx' : 'cury') + '],' + imm +
                '  编码 @' + i.toString(16) + ' 地址=0x' + addr.toString(16));
  }
  i = kern.indexOf(pat, i + 1);
}

// 找 add bx,[ascigly] → 03 1E <addr>
const j = kern.indexOf(Buffer.from([0x03, 0x1E]));
if (j >= 0) {
  console.log('  add bx,[ascigly] 编码地址=0x' + kern.readUInt16LE(j + 2).toString(16) +
              ' 标签=0x' + r.labels.ascigly.toString(16));
}
// 找 mov ax,[cury] → 8B 06 <addr>
const m = kern.indexOf(Buffer.from([0x8B, 0x06]));
if (m >= 0) {
  console.log('  mov ax,[x] 编码地址=0x' + kern.readUInt16LE(m + 2).toString(16) +
              ' (cury 标签=0x' + r.labels.cury.toString(16) + ')');
}
