const {assemble}=require('../tools/x86asm.js');
const src = [
  'org 0x100',
  'buf: resb 4',
  'x:',
  ' mov dl, [es:di]',
  ' mov [bx], dl',
  ' mov al, [si]',
  ' mov [bx], al',
  ' mov ah, [si]',
  ' shl al, 1',
  ' test ah, 0x80',
  ' mul dx',
  ' rol?? no',
].filter(l=>!l.includes('??')).join('\n');
const r=assemble(src);
console.log([...r.code].map(b=>b.toString(16).padStart(2,'0')).join(' '));
console.log('期望: 26 8a 15 | 88 17 | 8a 04 | 88 07 | 8a 24 | d0 e0 | f6 c4 80 | f7 e2');
