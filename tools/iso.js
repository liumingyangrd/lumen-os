'use strict';
// 极简 ISO 9660 光盘镜像写入器（Level 1）+ El Torito 无仿真引导。
// 结构：系统区(16 扇区) → 主卷描述符 → [引导记录] → 结束描述符 →
//       [引导目录] → 路径表 → 根目录 → [引导映像] → 文件数据
// 全部字段手写，没有用第三方库。

const SECTOR = 2048;

function bothU32(v) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(v >>> 0, 0);
  b.writeUInt32BE(v >>> 0, 4);
  return b;
}

function bothU16(v) {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(v & 0xFFFF, 0);
  b.writeUInt16BE(v & 0xFFFF, 2);
  return b;
}

function dirDate(d) {
  const tz = Math.round(-d.getTimezoneOffset() / 15) & 0xFF;
  return Buffer.from([d.getFullYear() - 1900, d.getMonth() + 1, d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds(), tz]);
}

function volDate(d) {
  const p = (n, w) => String(n).padStart(w, '0');
  const s = p(d.getFullYear(), 4) + p(d.getMonth() + 1, 2) + p(d.getDate(), 2) +
    p(d.getHours(), 2) + p(d.getMinutes(), 2) + p(d.getSeconds(), 2) + '00';
  const tz = Math.round(-d.getTimezoneOffset() / 15) & 0xFF;
  return Buffer.concat([Buffer.from(s, 'ascii'), Buffer.from([tz])]);
}

function dirRecord(idBuf, extent, size, flags, when) {
  const pad = idBuf.length % 2 === 0 ? 1 : 0;
  const len = 33 + idBuf.length + pad;
  const b = Buffer.alloc(len);
  b.writeUInt8(len, 0);
  b.writeUInt8(0, 1);
  bothU32(extent).copy(b, 2);
  bothU32(size).copy(b, 10);
  dirDate(when).copy(b, 18);
  b.writeUInt8(flags, 25);
  b.writeUInt8(0, 26);
  b.writeUInt8(0, 27);
  bothU16(1).copy(b, 28);
  b.writeUInt8(idBuf.length, 32);
  idBuf.copy(b, 33);
  return b;
}

function ident(name) {
  return Buffer.from(name.toUpperCase() + ';1', 'ascii');
}

/**
 * files: [{ name: 'README.TXT', data: Buffer }]
 * opts.boot: { image: Buffer }   —— El Torito 引导映像（通常是 512 字节的 stage1）
 * opts.raw:  Buffer              —— 额外的原始扇区（两阶段引导的内核 payload）
 */
