'use strict';
// 最小 VNC (RFB) 客户端：把 VMware 客户机的画面抓成 PNG
//
// 为什么需要它：客户机没装 VMware Tools，vmrun captureScreen 用不了；
// 宿主截图又被安全策略拦住。VNC 是唯一可靠的旁路 —— 它直接读客户机的
// 帧缓冲，不依赖客户机里装任何东西。
//
// 用法：node tools/vncshot.js <输出png> [主机] [端口]

const fs = require('fs');
const { encodePng, connect } = require('./vnclib.js');

async function shot(outFile, host, port) {
  const c = await connect(host, port);
  try {
    const rgb = await c.grab();
    fs.writeFileSync(outFile, encodePng(rgb, c.width, c.height));
    console.log('已保存 ' + outFile + '  (' + c.width + 'x' + c.height + ', 桌面 "' + c.name + '")');
  } finally {
    c.close();
  }
}

const out = process.argv[2] || 'vmware/lab/shot.png';
const host = process.argv[3] || '127.0.0.1';
const port = parseInt(process.argv[4] || '5901', 10);

shot(out, host, port).catch((e) => {
  console.error('截图失败: ' + e.message);
  process.exitCode = 1;
});
