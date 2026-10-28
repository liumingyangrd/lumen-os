const path = require('path');
const R = p => require(path.join(__dirname, '..', 'tools', p));
const { assemble } = R('asm.js');
const { compile } = R('cc.js');
const { Machine } = R('vm.js');

const src = `
int out[8];

int fib(int n) {
  if (n < 2) return n;
  return fib(n-1) + fib(n-2);
}

int main() {
  int i;
  int s;
  out[0] = fib(10);
  s = 0;
  for (i = 0; i < 6; i = i + 1) { s = s + i; }
  out[1] = s;
  out[2] = 100 / 7;
  out[3] = 100 % 7;
  out[4] = 1 << 10;
  out[5] = (3 > 2) + (2 > 3) * 10;
  char *p = "lumen";
  out[6] = p[1];
  int a = 40;
  a += 2;
  out[7] = a;
  return 0;
}
`;
const asm = compile(src);
console.log('--- 生成的汇编 (前 40 行) ---');
console.log(asm.split('\n').slice(0, 40).join('\n'));
const img = assemble(asm, { base: 0x400000 });
const m = new Machine();
m.mem.set(img.code, img.base);
m.pc = img.entry; m.r[11] = 0x500000;
m.run(500000);
console.log('\ndead?', m.dead, m.fault);
const outAddr = img.symbols['out'];
const vals = [];
for (let i = 0; i < 8; i++) vals.push(m.rd32(outAddr + i * 4));
console.log('out =', vals);
console.log('期望 = [55, 15, 14, 2, 1024, 1, 117, 42]');
