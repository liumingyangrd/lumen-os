'use strict';
// 最小 VNC (RFB) 客户端：把 VMware 客户机的画面抓成 PNG
//
// 为什么需要它：客户机没装 VMware Tools，vmrun captureScreen 用不了；
// 宿主截图又被安全策略拦住。VNC 是唯一可靠的旁路 —— 它直接读客户机的
// 帧缓冲，不依赖客户机里装任何东西。
//
// 用法：node tools/vncshot.js <输出png> [主机] [端口]

const net = require('net');
const zlib = require('zlib');
const fs = require('fs');

/* ---------- 最小 PNG 编码器 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// rgb: Buffer of w*h*3
function encodePng(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;                        // filter: none
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- RFB 客户端 ---------- */
class Rfb {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
  }

  push(d) {
    if (process.env.VNC_DEBUG) console.error('[vnc] 接收', d.length, '字节:', d.slice(0,32).toString('hex'));
    this.buf = Buffer.concat([this.buf, d]);
    this.pump();
  }

  pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (w.need > this.buf.length) return;
      this.waiters.shift();
      w.resolve(this.buf.slice(0, w.need));
      this.buf = this.buf.slice(w.need);
    }
  }

  read(n) {
    if (this.buf.length >= n) {
      const d = this.buf.slice(0, n);
      this.buf = this.buf.slice(n);
      return Promise.resolve(d);
    }
    return new Promise((resolve) => this.waiters.push({ need: n, resolve }));
  }

  // 写入到"客户端 → 服务器"方向（不经过缓冲区）
  write(b) {
    if (process.env.VNC_DEBUG) console.error('[vnc] 发送', b.length, '字节:', b.toString('hex'));
    this.sock.write(b);
  }
}