function buildIso(files, opts) {
  const o = opts || {};
  const when = o.date || new Date();
  const volId = (o.volumeId || 'LUMEN_OS').toUpperCase().slice(0, 32);
  const boot = o.boot || null;

  /* ---- 扇区布局 ---- */
  let sec = 16;
  sec++;                                   // 16 主卷描述符
  const BRVD = boot ? sec++ : -1;          // 引导记录卷描述符
  const TERM = sec++;                      // 结束描述符
  const CATALOG = boot ? sec++ : -1;       // 引导目录
  const LPATH = sec++;
  const MPATH = sec++;
  const DIR = sec++;
  const bootImgSectors = boot ? Math.ceil(boot.image.length / SECTOR) : 0;
  const BOOTIMG = boot ? sec : -1;         // 引导映像
  if (boot) sec += bootImgSectors;

  // 额外的原始扇区（两阶段引导的 payload），排在文件之前
  const raw = o.raw || null;
  const RAW_START = sec;
  if (raw) sec += Math.ceil(raw.length / SECTOR);

  const FILE_START = sec;

  /* ---- 文件排布 ---- */
  let cursor = FILE_START;
  const placed = files.map((f) => {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const sectors = Math.max(1, Math.ceil(data.length / SECTOR));
    const rec = { name: f.name, data, extent: cursor, size: data.length, sectors };
    cursor += sectors;
    return rec;
  });
  const totalSectors = cursor;

  /* ---- 根目录 ---- */
  const records = [];
  records.push(dirRecord(Buffer.from([0x00]), DIR, SECTOR, 0x02, when));
  records.push(dirRecord(Buffer.from([0x01]), DIR, SECTOR, 0x02, when));
  for (const f of placed) records.push(dirRecord(ident(f.name), f.extent, f.size, 0x00, when));

  const dirBuf = Buffer.alloc(SECTOR);
  let off = 0;
  for (const r of records) {
    if (off + r.length > SECTOR) throw new Error('根目录超过一个扇区');
    r.copy(dirBuf, off);
    off += r.length;
  }

  /* ---- 路径表 ---- */
  const pathRec = Buffer.alloc(10);
  pathRec.writeUInt8(1, 0);
  pathRec.writeUInt8(0, 1);
  pathRec.writeUInt32LE(DIR, 2);
  pathRec.writeUInt16LE(1, 6);
  pathRec.writeUInt8(0, 8);
  pathRec.writeUInt8(0, 9);

  const pathRecM = Buffer.from(pathRec);
  pathRecM.writeUInt32BE(DIR, 2);
  pathRecM.writeUInt16BE(1, 6);

  /* ---- 主卷描述符 ---- */
  const pvd = Buffer.alloc(SECTOR);
  pvd.writeUInt8(1, 0);
  pvd.write('CD001', 1, 'ascii');
  pvd.writeUInt8(1, 6);
  pvd.write(' '.repeat(32), 8, 'ascii');
  pvd.write(volId.padEnd(32, ' '), 40, 'ascii');
  bothU32(totalSectors).copy(pvd, 80);
  bothU16(1).copy(pvd, 120);
  bothU16(1).copy(pvd, 124);
  bothU16(SECTOR).copy(pvd, 128);
  bothU32(10).copy(pvd, 132);
  pvd.writeUInt32LE(LPATH, 140);
  pvd.writeUInt32LE(0, 144);
  pvd.writeUInt32BE(MPATH, 148);
  pvd.writeUInt32BE(0, 152);
  dirRecord(Buffer.from([0x00]), DIR, SECTOR, 0x02, when).copy(pvd, 156);
  if (boot) bothU32(BRVD).copy(pvd, 71);        // 引导记录卷描述符的位置
  pvd.write(volId.padEnd(128, ' '), 190, 'ascii');
  pvd.write('LUMEN OS PROJECT'.padEnd(128, ' '), 318, 'ascii');
  pvd.write('LUX-32 VM / lcc toolchain'.padEnd(128, ' '), 446, 'ascii');
  pvd.write('LUMENOS'.padEnd(128, ' '), 574, 'ascii');
  pvd.write('README.TXT'.padEnd(37, ' '), 702, 'ascii');
  pvd.write(' '.repeat(37), 739, 'ascii');
  pvd.write(' '.repeat(37), 776, 'ascii');
  volDate(when).copy(pvd, 813);
  volDate(when).copy(pvd, 830);
  pvd.write('0'.repeat(16) + '0', 847, 'ascii');
  pvd.write('0'.repeat(16) + '0', 864, 'ascii');
  pvd.writeUInt8(1, 881);

  /* ---- 引导记录卷描述符 + El Torito 引导目录 ---- */
  let brvd = null;
  let catalog = null;
  if (boot) {
    const bootSectors = Math.ceil(boot.image.length / 512);
    if (boot.image.length > 512 * 512) throw new Error('引导映像过大');
    brvd = Buffer.alloc(SECTOR);
    brvd.writeUInt8(0, 0);
    brvd.write('CD001', 1, 'ascii');
    brvd.writeUInt8(1, 6);
    brvd.write('EL TORITO SPECIFICATION', 7, 'ascii');   // 系统标识，其后保持 0
    brvd.writeUInt32LE(CATALOG, 71);                     // 引导目录绝对扇区

    catalog = Buffer.alloc(SECTOR);
    // 校验项（32 字节）
    catalog.writeUInt8(0x01, 0);                         // 头部标识
    catalog.writeUInt8(0x00, 1);                         // 平台：80x86
    catalog.write('LUMEN OS 1.0'.padEnd(24, '\0'), 4, 'ascii');
    catalog.writeUInt16LE(0x0000, 28);                   // 校验和，稍后回填
    catalog.writeUInt8(0x55, 30);
    catalog.writeUInt8(0xAA, 31);
    let sum = 0;
    for (let i = 0; i < 32; i += 2) sum += catalog.readUInt16LE(i);
    catalog.writeUInt16LE((0x10000 - (sum % 0x10000)) % 0x10000, 28);

    // 默认条目（32 字节）：引导介质类型可配，加载到 0000:7C00
    //   0x00 = 无仿真（BIOS 只把第一个扇区读进内存，后面的要自己读）
    //   0x04 = 硬盘仿真（整张映像被当成一块硬盘，INT 13h 能读到整个映像）
    const e = 32;
    const mediaType = (o.boot && o.boot.mediaType !== undefined) ? o.boot.mediaType : 0x00;
    catalog.writeUInt8(0x88, e + 0);                     // 可启动
    catalog.writeUInt8(mediaType, e + 1);                // 引导介质类型
    catalog.writeUInt16LE(0x0000, e + 2);                // 加载段：0 表示 0x7C00
    catalog.writeUInt8(0x00, e + 4);                     // 系统类型
    catalog.writeUInt8(0x00, e + 5);
    catalog.writeUInt16LE(bootSectors, e + 6);           // 扇区数（按 512 B 计）
    catalog.writeUInt32LE(BOOTIMG, e + 8);               // 映像所在 LBA
  }

  /* ---- 结束描述符 ---- */
  const term = Buffer.alloc(SECTOR);
  term.writeUInt8(255, 0);
  term.write('CD001', 1, 'ascii');
  term.writeUInt8(1, 6);

  /* ---- 组装 ---- */
  const img = Buffer.alloc(totalSectors * SECTOR);
  pvd.copy(img, 16 * SECTOR);
  if (brvd) brvd.copy(img, BRVD * SECTOR);
  term.copy(img, TERM * SECTOR);
  if (catalog) catalog.copy(img, CATALOG * SECTOR);
  pathRec.copy(img, LPATH * SECTOR);
  pathRecM.copy(img, MPATH * SECTOR);
  dirBuf.copy(img, DIR * SECTOR);
  if (boot) boot.image.copy(img, BOOTIMG * SECTOR);
  if (raw) raw.copy(img, RAW_START * SECTOR);
  for (const f of placed) f.data.copy(img, f.extent * SECTOR);

  return { image: img, sectors: totalSectors, files: placed, boot: !!boot,
           bootLba: BOOTIMG, rawStart: raw ? RAW_START : -1 };
}

module.exports = { buildIso, SECTOR };
