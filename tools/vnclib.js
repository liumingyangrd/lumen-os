'use strict';
// VNC (RFB) 客户端公共库：RFB 帧缓冲读取 + PNG 编码 + 指针/键盘注入
// 被 vncshot.js（截图）和 vncmouse.js（鼠标测试）共用。

const net = require('net');
const zlib = require('zlib');

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

  // 连接断了/超时：让所有等待中的 read 立刻失败
  fail(e) {
    const ws = this.waiters.splice(0);
    for (const w of ws) w.reject(e);
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
    return new Promise((resolve, reject) => this.waiters.push({ need: n, resolve, reject }));
  }

  // 带超时的 read：超时后把自己从等待队列摘掉（不消耗数据），reject
  readCancel(n, ms) {
    const self = this;
    return new Promise((resolve, reject) => {
      const w = { need: n, resolve, reject };
      const t = setTimeout(() => {
        const i = self.waiters.indexOf(w);
        if (i >= 0) self.waiters.splice(i, 1);
        reject(new Error('read 超时'));
      }, ms);
      w.resolve = (d) => { clearTimeout(t); resolve(d); };
      w.reject = (e) => { clearTimeout(t); reject(e); };
      if (self.buf.length >= n) {
        self.waiters.splice(self.waiters.indexOf(w), 1);
        clearTimeout(t);
        resolve(self.buf.slice(0, n)), (self.buf = self.buf.slice(n));
        return;
      }
      self.waiters.push(w);
    });
  }

  // 写入到"客户端 → 服务器"方向（不经过缓冲区）
  write(b) {
    if (process.env.VNC_DEBUG) console.error('[vnc] 发送', b.length, '字节:', b.toString('hex'));
    this.sock.write(b);
  }
}

/* ---------- 连接 + 握手 + Raw 编码请求 ---------- */
async function connect(host, port) {
  const sock = net.connect({ host, port });
  const rfb = new Rfb(sock);
  sock.on('data', (d) => rfb.push(d));
  // 连接错误/超时必须传播，否则调用方会永远挂在 await read() 上
  sock.on('error', (e) => rfb.fail(e));
  sock.setTimeout(30000, () => {
    const e = new Error('VNC 连接超时（端口未就绪或服务无响应）');
    rfb.fail(e);
    sock.destroy();
  });

  const ver = await rfb.read(12);
  const major = parseInt(ver.toString('ascii', 0, 3), 10);
  if (major < 3) throw new Error('RFB 版本过低: ' + ver.toString('ascii'));
  rfb.write(Buffer.from('RFB 003.008\n', 'ascii'));

  const nTypes = (await rfb.read(1))[0];
  if (nTypes === 0) {
    const reasonLen = (await rfb.read(4)).readUInt32BE(0);
    const reason = (await rfb.read(reasonLen)).toString();
    throw new Error('连接被拒绝: ' + reason);
  }
  const types = await rfb.read(nTypes);
  if (!Array.from(types).includes(1)) {
    throw new Error('需要 VNC 认证（安全类型 ' + Array.from(types).join(',') + '），本工具只支持 None');
  }
  rfb.write(Buffer.from([1]));          // 选 None

  const res = (await rfb.read(4)).readUInt32BE(0);
  if (res !== 0) throw new Error('安全握手失败: ' + res);

  rfb.write(Buffer.from([1]));          // ClientInit（共享）

  const init = await rfb.read(24);
  const width = init.readUInt16BE(0);
  const height = init.readUInt16BE(2);
  const nameLen = init.readUInt32BE(20);
  const name = (await rfb.read(nameLen)).toString('utf8');
  if (process.env.VNC_DEBUG) console.error('[vnc] ServerInit:', width + 'x' + height, '桌面=' + name);

  // 只要 Raw 编码
  const enc = Buffer.alloc(8);
  enc[0] = 2;                    // SetEncodings
  enc[1] = 0;
  enc.writeUInt16BE(1, 2);
  enc.writeInt32BE(0, 4);        // Raw
  rfb.write(enc);

  // 请求整屏并等一帧，返回 RGB 缓冲
  // opts.timeout: 每个读操作的超时（毫秒），超时返回 null
  // 注意：VMware 的 VNC 只回非增量请求，所以这里总是发非增量
  async function grab(opts) {
    opts = opts || {};
    const timeout = opts.timeout || 20000;
    const req = Buffer.alloc(10);
    req[0] = 3;                    // FramebufferUpdateRequest
    req[1] = 0;                    // 非增量
    req.writeUInt16BE(0, 2);
    req.writeUInt16BE(0, 4);
    req.writeUInt16BE(width, 6);
    req.writeUInt16BE(height, 8);
    rfb.write(req);

    const rgb = Buffer.alloc(width * height * 3);
    let got = false;
    while (!got) {
      let type;
      try {
        type = (await rfb.readCancel(1, timeout))[0];
      } catch (e) {
        return null;                    // 超时 = 这一轮没等到帧
      }
      if (type === 0) {
        const hdr = await rfb.readCancel(3, timeout);
        const nRect = hdr.readUInt16BE(1);
        for (let i = 0; i < nRect; i++) {
          const rh = await rfb.readCancel(12, timeout);
          const rx = rh.readUInt16BE(0);
          const ry = rh.readUInt16BE(2);
          const rw = rh.readUInt16BE(4);
          const rh2 = rh.readUInt16BE(6);
          const encoding = rh.readInt32BE(8);
          if (encoding !== 0) throw new Error('不支持的编码: ' + encoding + '（只请求了 Raw）');
          const data = await rfb.readCancel(rw * rh2 * 4, timeout);
          for (let y = 0; y < rh2; y++) {
            for (let x = 0; x < rw; x++) {
              const si = (y * rw + x) * 4;
              const px = data[si] | (data[si + 1] << 8) | (data[si + 2] << 16);
              const di = ((ry + y) * width + (rx + x)) * 3;
              rgb[di] = (px >> 16) & 0xFF;
              rgb[di + 1] = (px >> 8) & 0xFF;
              rgb[di + 2] = px & 0xFF;
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
    return rgb;
  }

  // 注入指针事件（绝对坐标 + 按键掩码）
  function pointer(x, y, mask) {
    const ev = Buffer.alloc(6);
    ev[0] = 4;                              // SetPointerEvent
    ev[1] = mask || 0;
    ev.writeUInt16BE(x, 2);
    ev.writeUInt16BE(y, 4);
    rfb.write(ev);
  }

  function close() { sock.end(); sock.setTimeout(0); }

  return { sock, rfb, width, height, name, grab, pointer, close };
}

module.exports = { encodePng, Rfb, connect };