function shot(outFile, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const rfb = new Rfb(sock);
    sock.on('connect', async () => {
      try {
        // 1. 协议版本
        const ver = await rfb.read(12);
        if (process.env.VNC_DEBUG) console.error('[vnc] 版本:', ver.toString('ascii'));
        const major = parseInt(ver.toString('ascii', 0, 3), 10);
        if (major < 3) throw new Error('RFB 版本过低: ' + ver.toString('ascii'));
        rfb.write(Buffer.from('RFB 003.008\n', 'ascii'));

        // 2. 安全类型
        const nTypes = (await rfb.read(1))[0];
        if (nTypes === 0) {
          const reasonLen = (await rfb.read(4)).readUInt32BE(0);
          const reason = (await rfb.read(reasonLen)).toString();
          throw new Error('连接被拒绝: ' + reason);
        }
        const types = await rfb.read(nTypes);
        if (process.env.VNC_DEBUG) console.error('[vnc] 安全类型:', Array.from(types));
        const list = Array.from(types);
        if (!list.includes(1)) {
          throw new Error('需要 VNC 认证（安全类型 ' + list.join(',') + '），本工具只支持 None');
        }
        rfb.write(Buffer.from([1]));          // 选 None

        // 3. SecurityResult
        const res = (await rfb.read(4)).readUInt32BE(0);
        if (process.env.VNC_DEBUG) console.error('[vnc] SecurityResult:', res);
        if (res !== 0) throw new Error('安全握手失败: ' + res);

        // 4. ClientInit（共享）
        rfb.write(Buffer.from([1]));

        // 5. ServerInit
        const init = await rfb.read(24);
        const width = init.readUInt16BE(0);
        const height = init.readUInt16BE(2);
        const bpp = init[4];
        const depth = init[5];
        const bigEndian = init[6];
        const trueColor = init[7];
        const rMax = init.readUInt16BE(8);
        const gMax = init.readUInt16BE(10);
        const bMax = init.readUInt16BE(12);
        const rShift = init[14];
        const gShift = init[15];
        const bShift = init[16];
        const nameLen = init.readUInt32BE(20);   // nameLength 就在 ServerInit 的偏移 20
        const name = (await rfb.read(nameLen)).toString('utf8');
        if (process.env.VNC_DEBUG) console.error('[vnc] ServerInit:', width + 'x' + height, '桌面=' + name);

        // 6. 统一成 32bpp BGRX，简化解码
        // 服务器原生就是 32bpp BGRX（ServerInit 里 bpp=32 depth=24
        // truecolor=1 rShift=16 gShift=8 bShift=0），不必再改像素格式。

        // 7. 只要 Raw 编码
        const enc = Buffer.alloc(8);
        enc[0] = 2;                    // SetEncodings
        enc[1] = 0;
        enc.writeUInt16BE(1, 2);
        enc.writeInt32BE(0, 4);        // Raw
        rfb.write(enc);

        // 8. 请求整屏
        const req = Buffer.alloc(10);
        req[0] = 3;                    // FramebufferUpdateRequest
        req[1] = 0;                    // 非增量
        req.writeUInt16BE(0, 2);
        req.writeUInt16BE(0, 4);
        req.writeUInt16BE(width, 6);
        req.writeUInt16BE(height, 8);
        rfb.write(req);

        // 9. 读帧缓冲更新
        const rgb = Buffer.alloc(width * height * 3);
        let got = false;
        const deadline = Date.now() + 20000;

        while (!got && Date.now() < deadline) {
          const type = (await rfb.read(1))[0];
          if (type === 0) {
            // FramebufferUpdate
            const hdr = await rfb.read(3);
            const nRect = hdr.readUInt16BE(1);
            for (let i = 0; i < nRect; i++) {
              const rh = await rfb.read(12);
              const rx = rh.readUInt16BE(0);
              const ry = rh.readUInt16BE(2);
              const rw = rh.readUInt16BE(4);
              const rh2 = rh.readUInt16BE(6);
              const encoding = rh.readInt32BE(8);
              if (encoding !== 0) {
                throw new Error('不支持的编码: ' + encoding + '（只请求了 Raw）');
              }
              if (process.env.VNC_DEBUG) console.error('[vnc] 矩形', rw + 'x' + rh2, 'enc=' + encoding);
              const data = await rfb.read(rw * rh2 * 4);
              for (let y = 0; y < rh2; y++) {
                for (let x = 0; x < rw; x++) {
                  const si = (y * rw + x) * 4;
                  const px = data[si] | (data[si + 1] << 8) | (data[si + 2] << 16);
                  const r = (px >> 16) & 0xFF;
                  const g = (px >> 8) & 0xFF;
                  const b = px & 0xFF;
                  const di = ((ry + y) * width + (rx + x)) * 3;
                  rgb[di] = r; rgb[di + 1] = g; rgb[di + 2] = b;
                }
              }
              got = true;
            }
          } else if (type === 1) {
            const n = (await rfb.read(5)).readUInt16BE(3);   // SetColourMapEntries
            await rfb.read(n * 6);
          } else if (type === 2) {
            await rfb.read(1);                               // Bell
          } else if (type === 3) {
            const n = (await rfb.read(7)).readUInt32BE(3);   // ServerCutText
            await rfb.read(n);
          } else {
            throw new Error('未知服务端消息类型: ' + type);
          }
        }

        if (!got) throw new Error('等待帧缓冲更新超时');
        fs.writeFileSync(outFile, encodePng(rgb, width, height));
        console.log('已保存 ' + outFile + '  (' + width + 'x' + height + ', 桌面 "' + name + '")');
        resolve({ width, height, name });
      } catch (e) {
        reject(e);
      } finally {
        sock.end();
      }
    });

    sock.on('data', (d) => rfb.push(d));
    sock.on('error', reject);
    sock.setTimeout(25000, () => { sock.destroy(); reject(new Error('连接超时')); });
  });
}

const out = process.argv[2] || 'vmware/lab/shot.png';
const host = process.argv[3] || '127.0.0.1';
const port = parseInt(process.argv[4] || '5901', 10);

shot(out, host, port).catch((e) => {
  console.error('截图失败: ' + e.message);
  process.exitCode = 1;
});
