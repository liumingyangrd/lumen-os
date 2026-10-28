'use strict';
// x86 汇编器的机器码回归测试
//
// 期望值按 Intel 手册的 ModRM 规则手工推导：
//   mod=11(寄存器形式) 时，ModRM = 0xC0 | (reg<<3) | rm
//   reg 字段 = 寄存器操作数，rm 字段 = 内存操作数或第二个寄存器
//
// 这份用例是汇编器的"契约"。任何一条不匹配都必须修编译器，
// 而不是改期望值。

const fs = require('fs');
const path = require('path');
const { assemble } = require('./x86asm.js');

const CASES = [
  // ---- mov 立即数 ----
  ['mov al, 0xAB', 'b0 ab'],
  ['mov cl, 0x12', 'b1 12'],
  ['mov ah, 0x09', 'b4 09'],
  ['mov bh, 0x05', 'b7 05'],
  ['mov ax, 0x1234', 'b8 34 12'],
  ['mov bx, 0x8000', 'bb 00 80'],
  ['mov cx, 0x8100', 'b9 00 81'],
  ['mov si, 0x7C00', 'be 00 7c'],

  // ---- mov 寄存器↔寄存器（8 位：modrm = C0|(dst<<3)|src）----
  ['mov bh, al', '88 c7'],   // reg=bh(7) rm=al(0)
  ['mov bl, al', '88 c3'],   // reg=bl(3) rm=al(0)
  ['mov al, bl', '88 d8'],   // reg=al(0) rm=bl(3)
  ['mov al, bh', '88 f8'],   // reg=al(0) rm=bh(7)
  ['mov cl, dl', '88 d1'],   // reg=cl(1) rm=dl(2)
  ['mov ah, 9', 'b4 09'],

  // ---- mov 寄存器↔寄存器（16 位）----
  ['mov dx, cx', '89 ca'],   // reg=dx(2) rm=cx(1)
  ['mov ax, bx', '89 d8'],   // reg=ax(0) rm=bx(3)
  ['mov bx, ax', '89 c3'],   // reg=bx(3) rm=ax(0)
  ['mov si, di', '89 fe'],   // reg=si(6) rm=di(7)
  ['mov dx, dx', '89 d2'],

  // ---- mov 绝对寻址（modrm = (reg<<3)|110 + 16 位地址）----
  ['mov dx, [0x8000]', '8b 16 00 80'],   // reg=dx(2)
  ['mov ax, [0x8000]', '8b 06 00 80'],   // reg=ax(0)
  ['mov [0x8000], dx', '89 16 00 80'],   // reg=dx(2)
  ['mov [0x8000], ax', '89 06 00 80'],   // reg=ax(0)
  ['mov al, [0x8100]', '8a 06 00 81'],   // 8 位
  ['mov [0x8100], al', '88 06 00 81'],

  // ---- mov 间接寻址（mod=00, rm=100/101/111）----
  ['mov al, [si]', '8a 04'],   // rm=si(4)
  ['mov al, [di]', '8a 05'],   // rm=di(5)
  ['mov ax, [bx]', '8b 07'],   // rm=bx(7)
  ['mov [si], al', '88 04'],
  ['mov [bx], ax', '89 07'],

  // ---- mov 带位移的间接寻址（mod=01 + disp8）----
  ['mov dx, [si+2]', '8b 54 02'],   // mod=01 reg=dx(2) rm=si(4)
  ['mov ax, [bx+4]', '8b 47 04'],   // mod=01 reg=ax(0) rm=bx(7)
  ['mov al, [di+1]', '8a 45 01'],   // mod=01 reg=al(0) rm=di(5)
  ['mov [si+5], ax', '89 44 05'],   // mod=01 reg=ax(0) rm=si(4)
  ['mov [di+3], al', '88 45 03'],

  // ---- 算术：reg,[mem] 用 r/m 形式（rm=基址，reg=寄存器）----
  ['cmp al, [di]', '3a 05'],        // 3A /r
  ['cmp ax, [bx+4]', '3b 47 04'],   // 3B /r
  ['add ax, [si]', '03 04'],        // 03 /r
  ['and al, [bx]', '20 07'],        // 20 /r
  ['or al, [si]', '08 04'],
  ['xor ax, [bx]', '33 07'],

  // ---- 算术：寄存器↔寄存器 ----
  ['xor ax, ax', '31 c0'],
  ['xor dx, dx', '31 d2'],
  ['sub ax, bx', '29 d8'],
  ['add ax, bx', '01 d8'],
  ['cmp al, 10', '3c 0a'],
  ['cmp ax, 0x1234', '3d 34 12'],
  ['and al, 0x0F', '24 0f'],
  ['or al, 0x30', '0c 30'],
  ['xor al, 0xFF', '34 ff'],

  // ---- 位操作 ----
  ['shr bl', 'd0 eb'],   // D0 /5
  ['shl bh', 'd0 e7'],   // D0 /4
  ['shr ax', 'd1 e8'],   // D1 /5
  ['shl bx', 'd1 e3'],   // D1 /4

  // ---- 段寄存器 ----
  ['push ds', '1e'],
  ['pop es', '07'],
  ['push es', '06'],
  ['pop ds', '1f'],

  // ---- 端口与控制 ----
  ['in al, dx', 'ec'],
  ['out dx, al', 'ee'],

  // ---- 杂项 ----
  ['div bx', 'f7 f3'],
  ['nop', '90'],
  ['cld', 'fc'],
  ['sti', 'fb'],
  ['cli', 'fa'],
  ['hlt', 'f4'],
  ['lodsb', 'ac'],
  ['stosb', 'aa'],
  ['movsb', 'a4'],
  ['movsw', 'a5'],
  ['int 0x10', 'cd 10'],
  ['inc ax', '40'],
  ['inc cx', '41'],
  ['inc di', '47'],
  ['dec ax', '48'],
  ['dec cx', '49'],
  ['push ax', '50'],
  ['push bx', '53'],
  ['pop ax', '58'],
  ['pop bx', '5b'],
  ['ret', 'c3'],
];

function run() {
  const tmp = path.join(__dirname, '..', 'tests', '.regcase.s');
  let bad = 0;
  for (const [src, want] of CASES) {
    fs.writeFileSync(tmp, 'org 0x7C00\n' + src + '\n');
    let got;
    try {
      const r = assemble(fs.readFileSync(tmp, 'utf8'));
      got = r.code.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    } catch (e) {
      got = 'ERROR: ' + e.message;
    }
    if (got !== want) {
      bad++;
      console.log('FAIL  ' + src.padEnd(24) + ' got ' + got.padEnd(18) + ' want ' + want);
    }
  }
  try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  if (bad === 0) {
    console.log('汇编器回归测试通过：' + CASES.length + ' 条指令全部匹配 Intel 编码规则');
  } else {
    console.log(bad + ' / ' + CASES.length + ' 条不匹配');
    process.exitCode = 1;
  }
}

run();
