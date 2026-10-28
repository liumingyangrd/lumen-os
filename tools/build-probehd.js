'use strict';
// 构建"硬盘仿真"探针 ISO：El Torito 介质类型 0x04，
// 引导映像是一张磁盘镜像：第 0 扇区是探针，第 1 扇区起是 payload。

const fs = require('fs');
const path = require('path');
const { assemble } = require('./x86asm.js');
const { buildIso } = require('./iso.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const probe = assemble(read('src/x86/probehd.s'));
if (probe.code.length > 512) throw new Error('探针超过一个扇区: ' + probe.code.length);

// 磁盘镜像：0 扇区 = 探针，1 扇区起 = payload
// 每个 512 字节扇区填自己的序号，这样能一眼看出 BIOS 把数据从哪儿读来的
const disk = Buffer.alloc((1 + 44) * 512, 0);
Buffer.from(probe.code).copy(disk, 0);
for (let i = 1; i <= 44; i++) disk.fill(i & 0xFF, i * 512, (i + 1) * 512);
const payload = Buffer.concat([Buffer.from('LMN1', 'ascii'), Buffer.alloc(44 * 512 - 4, 0xAB)]);

const iso = buildIso([{ name: 'PROBE.TXT', data: Buffer.from('probe\n', 'utf8') }], {
  volumeId: 'LUMEN_PROBEHD',
  date: new Date(),
  boot: { image: disk, mediaType: 0x04 },
  raw: payload
});

fs.writeFileSync(path.join(DIST, 'probehd.iso'), iso.image);
console.log('硬盘仿真探针 ' + disk.length + ' B -> dist/probehd.iso');
