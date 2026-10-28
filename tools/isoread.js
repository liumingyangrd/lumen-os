'use strict';
// ISO 读回校验：解析卷描述符与根目录，把每个文件解出来
const fs = require('fs');
const SECTOR = 2048;

function readIso(buf) {
  const pvd = buf.subarray(16 * SECTOR, 17 * SECTOR);
  if (pvd.toString('ascii', 1, 6) !== 'CD001') throw new Error('不是 ISO 9660 镜像');
  const total = pvd.readUInt32LE(80);
  const blockSize = pvd.readUInt16LE(128);
  const rootRec = pvd.subarray(156, 156 + 34);
  const rootExtent = rootRec.readUInt32LE(2);
  const rootSize = rootRec.readUInt32LE(10);

  const files = [];
  let off = rootExtent * blockSize;
  const end = off + rootSize;
  while (off < end) {
    const len = buf.readUInt8(off);
    if (len === 0) { off = (Math.floor(off / blockSize) + 1) * blockSize; continue; }
    const extent = buf.readUInt32LE(off + 2);
    const size = buf.readUInt32LE(off + 10);
    const flags = buf.readUInt8(off + 25);
    const nameLen = buf.readUInt8(off + 32);
    const name = buf.toString('ascii', off + 33, off + 33 + nameLen);
    if (name !== '\u0000' && name !== '\u0001') {
      files.push({ name: name.replace(/;1$/, ''), extent, size, flags,
        data: buf.subarray(extent * blockSize, extent * blockSize + size) });
    }
    off += len;
  }
  return { total, blockSize, volumeId: pvd.toString('ascii', 40, 72).trim(), files };
}

if (require.main === module) {
  const buf = fs.readFileSync(process.argv[2]);
  const iso = readIso(buf);
  console.log('卷标识    ' + iso.volumeId);
  console.log('扇区数    ' + iso.total + ' x ' + iso.blockSize + ' = ' + (iso.total * iso.blockSize) + ' B');
  console.log('文件数    ' + iso.files.length);
  for (const f of iso.files) {
    const crypto = require('crypto');
    const h = crypto.createHash('sha256').update(f.data).digest('hex').slice(0, 12);
    console.log('  ' + f.name.padEnd(12) + String(f.size).padStart(8) + ' B   sha256:' + h);
  }
}
module.exports = { readIso };
