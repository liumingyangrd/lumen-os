'use strict';
// 校验 ISO 的 El Torito 引导结构，并把引导扇区将要显示的屏幕渲染出来
const fs = require('fs');
const S = 2048;
const buf = fs.readFileSync(process.argv[2] || 'dist/LumenOS-1.0.iso');

const brvd = buf.subarray(17 * S, 18 * S);
console.log('引导记录类型      ' + brvd[0] + '  (0 = 引导记录卷描述符)');
console.log('系统标识          "' + brvd.toString('ascii', 7, 30) + '"');
const catLba = brvd.readUInt32LE(71);
console.log('引导目录 LBA      ' + catLba);

const cat = buf.subarray(catLba * S, (catLba + 1) * S);
let sum = 0;
for (let i = 0; i < 32; i += 2) sum += cat.readUInt16LE(i);
console.log('校验项头部        ' + cat.readUInt8(0) + ' 平台=' + cat.readUInt8(1) +
  ' 标识="' + cat.toString('ascii', 4, 28).replace(/\0+$/, '') + '"');
console.log('校验和            ' + sum + '  (必须为 0 或 0x10000 的倍数: ' + (sum % 0x10000 === 0 ? '通过' : '失败') + ')');
console.log('结束标记          ' + (cat[30] === 0x55 && cat[31] === 0xAA ? '55 AA 通过' : '异常'));

const e = 32;
console.log('默认条目          ' + (cat.readUInt8(e) === 0x88 ? '可启动' : '不可启动') +
  ' 介质=' + cat.readUInt8(e + 1) + '(0=无仿真) 加载段=0x' +
  cat.readUInt16LE(e + 2).toString(16) + ' 扇区数=' + cat.readUInt16LE(e + 6));
const imgLba = cat.readUInt32LE(e + 8);
console.log('引导映像 LBA      ' + imgLba);

const boot = buf.subarray(imgLba * S, imgLba * S + 2048);
console.log('映像前 16 字节    ' + Array.from(boot.subarray(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '));
const dataAddr = boot.readUInt16LE(17);
console.log('字符串地址       0x' + dataAddr.toString(16) + '  (应为 0x7C1F)');
const text = boot.toString('ascii', dataAddr - 0x7C00, dataAddr - 0x7C00 + 2000);
console.log('\n===== 引导扇区将显示的屏幕 =====');
for (let y = 0; y < 25; y++) {
  const line = text.slice(y * 80, y * 80 + 80);
  if (line.trim()) console.log(String(y).padStart(2) + ' |' + line);
}
console.log('=================================');
