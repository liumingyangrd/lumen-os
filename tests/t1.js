const path = require('path');
const R = p => require(path.join(__dirname, '..', 'tools', p));
const { assemble } = R('asm.js');
const { Machine } = R('vm.js');

const src = `
.org 0x1000
.entry start
start:
  ldi r0, 0xB8000
  ldi r1, 72
  stb [r0+0], r1
  ldi r1, 105
  stb [r0+2], r1
  ldi r1, 0x1F
  stb [r0+1], r1
  stb [r0+3], r1
  ldi r11, 0x2000
  ldi r2, 0
  ldi r3, 3
loop:
  add r2, r2, r3
  addi r3, r3, -1
  ldi r9, 0
  cmp r3, r9
  jg loop
  push r2
  pop r4
  hlt
`;
const img = assemble(src, { base: 0x1000 });
console.log('code bytes', img.size, 'entry 0x' + img.entry.toString(16), 'relocs', img.relocs);
const m = new Machine();
m.mem.set(img.code, img.base);
m.pc = img.entry; m.r[11] = 0x2000;
m.run(10000);
console.log('dead?', m.dead, m.fault);
console.log('r2 =', m.r[2], 'r4 =', m.r[4], 'r3 =', m.r[3]);
console.log('screen[0] =', JSON.stringify(m.screenText().split('\n')[0]));
