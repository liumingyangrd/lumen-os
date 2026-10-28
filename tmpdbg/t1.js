'use strict';
const { assemble } = require('../tools/x86asm.js');
const fs = require('fs');
const path = require('path');

const src = [
  'org 0x100',
  'cjkmap: dw 0',
  'cjkcount: dw 0',
  'x:',
  '    mov di, [cjkmap]',
  '    mov cx, [cjkcount]',
  '    mov bx, 0',
  ''
].join('\n');
const r = assemble(src);
console.log('最小用例输出:', [...r.code].map(b => b.toString(16).padStart(2, '0')).join(' '));
console.log('期望:        8b 1e 00 10 8b 0e 02 10 bb 00 00');

// 再看真实源码里 find_cjk 那几行的原始字节
const p = path.join(__dirname, '..', 'src', 'x86', 'kgfx.s');
const lines = fs.readFileSync(p, 'utf8').split('\n');
for (let i = 610; i < 620; i++) {
  console.log((i + 1) + ': ' + JSON.stringify(lines[i]));
}
