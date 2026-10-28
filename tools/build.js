/*
 * Lumen 构建系统
 *   .lc -> lcc -> .s -> luxasm -> .lmx -> LMFS -> lumen.lmi -> LumenOS.html
 */
const fs = require('fs');
const path = require('path');
const { assemble } = require('./asm.js');
const { compile } = require('./cc.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const FS_BASE_LBA = 256;
const DISK_BLOCKS = 512;
const BLOCK = 512;

const users = ['lsh', 'ls', 'cat', 'calc', 'ps', 'mem', 'date', 'hello', 'write', 'rm', 'snake'];

function log(s) { process.stdout.write(s + '\n'); }

function buildLmx(obj) {
  const imageSize = obj.code.length;
  const relocCount = obj.relocs.length;
  const relocOff = imageSize;
  const total = 32 + imageSize + relocCount * 4;
  const b = Buffer.alloc(total);
  b.write('LMX1', 0, 'latin1');
  b.writeUInt32LE(obj.entry - obj.base, 4);
  b.writeUInt32LE(imageSize, 8);
  b.writeUInt32LE(0, 12);
  b.writeUInt32LE(relocCount, 16);
  b.writeUInt32LE(relocOff, 20);
  b.writeUInt32LE(0x30000, 24);
  b.writeUInt32LE(0, 28);
  Buffer.from(obj.code).copy(b, 32);
  for (let i = 0; i < relocCount; i++) b.writeUInt32LE(obj.relocs[i], 32 + relocOff + i * 4);
  return b;
}

function w32(buf, off, v) { buf.writeUInt32LE(v >>> 0, off); }

function buildFs(files) {
  const img = Buffer.alloc(DISK_BLOCKS * BLOCK);
  img.write('LMFS', 0, 'latin1');
  w32(img, 4, BLOCK);
  w32(img, 8, DISK_BLOCKS);
  w32(img, 12, 2);
  w32(img, 16, 16);
  let dataBlk = 16;
  files.forEach((f, i) => {
    const blocks = Math.ceil(f.data.length / BLOCK);
    f.data.copy(img, dataBlk * BLOCK);
    const e = 2 * BLOCK + i * 64;
    img.write(f.name, e, 'latin1');
    w32(img, e + 40, dataBlk);
    w32(img, e + 44, f.data.length);
    w32(img, e + 48, 1);
    dataBlk += blocks;
  });
  w32(img, 24, dataBlk);
  return img;
}

function main() {
  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const t0 = Date.now();

  /* ---------- 1. 用户程序 ---------- */
  const libC = read('src/lib/lib.lc');
  const libS = read('src/lib/lib.ls');
  const files = [];
  const stats = [];
  for (const name of users) {
    const src = libC + '\n' + read(`src/user/${name}.lc`);
    let asmText;
    try {
      asmText = compile(src);
    } catch (e) {
      log(`[错误] 编译 ${name}: ${e.message}`);
      process.exit(1);
    }
    let obj;
    try {
      obj = assemble(libS + '\n' + asmText, { base: 0 });
    } catch (e) {
      log(`[错误] 汇编 ${name}: ${e.message}`);
      fs.writeFileSync(path.join(DIST, name + '.debug.s'), libS + '\n' + asmText);
      process.exit(1);
    }
    const lmx = buildLmx(obj);
    files.push({ name: name + '.lmx', data: lmx });
    stats.push([name, lmx.length, obj.relocs.length]);
  }

  /* ---------- 2. 内核 ---------- */
  let kAsm;
  try {
    kAsm = compile(read('src/kernel/kernel.lc'), { noStart: true });
  } catch (e) {
    log(`[错误] 编译内核: ${e.message}`);
    process.exit(1);
  }
  const kSrc = read('src/kernel/kstart.ls') + '\n' + kAsm;
  let kObj;
  try {
    kObj = assemble(kSrc, { base: 0x100000 });
  } catch (e) {
    log(`[错误] 汇编内核: ${e.message}`);
    fs.writeFileSync(path.join(DIST, 'kernel.debug.s'), kSrc);
    process.exit(1);
  }
  fs.writeFileSync(path.join(DIST, 'kernel.debug.s'), kSrc);
  const kernel = Buffer.from(kObj.code);

  /* ---------- 3. 引导扇区 ---------- */
  const bObj = assemble(read('src/boot/boot.ls'), { base: 0x7C00 });
  if (bObj.code.length !== 512) {
    log(`[错误] 引导扇区必须正好 512 字节, 实际 ${bObj.code.length}`);
    process.exit(1);
  }
  const ksec = Math.ceil(kernel.length / BLOCK);
  if (ksec > FS_BASE_LBA - 1) {
    log(`[错误] 内核 ${ksec} 扇区, 超出 ${FS_BASE_LBA - 1} 扇区上限`);
    process.exit(1);
  }

  /* ---------- 4. 文件系统 ---------- */
  const extra = [
    { name: 'readme.txt', data: Buffer.from(
      'Lumen OS 1.0\n' +
      '=============\n\n' +
      '这是一个从零写起的操作系统:\n' +
      '  - 自己的 CPU 指令集 LUX-32\n' +
      '  - 自己的汇编器 luxasm\n' +
      '  - 自己的编译器 lcc (Lumen-C)\n' +
      '  - 自己的内核 Lumen (非 Linux, 非 POSIX)\n' +
      '  - 自己的可执行格式 LMX (.lmx)\n' +
      '  - 自己的文件系统 LMFS (.lmfs)\n\n' +
      '试着运行: ls / cat readme.txt / ver / snake\n', 'utf8') },
    { name: 'notes.txt', data: Buffer.from(
      'LMFS 磁盘布局\n' +
      '  块 0        超级块 (LMFS, 512, 256, dir=2, data=16)\n' +
      '  块 2..9     目录表, 64 项 x 64 字节\n' +
      '  块 16..     文件数据区 (连续分配)\n\n' +
      'LMX 可执行文件\n' +
      '  0   "LMX1"\n' +
      '  4   入口偏移\n' +
      '  8   映像大小\n' +
      '  12  bss 大小\n' +
      '  16  重定位项数\n' +
      '  20  重定位表偏移\n', 'utf8') }
  ];
  const fsImg = buildFs(files.concat(extra));

  /* ---------- 5. 整盘镜像 ---------- */
  const totalSize = FS_BASE_LBA * BLOCK + fsImg.length;
  const image = Buffer.alloc(totalSize);
  Buffer.from(bObj.code).copy(image, 0);
  const ksecOff = bObj.symbols['ksec'] - 0x7C00;
  image.writeUInt32LE(ksec, ksecOff);
  kernel.copy(image, BLOCK);
  fsImg.copy(image, FS_BASE_LBA * BLOCK);
  fs.writeFileSync(path.join(DIST, 'lumen.lmi'), image);

  /* ---------- 6. 单文件启动页 ---------- */
  const vmJs = read('tools/vm.js');
  const appJs = read('web/app.js');
  const tpl = read('web/shell.html');
  const syms = {};
  ['t_state', 't_pid', 't_ppid', 't_names', 'cur', 'ticks', 'fsbase', 'conattr'].forEach(k => {
    if (kObj.symbols[k] !== undefined) syms[k] = kObj.symbols[k];
  });
  fs.writeFileSync(path.join(DIST, 'syms.json'), JSON.stringify(kObj.symbols));
  syms.kernelSize = kernel.length;
  syms.fsBase = FS_BASE_LBA * BLOCK;
  syms.diskBlocks = DISK_BLOCKS;
  const html = tpl
    .replace('/*__VM_JS__*/', () => vmJs)
    .replace('/*__APP_JS__*/', () => appJs)
    .replace('__IMAGE_B64__', () => image.toString('base64'))
    .replace('__SYMS__', () => JSON.stringify(syms));
  fs.writeFileSync(path.join(DIST, 'LumenOS.html'), html);

  /* ---------- 7. 光盘镜像 ---------- */
  const { buildIso } = require('./iso.js');
  const { zip } = require('./zip.js');

  const srcFiles = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = prefix ? prefix + '/' + name : name;
      if (fs.statSync(full).isDirectory()) { walk(full, rel); continue; }
      if (/\.(js|lc|ls|md|html)$/.test(name) && !full.includes('dist')) {
        srcFiles.push({ name: 'LUMEN/' + rel.toUpperCase(), data: fs.readFileSync(full) });
      }
    }
  };
  walk(ROOT, '');

  const readmeTxt =
    'LUMEN OS 1.0 —— 一套从指令集开始自行构建的计算机系统\r\n' +
    '=======================================================\r\n\r\n' +
    '这不是 Linux, 也不是任何现有系统的分支。处理器指令集(LUX-32)、虚拟机、\r\n' +
    '汇编器、编译器(Lumen-C)、内核(Lumen)、可执行格式(LMX)、文件系统(LMFS)\r\n' +
    '全部为自研实现。\r\n\r\n' +
    '光盘内容\r\n' +
    '  LUMENOS.HTM  单文件系统模拟器, 用浏览器打开即可开机\r\n' +
    '  LUMEN.LMI    完整启动镜像: 引导扇区 + 内核 + LMFS 磁盘 (512 B 扇区)\r\n' +
    '  LUMEN.MAN    LUX-32 体系结构手册 (指令集 / 端口 / 系统调用 / 格式)\r\n' +
    '  SOURCE.ZIP   全部源码 (汇编器 / 编译器 / 内核 / 用户程序 / 前端)\r\n\r\n' +
    '如何开机\r\n' +
    '  1. 双击 LUMENOS.HTM, 现代浏览器直接进入图形终端\r\n' +
    '  2. 或解压 SOURCE.ZIP, 执行 node tools/build.js 重新构建全部产物\r\n\r\n' +
    '关于启动\r\n' +
    '  这张盘带 El Torito 引导扇区, 在 PC / VMware / VirtualBox 里可以启动。\r\n' +
    '  但启动后只显示一屏说明然后停机 —— 因为盘上的系统是 LUX-32 指令集,\r\n' +
    '  与 x86 不兼容, 真实 CPU 无法执行它。引导扇区存在的意义是把这个事实\r\n' +
    '  说清楚, 而不是让 BIOS 悄悄转去网络启动(PXE)。\r\n' +
    '  要真正运行系统, 请打开 LUMENOS.HTM, 或把 LUMEN.LMI 交给 LUX-32 虚拟机。\r\n\r\n' +
    '构建于 ' + new Date().toISOString().slice(0, 19).replace('T', ' ') + '\r\n';

  const isoFiles = [
    { name: 'README.TXT', data: Buffer.from(readmeTxt, 'utf8') },
    { name: 'LUMENOS.HTM', data: Buffer.from(html, 'utf8') },
    { name: 'LUMEN.LMI', data: image },
    { name: 'LUMEN.MAN', data: fs.readFileSync(path.join(ROOT, 'docs', 'isa.md')) },
    { name: 'SOURCE.ZIP', data: zip(srcFiles, new Date()) }
  ];
  const { buildBootImage } = require('./x86boot.js');
  const bootImg = buildBootImage();
  const iso = buildIso(isoFiles, {
    volumeId: 'LUMEN_OS_1_0',
    date: new Date(),
    boot: { image: bootImg.image }
  });
  fs.writeFileSync(path.join(DIST, 'LumenOS-1.0.iso'), iso.image);

  /* ---------- 报告 ---------- */
  log('');
  log('  Lumen 构建完成  ' + ((Date.now() - t0) / 1000).toFixed(2) + 's');
  log('  ---------------------------------------------');
  log('  用户程序            大小      重定位');
  for (const s of stats) {
    log('   ' + (s[0] + '.lmx').padEnd(16) + String(s[1]).padStart(7) + ' B' + String(s[2]).padStart(8));
  }
  log('  ---------------------------------------------');
  log('  内核映像        ' + String(kernel.length).padStart(7) + ' B  (' + ksec + ' 扇区)');
  log('  引导扇区        ' + String(bObj.code.length).padStart(7) + ' B');
  log('  文件系统        ' + String(fsImg.length).padStart(7) + ' B  (' + DISK_BLOCKS + ' 块)');
  log('  完整镜像        ' + String(image.length).padStart(7) + ' B  -> dist/lumen.lmi');
  log('  单文件系统      ' + String(fs.statSync(path.join(DIST, 'LumenOS.html')).size).padStart(7) + ' B  -> dist/LumenOS.html');
  log('  光盘镜像        ' + String(iso.image.length).padStart(7) + ' B  -> dist/LumenOS-1.0.iso  (' + iso.sectors + ' 扇区 x 2048)');
  log('');
}

main();
