'use strict';
// 构建 Lumen OS 的 x86 原生可引导光盘
//   - 内核（汇编）+ LMFS 文件系统 → 一张引导映像
//   - El Torito 引导记录（光盘）
//   - 混合 MBR（U 盘 / 硬盘启动）
const fs = require('fs');
const path = require('path');
const { assemble } = require('./x86asm.js');
const { buildIso, SECTOR } = require('./iso.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const KERNEL_AREA = 0x1000;        // 内核占前 4 KiB，文件系统紧随其后（整张映像须 < 64 KiB）

/* ---------- 1. 组装 LMFS 卷 ---------- */
function buildFs(files) {
  const BLOCK = 512;
  const dirBlocks = 8;
  const dataStart = 2 + dirBlocks;
  let total = 0;
  for (const f of files) total += Math.ceil(f.data.length / BLOCK);
  const blocks = dataStart + Math.max(total, 1);
  const img = Buffer.alloc(blocks * BLOCK);

  img.write('LMFS', 0, 'ascii');
  img.writeUInt32LE(BLOCK, 4);
  img.writeUInt32LE(blocks, 8);
  img.writeUInt32LE(2, 12);
  img.writeUInt32LE(dataStart, 16);

  let cur = dataStart;
  files.forEach((f, i) => {
    const e = 2 * BLOCK + i * 64;
    const name = Buffer.from(f.name.toUpperCase(), 'ascii');
    name.copy(img, e, 0, Math.min(name.length, 39));
    img.writeUInt32LE(cur, e + 40);
    img.writeUInt32LE(f.data.length, e + 44);
    img.writeUInt32LE(1, e + 48);
    f.data.copy(img, cur * BLOCK);
    cur += Math.ceil(f.data.length / BLOCK);
  });

  return img;
}

/* ---------- 2. 混合 MBR（U 盘启动） ---------- */
function buildHybridMbr(imageSize, bootLba2048, bootBytes) {
  const mbr = Buffer.alloc(512, 0);
  const code = [];
  const labels = {};
  const b = (...v) => code.push(...v);
  const lab = (n) => { labels[n] = code.length; };

  b(0xFA);                       // cli
  b(0x31, 0xC0);                 // xor ax,ax
  b(0x8E, 0xD8);                 // mov ds,ax
  b(0x8E, 0xC0);                 // mov es,ax
  b(0x8E, 0xD0);                 // mov ss,ax
  b(0xBC, 0x00, 0x7C);           // mov sp,0x7C00
  b(0xFB);                       // sti

  // 磁盘地址包放在 0x0600，避免被读入的映像覆盖
  const cnt = Math.ceil(bootBytes / 512);
  const lba = (bootLba2048 * SECTOR) / 512;
  const putW = (addr, v) => { b(0xC7, 0x06, addr & 0xFF, (addr >> 8) & 0xFF, v & 0xFF, (v >> 8) & 0xFF); };
  putW(0x0600, 0x0010);
  putW(0x0602, cnt);
  putW(0x0604, 0x7C00);
  putW(0x0606, 0x0000);
  putW(0x0608, lba & 0xFFFF);
  putW(0x060A, (lba >> 16) & 0xFFFF);

  b(0xBE, 0x00, 0x06);           // mov si,0x0600
  b(0xB4, 0x42);                 // mov ah,0x42
  b(0xCD, 0x13);                 // int 13h
  b(0x72, 0x00);                 // jc fail（回填）
  const jcPos = code.length - 2;

  b(0xB8, 0x00, 0x7C);           // mov ax,0x7C00
  b(0x50);                       // push ax
  b(0xC3);                       // ret → 跳到 0x7C00

  lab('fail');
  b(0xB4, 0x0E);                 // mov ah,0x0E
  const siPos = code.length + 1;
  b(0xBE, 0x00, 0x00);           // mov si,msg（回填）
  b(0xAC);                       // lodsb
  b(0x84, 0xC0);                 // test al,al
  b(0x74, 0x04);                 // jz halt
  b(0xCD, 0x10);                 // int 10h
  b(0xEB, 0xF8);                 // jmp lodsb
  lab('halt');
  b(0xEB, 0xFE);                 // jmp $

  const msgAt = code.length;
  for (const ch of 'Lumen OS: boot image not readable\r\n') b(ch.charCodeAt(0));
  b(0);

  code[jcPos + 1] = (labels.fail - (jcPos + 2)) & 0xFF;
  const msgAddr = 0x7C00 + msgAt;
  code[siPos] = msgAddr & 0xFF;
  code[siPos + 1] = (msgAddr >> 8) & 0xFF;

  Buffer.from(code).copy(mbr, 0);

  const totalSectors = Math.floor(imageSize / 512);
  const pt = 0x1BE;
  mbr[pt + 0] = 0x80;
  mbr[pt + 4] = 0x0C;
  mbr[pt + 5] = 0xFE;
  mbr[pt + 6] = 0xFF;
  mbr[pt + 7] = 0xFF;
  mbr.writeUInt32LE(0, pt + 8);
  mbr.writeUInt32LE(totalSectors, pt + 12);
  mbr[0x1FE] = 0x55;
  mbr[0x1FF] = 0xAA;
  return mbr;
}

/* ---------- 主流程 ---------- */
const src = read('src/x86/kmain.s');
const { code, labels } = assemble(src);

const fsFiles = [
  { name: 'README.TXT', data: Buffer.from(
    'Lumen OS 1.0 - x86 native build\r\n' +
    '\r\n' +
    'This disc boots a kernel written in x86 machine code. No emulation.\r\n' +
    'Try: help / ver / ls / cat README.TXT / clear / reboot\r\n' +
    '\r\n' +
    'The LUX-32 original (same project, custom instruction set) is in\r\n' +
    'LUMENOS.HTM on this disc - open it in any browser.\r\n', 'utf8') },
  { name: 'MOTD.TXT', data: Buffer.from(
    'LUMEN OS\r\n' +
    '========\r\n' +
    '\r\n' +
    'instruction set   LUX-32 (custom)  |  x86 (this build)\r\n' +
    'kernel            Lumen\r\n' +
    'filesystem        LMFS, 512 byte blocks, 64 directory entries\r\n' +
    'boot              El Torito on CD, hybrid MBR on USB\r\n' +
    '\r\n' +
    'Everything here was written for this project: the assembler,\r\n' +
    'the compiler, the kernel, the filesystem, the boot protocol.\r\n', 'utf8') },
  { name: 'KMAIN.ASM', data: Buffer.from(src, 'utf8') },
  { name: 'HELLO.TXT', data: Buffer.from('hello from the LMFS volume\r\n', 'utf8') }
];

const fsImg = buildFs(fsFiles);

const bootBytes = Buffer.alloc(KERNEL_AREA + fsImg.length, 0);
Buffer.from(code).copy(bootBytes, 0);
fsImg.copy(bootBytes, KERNEL_AREA);

const iso = buildIso([
  { name: 'README.TXT', data: fsFiles[0].data },
  { name: 'KMAIN.ASM', data: fsFiles[2].data },
  { name: 'LUMENOS.HTM', data: fs.readFileSync(path.join(DIST, 'LumenOS.html')) }
], {
  volumeId: 'LUMEN_OS_X86',
  date: new Date(),
  boot: { image: bootBytes }
});

const mbr = buildHybridMbr(iso.image.length, iso.bootLba, bootBytes.length);
mbr.copy(iso.image, 0);

fs.writeFileSync(path.join(DIST, 'LumenOS-x86.iso'), iso.image);

console.log('  源码        ' + src.split('\n').length + ' 行汇编');
console.log('  内核        ' + code.length + ' B');
console.log('  文件系统    ' + fsImg.length + ' B (' + (fsImg.length / 512) + ' 块, ' + fsFiles.length + ' 个文件)');
console.log('  引导映像    ' + bootBytes.length + ' B (' + Math.ceil(bootBytes.length / 512) + ' 扇区)');
console.log('  光盘        ' + iso.image.length + ' B -> dist/LumenOS-x86.iso');
console.log('  混合 MBR    已写入，可 dd 到 U 盘启动');
