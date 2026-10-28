'use strict';
// VNC 鼠标测试：在一个 VNC 会话里注入指针移动，连拍多张截图。
// 用来验证内核的 PS/2 鼠标驱动：光标应该跟着注入的位置走。
//
// VMware 的 VNC 在画面没变化时不回帧缓冲更新，所以每次抓帧都用
// 增量请求轮询，直到画面出现变化（光标移动了）。
//
// 用法：node tools/vncmouse.js <输出png...> [主机] [端口]
//   位置取自 MOUSEDOT 环境变量（"x,y x,y ..."），缺省 "90,60 240,150"，
//   与截图一一对应（不够就在两个位置之间往复）。
//   MOUSEBTN=1 时最后一张截图按住左键（验证按钮指示灯）。

const fs = require('fs');
const { encodePng, connect } = require('./vnclib.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pngs = process.argv.slice(2).filter((a) => /\.png$/i.test(a));
  const host = process.argv.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || '127.0.0.1';
  const port = parseInt((process.argv.find((a) => /^59\d\d$/.test(a)) || '5901'), 10);

  const dots = (process.env.MOUSEDOT || '90,60 240,150')
    .trim().split(/\s+/).map((p) => p.split(',').map(Number));
  while (dots.length < pngs.length) {
    dots.push(dots[(dots.length % 2 === 0) ? 0 : 1]);
  }

  console.log('VNC ' + host + ':' + port + '，路径: ' + dots.map((d) => d.join(',')).join(' -> '));
  const c = await connect(host, port);
  try {
    for (let i = 0; i < pngs.length; i++) {
      const [x, y] = dots[i];
      const last = i === pngs.length - 1;
      const mask = last && process.env.MOUSEBTN === '1' ? 1 : 0;
      c.pointer(x, y, mask);          // 移动（并可选按住左键）

      // 连续抓全帧直到画面出现变化（光标移动 / 时钟跳秒）
      let rgb = null;
      let prev = null;
      for (let tries = 0; tries < 40 && !rgb; tries++) {
        const f = await c.grab({ timeout: 500 });
        if (!f) continue;
        if (prev && !f.equals(prev)) rgb = f;
        else prev = f;
      }
      if (!rgb) throw new Error('画面一直没变化，指针事件可能没生效');
      fs.writeFileSync(pngs[i], encodePng(rgb, c.width, c.height));
      console.log('已保存 ' + pngs[i] + '  （光标应为 ' + x + ',' + y +
                  (mask ? '，左键按住' : '') + '）');
    }
  } finally {
    c.close();
  }
}

main().catch((e) => {
  console.error('鼠标测试失败: ' + e.message);
  process.exitCode = 1;
});
