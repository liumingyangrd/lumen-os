const {assemble}=require('../tools/x86asm.js');
const src = ['org 0x100','x:',' mov ah, 0x02',' int 0x1A',' jc fail',' mov word [curx], 262','fail:',' ret'].join('\n');
const r=assemble(src);
console.log([...r.code].map(b=>b.toString(16).padStart(2,'0')).join(' '));
console.log('期望: b4 02 cd 1a 72 01 c7 06 26 01 ... c3');
