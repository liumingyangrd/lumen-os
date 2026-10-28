'use strict';
// 构建 Lumen OS 的 x86 原生可引导光盘（图形版）
//   - 内核（汇编）+ 字库 + LMFS 文件系统 → 一张引导映像
//   - El Torito 引导记录（光盘）
//   - 混合 MBR（U 盘 / 硬盘启动）
//
// 引导映像布局（加载于 0x7C00，整张必须 < 64 KiB）：
//   0x7C00 + [0, 4K)    内核代码与数据
//   0x8C00              字库头部（12 字节）
//   0x8C0C              字库本体
//   0xA000              LMFS 卷
//
// 为什么必须小于 64 KiB：实模式 BIOS 读盘按 ES:BX 递增缓冲区，
// 跨 64 KiB 边界会被截断。第一版把文件系统放在 +64 KiB 处，
// ls 直接读出内核字符串 —— 那次"乱码"的根因。

const fs = require('fs');
const path = require('path');
const { assemble } = require('./x86asm.js');
const { buildIso } = require('./iso.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const KERNEL_AREA = 0x2000;         // 内核占前 8 KiB（字库编在里面）
const HDR_ADDR = 0x8C00;            // 字库头部
const FONT_UNUSED = 0;           // （字库位置在映像末尾，见下）
const FS_AT = 0xA000;               // LMFS 卷

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
function buildHybridMbr(imageSize, bootLba2048) {
  const mbr = Buffer.alloc(512, 0);
  const code = [];
  const labels = {};
  const b = (...v) => code.push(...v);
  const lab = (n) => { labels[n] = code.length; };

  const DAP = 0x8000;              // 磁盘地址包放在 0x8000
  const BOOT_SEG = 0x0000;         // 引导映像读入 0000:7C00（DAP 里偏移=0x7C00、段=0x0000）

  b(0xFA);                        // cli
  b(0x31, 0xC0);                  // xor ax,ax
  b(0x8E, 0xD8);                  // mov ds,ax
  b(0x8E, 0xC0);                  // mov es,ax
  b(0x8E, 0xD0);                  // mov ss,ax
  b(0xBC, 0x00, 0x7C);            // mov sp,0x7C00
  b(0xFB);                        // sti

  // 用 INT 13h AH=42h（扩展读）把引导映像读入 0000:7C00
  b(0xB8, 0x00, 0x00);            // mov ax,0        ; 后面填 DAP 段
  b(0xBB, 0x80, 0x00);            // mov bx,0x0080   ; DAP 就在 MBR 的 0x80 处
  b(0xB4, 0x42);                  // mov ah,0x42
  b(0xB2, 0x80);                  // mov dl,0x80     ; 第一个硬盘
  b(0xCD, 0x13);                  // int 0x13
  lab('err');
  b(0x72, 0x00);                  // jc  err
  b(0xEA, 0x00, 0x7C, 0x00, 0x00); // jmp 0000:7C00
  lab('err');
  b(0xF4);                        // hlt
  b(0xEB, 0xFD);                  // jmp $

  // 修补 jc 的位移
  const jcPos = code.indexOf(0x72);
  code[jcPos + 1] = (labels.err - (jcPos + 2)) & 0xFF;

  // 修补 DAP 的段:偏移
  const axPos = code.indexOf(0xB8);
  code[axPos + 1] = DAP & 0xFF;
  code[axPos + 2] = (DAP >> 8) & 0xFF;
  const bxPos = code.indexOf(0xBB);
  code[bxPos + 1] = 0x80;         // DAP 在 MBR 偏移 0x80
  code[bxPos + 2] = 0x00;

  Buffer.from(code).copy(mbr, 0);

  // 磁盘地址包（DAP）
  const dap = Buffer.alloc(16, 0);
  dap[0] = 0x10;                            // 结构长度
  dap[1] = 0x00;
  dap[2] = 0x00; dap[3] = 0x00;
  dap[4] = 0x00;                            // 偏移 = 0x7C00
  dap[5] = 0x7C;
  dap[6] = 0x00;                            // 段 = 0x0000
  dap[7] = 0x00;
  dap[8] = bootLba2048 & 0xFF;              // LBA
  dap[9] = (bootLba2048 >> 8) & 0xFF;
  dap[10] = (bootLba2048 >> 16) & 0xFF;
  dap[11] = (bootLba2048 >> 24) & 0xFF;
  dap[12] = 0x00; dap[13] = 0x00;
  dap[14] = 0x00; dap[15] = 0x00;

  // DAP 放在 MBR 的 0x80 偏移处（引导代码只占前 40 字节，不会冲突）
  dap.copy(mbr, 0x80);

  // 分区表
  const totalSectors = Math.floor(imageSize / 512);
  const pt = 0x1BE;
  mbr[pt + 0] = 0x80;                       // 可引导
  mbr[pt + 4] = 0x0C;                       // 类型 FAT32 LBA
  mbr[pt + 5] = 0xFE; mbr[pt + 6] = 0xFF; mbr[pt + 7] = 0xFF;
  mbr.writeUInt32LE(1, pt + 8);              // 起始 LBA
  mbr.writeUInt32LE(totalSectors - 1, pt + 12);
  mbr[0x1FE] = 0x55;
  mbr[0x1FF] = 0xAA;

  return { mbr, dap };
}

/* ---------- 主流程 ---------- */
const kernelSrc = read('src/x86/kgfx.s');

/* 字库：先跑 fontgen.py 按当前源码用字重新生成 */
require('child_process').execFileSync('python', [path.join(ROOT, 'tools', 'fontgen.py')], { stdio: 'inherit' });
const font = fs.readFileSync(path.join(DIST, 'font.bin'));
const asciiCount = font.readUInt16LE(0);
const cjkCount = font.readUInt16LE(2);
const asciiAt = 4;
const mapAt = asciiAt + asciiCount * 16;
const glyAt = mapAt + cjkCount * 2;

/* 把字库编进内核。
   为什么不用"映像里单独放一块"：那样就得依赖 BIOS 到底加载了多少字节。
   直接编进代码段，和内核一起被加载，永远不会错位。 */
const dbBytes = (buf) => {
  const out = [];
  for (let i = 0; i < buf.length; i += 16) {
    out.push('    db ' + Array.from(buf.slice(i, i + 16)).join(','));
  }
  return out.join(String.fromCharCode(10));
};

// 字库布局（放在引导映像的 0x8C00 处）
//   fonthead(12B) + ascii字模 + codepoint表 + cjk字模
// 头部里的三个地址写成绝对地址，内核直接用，不用做换算
const headLen = 12;
const asciiOff = headLen;
const mapOff = asciiOff + asciiCount * 16;
const glyOff = mapOff + cjkCount * 2;
const FONT_BASE = HDR_ADDR + 12;               // 字库本体在 0x8C0C

const fontBlob = Buffer.alloc(glyOff + cjkCount * 32);
fontBlob.writeUInt16LE(asciiCount, 0);
fontBlob.writeUInt16LE(cjkCount, 2);
fontBlob.writeUInt16LE(FONT_BASE + asciiOff, 4);
fontBlob.writeUInt16LE(FONT_BASE + mapOff, 6);
fontBlob.writeUInt16LE(FONT_BASE + glyOff, 8);
font.copy(fontBlob, asciiOff);

const NL = String.fromCharCode(10);
// 把 fgcol 的真实地址注入内核源码（汇编器算出的绝对地址）
const src = kernelSrc.replace(/^FGCOL_ADDR = 0$/m, 'FGCOL_ADDR = 0');

fs.writeFileSync(path.join(DIST, 'kernel-with-font.s'), src, 'utf8');
const { code, labels } = assemble(src);
if (code.length > KERNEL_AREA) {
  throw new Error('内核 ' + code.length + ' 字节，超出 ' + KERNEL_AREA + ' 字节上限');
}

const fsFiles = [
  { name: 'README.TXT', data: Buffer.from(
    'Lumen OS 1.0 - x86 native build, 320x200 graphics\r\n' +
    '==================================================\r\n' +
    '\r\n' +
    'This disc boots a kernel written in x86 machine code.\r\n' +
    'No emulation, no third-party kernel, no third-party bootloader.\r\n' +
    '\r\n' +
    'Display   VGA mode 13h (320x200x256), linear framebuffer\r\n' +
    'Text      ASCII 8x16 (1 column), CJK 16x16 (2 columns)\r\n' +
    'Font      generated for this project (tools/fontgen.py)\r\n' +
    'Serial    COM1 115200 8N1, every character mirrored\r\n' +
    'Files     LMFS volume loaded with the boot image\r\n' +
    'Boot      El Torito on CD, hybrid MBR on USB\r\n' +
    '\r\n' +
    'Try: help / ver / ls / clear / reboot\r\n' +
    '\r\n' +
    'The LUX-32 original (same project, custom instruction set) is in\r\n' +
    'LUMENOS.HTM on this disc - open it in any browser.\r\n', 'utf8') },
  { name: 'MOTD.TXT', data: Buffer.from(
    'Lumen OS\r\n' +
    '========\r\n' +
    '\r\n' +
    'instruction set   LUX-32 (custom)  |  x86 (this build)\r\n' +
    'kernel            Lumen\r\n' +
    'assembler         tools/x86asm.js (written for this project)\r\n' +
    'filesystem        LMFS, 512 byte blocks, 64 directory entries\r\n' +
    'font              16x16 CJK subset, generated by tools/fontgen.py\r\n' +
    'boot              El Torito on CD, hybrid MBR on USB\r\n' +
    '\r\n' +
    'Everything here was written for this project: the assembler,\r\n' +
    'the compiler, the kernel, the filesystem, the boot protocol.\r\n', 'utf8') },
  { name: 'HELLO.TXT', data: Buffer.from('hello from the LMFS volume\r\n', 'utf8') }
];

const fsImg = buildFs(fsFiles);

/* 组装引导映像
   0x7C00 + [0, 4K)   内核代码与数据
   0x8C00 + [0, 12B)  字库头部
   0x8C0C + 字库本体
   0xA000             LMFS 卷 */
const FONT_POS = HDR_ADDR + 12;
const fontEnd = FONT_POS + fontBlob.length;
if (fontEnd > FS_AT) {
  throw new Error('字库放不下：需要到 0x' + fontEnd.toString(16) + '，FS 在 0x' + FS_AT.toString(16));
}

const total = FS_AT - 0x7C00 + fsImg.length;
if (total > 0x10000 - 0x7C00) throw new Error('引导映像 ' + total + ' 字节，超过 64 KiB 边界');

const bootBytes = Buffer.alloc(total, 0);
Buffer.from(code).copy(bootBytes, 0);

// 字库：头部在 HDR_ADDR，字库本体紧随其后
const hdrBlob = fontBlob.slice(0, 12);
hdrBlob.copy(bootBytes, HDR_ADDR - 0x7C00);
fontBlob.slice(12).copy(bootBytes, FONT_POS - 0x7C00);

fsImg.copy(bootBytes, FS_AT - 0x7C00);



const iso = buildIso([
  { name: 'README.TXT', data: fsFiles[0].data },
  { name: 'KGFX.ASM', data: Buffer.from(src, 'utf8') },
  { name: 'LUMENOS.HTM', data: fs.readFileSync(path.join(DIST, 'LumenOS.html')) }
], {
  volumeId: 'LUMEN_OS_X86',
  date: new Date(),
  boot: { image: bootBytes }
});

const { mbr, dap } = buildHybridMbr(iso.image.length, iso.bootLba);
mbr.copy(iso.image, 0);

fs.writeFileSync(path.join(DIST, 'LumenOS-x86.iso'), iso.image);

console.log('  源码        ' + src.split('\n').length + ' 行汇编');
console.log('  内核        ' + code.length + ' B');
console.log('  字库        ' + font.length + ' B (ASCII ' + asciiCount + ', 汉字 ' + cjkCount + ')');
console.log('  文件系统    ' + fsImg.length + ' B (' + (fsImg.length / 512) + ' 块, ' + fsFiles.length + ' 个文件)');
console.log('  引导映像    ' + bootBytes.length + ' B (' + Math.ceil(bootBytes.length / 512) + ' 扇区)');
console.log('  光盘        ' + iso.image.length + ' B -> dist/LumenOS-x86.iso');
console.log('  混合 MBR    已写入，可 dd 到 U 盘启动');
