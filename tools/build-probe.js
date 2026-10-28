'use strict';
// 单独构建 BIOS 能力探针 ISO：引导映像只有 src/x86/probe.s 一个扇区，
// raw 区放真正的 payload，让探针有东西可读。

const fs = require('fs');
const path = require('path');
const { assemble } = require('./x86asm.js');
const { buildIso } = require('./iso.js');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const probe = assemble(read('src/x86/probe.s'));
if (probe.code.length > 512) throw new Error('探针超过一个扇区: ' + probe.code.length);
const image = Buffer.alloc(512, 0);
Buffer.from(probe.code).copy(image);

// raw 区：一段已知的 payload，探针会尝试读它
const payload = Buffer.concat([Buffer.from('LMN1', 'ascii'), Buffer.alloc(44 * 512 - 4, 0xAB)]);

const iso = buildIso([{ name: 'PROBE.TXT', data: Buffer.from('probe\n', 'utf8') }], {
  volumeId: 'LUMEN_PROBE',
  date: new Date(),
  boot: { image },
  raw: payload
});

fs.writeFileSync(path.join(DIST, 'probe.iso'), iso.image);
console.log('探针 ' + probe.code.length + ' B，payload 在 ISO LBA ' + iso.rawStart +
            '（512B-LBA ' + (iso.rawStart * 4) + '）');
console.log('  -> dist/probe.iso');
