/*
 * LUX-32 虚拟机 —— Lumen 系统的"硬件"
 * 自行设计的 32 位 RISC 指令集 + 内存 + 端口设备
 * 无任何第三方依赖，node 与浏览器共用
 *
 * 寄存器: r0..r9 通用, r10 = FP(帧指针), r11 = SP(栈指针)
 * 指令: 32 位定长小端; 立即数 12 位; 需要 32 位立即数的指令占两个字
 */
(function (root) {
  'use strict';

  var MEM_SIZE = 0x01000000;          // 16 MiB
  var VRAM = 0x000B8000;              // 80x25 文本显存 (码点:u32, 属性:u32)
  var VRAM_SIZE = 80 * 25 * 8;
  var WIDE = 0xFFFF;                  // 宽字符占位单元
  var IVT = 0x00000000;               // 256 项 * 8 字节
  var BOOT_ADDR = 0x00007C00;         // 引导扇区装入地址
  var FS_BASE_LBA = 512;              // 磁盘镜像中文件系统起始扇区

  var OP = {
    NOP: 0x00, LDI: 0x01, MOV: 0x02, LD: 0x03, ST: 0x04, LDB: 0x05, STB: 0x06,
    ADD: 0x07, SUB: 0x08, MUL: 0x09, DIV: 0x0A, MOD: 0x0B,
    AND: 0x0C, OR: 0x0D, XOR: 0x0E, SHL: 0x0F, SHR: 0x10, SAR: 0x11,
    NOT: 0x12, NEG: 0x13, CMP: 0x14,
    JMP: 0x15, JZ: 0x16, JNZ: 0x17, JL: 0x18, JLE: 0x19, JG: 0x1A, JGE: 0x1B,
    CALL: 0x1C, RET: 0x1D, PUSH: 0x1E, POP: 0x1F, JR: 0x20,
    SYS: 0x21, IN: 0x22, OUT: 0x23, IRET: 0x24, EI: 0x25, DI: 0x26, HLT: 0x27,
    ADDI: 0x2A, OUTR: 0x2B, INR: 0x2C
  };

  function Machine(opts) {
    opts = opts || {};
    this.mem = new Uint8Array(MEM_SIZE);
    this.dv = new DataView(this.mem.buffer);
    this.r = new Int32Array(12);
    this.pc = 0;
    this.zf = 0; this.sf = 0; this.cf = 0;
    this.IF = 0;
    this.halted = false;
    this.dead = false;              // 不可恢复错误
    this.cycles = 0;
    this.instrs = 0;
    this.ticks = 0;                 // 100Hz
    this.pending = 0;               // 最近一个挂起向量(显示用)
    this.pendingVecs = [];          // 挂起中断队列
    this.keyQueue = [];
    this.disk = new Uint8Array(0);
    this.sector = new Uint8Array(512);
    this.sectorPtr = 0;
    this.lba = 0;
    this.cursor = 0;
    this.rtcIdx = 0;
    this.crIdx = 0x0f;
    this.fault = '';
    this.timerEnabled = true;
    this.trace = null;              // 调试：指令日志开关
    this.log = [];
    this.lastScreen = null;
    this._screenCache = '';
  }

  Machine.prototype.reset = function () {
    this.r.fill(0);
    this.r[11] = 0x001F0000;
    this.pc = 0;
    this.IF = 0; this.zf = 0; this.sf = 0; this.cf = 0;
    this.halted = false; this.dead = false;
    this.cycles = 0; this.instrs = 0; this.ticks = 0;
    this.pending = 0; this.pendingVecs = []; this.keyQueue = [];
    this.cursor = 0;
  };

  // ---------- 内存 ----------
  Machine.prototype.rd32 = function (a) {
    a = a | 0;
    if (a < 0 || a + 4 > MEM_SIZE) { this.raiseFault('read out of memory @0x' + (a >>> 0).toString(16)); return 0; }
    return this.dv.getInt32(a, true);
  };
  Machine.prototype.wr32 = function (a, v) {
    a = a | 0;
    if (a < 0 || a + 4 > MEM_SIZE) { this.raiseFault('write out of memory @0x' + (a >>> 0).toString(16)); return; }
    this.dv.setInt32(a, v, true);
  };
  Machine.prototype.rd8 = function (a) {
    a = a | 0;
    if (a < 0 || a >= MEM_SIZE) { this.raiseFault('read byte out of memory'); return 0; }
    return this.mem[a];
  };
  Machine.prototype.wr8 = function (a, v) {
    a = a | 0;
    if (a < 0 || a >= MEM_SIZE) { this.raiseFault('write byte out of memory'); return; }
    this.mem[a] = v & 0xff;
  };
  Machine.prototype.push = function (v) {
    var sp = (this.r[11] - 4) | 0;
    this.r[11] = sp;
    this.wr32(sp, v);
  };
  Machine.prototype.pop = function () {
    var v = this.rd32(this.r[11]);
    this.r[11] = (this.r[11] + 4) | 0;
    return v;
  };

  Machine.prototype.raiseFault = function (msg) {
    if (!this.dead) { this.dead = true; this.fault = msg; }
  };

  // ---------- 端口设备 ----------
  Machine.prototype.inb = function (port) {
    switch (port) {
      case 0x40: return this.ticks | 0;                       // PIT 计数器
      case 0x60: return this.keyQueue.length ? this.keyQueue.shift() : 0;
      case 0x64: return this.keyQueue.length ? 1 : 0;
      case 0x71: return this.rtcRead();
      case 0x3D5: return (this.crIdx === 0x0F ? (this.cursor & 0xff) : (this.cursor >> 8) & 0xff);
      case 0x1F0: return this.disk.length / 512 | 0;          // 扇区总数
      case 0x1F4: {                                           // 扇区数据(逐字节)
        if (this.sectorPtr >= 512) return 0;
        return this.sector[this.sectorPtr++];
      }
      case 0x1F5: return this.sectorPtr;
      default: return 0;
    }
  };

  Machine.prototype.outb = function (port, val) {
    switch (port) {
      case 0x20: break;                                        // EOI
      case 0x70: this.rtcIdx = val & 0xff; break;
      case 0x3D4: this.crIdx = val & 0xff; break;
      case 0x3D5:
        if (this.crIdx === 0x0F) this.cursor = (this.cursor & 0x3F00) | (val & 0xff);
        else if (this.crIdx === 0x0E) this.cursor = (this.cursor & 0xff) | ((val & 0x3f) << 8);
        break;
      case 0x1F1: this.lba = val & 0xffff; break;
      case 0x1F2:                                              // 磁盘命令
        if (val === 1 || val === 2) {
          var off = this.lba * 512;
          if (off >= 0 && off + 512 <= this.disk.length) {
            if (val === 1) this.sector.set(this.disk.subarray(off, off + 512));
            else this.disk.set(this.sector, off);
          }
          this.sectorPtr = 0;
        } else if (val === 0) this.sectorPtr = 0;
        break;
      case 0x1F4:
        if (this.sectorPtr < 512) this.sector[this.sectorPtr++] = val & 0xff;
        break;
      default: break;
    }
  };

  Machine.prototype.rtcRead = function () {
    var d = new Date();
    switch (this.rtcIdx) {
      case 0: return d.getSeconds();
      case 2: return d.getMinutes();
      case 4: return d.getHours();
      case 6: return d.getDay();
      case 7: return d.getDate();
      case 8: return d.getMonth() + 1;
      case 9: return d.getFullYear() - 2000;
      default: return 0;
    }
  };

  // ---------- 中断 ----------
  Machine.prototype.raiseIRQ = function (vec) {
    if (this.dead) return;
    if (!this.IF) {
      if (this.pendingVecs.indexOf(vec) < 0) this.pendingVecs.push(vec);
      this.pending = vec;
      return;
    }
    this.halted = false;
    this.deliver(vec);
  };

  Machine.prototype.takePending = function () {
    if (!this.pendingVecs.length) return 0;
    var v = this.pendingVecs.shift();
    this.pending = this.pendingVecs.length ? this.pendingVecs[0] : 0;
    return v;
  };

  Machine.prototype.deliver = function (vec) {
    var ivtAddr = IVT + vec * 8;
    var handler = this.rd32(ivtAddr);
    if (!handler) { this.raiseFault('unhandled interrupt 0x' + vec.toString(16)); return; }
    this.pending = this.pendingVecs.length ? this.pendingVecs[0] : 0;
    this.push(this.pc);                 // 先压返回地址(在栈底)
    this.push((this.IF ? 1 : 0));       // 再压标志(在栈顶, iret 先弹出)
    this.IF = 0;
    this.pc = handler;
    this.halted = false;
  };

  // ---------- 执行 ----------
  Machine.prototype.step = function () {
    if (this.dead) return false;
    if (this.halted) {
      var pv = this.takePending();
      if (pv && this.IF) { this.halted = false; this.deliver(pv); }
      else { if (pv) this.pendingVecs.unshift(pv); return false; }
    }
    var pc = this.pc;
    if (pc < 0 || pc + 4 > MEM_SIZE) { this.raiseFault('pc out of range'); return false; }
    var ir = this.dv.getUint32(pc, true);
    var op = (ir >>> 24) & 0xff;
    var rd = (ir >>> 20) & 0xf;
    var ra = (ir >>> 16) & 0xf;
    var rb = (ir >>> 12) & 0xf;
    var imm = ((ir << 20) >> 20) | 0;         // 符号扩展 12 位
    var immu = ir & 0xfff;
    var r = this.r;
    var npc = pc + 4;
    var a, b, res, ea;

    switch (op) {
      case OP.NOP: break;
      case OP.LDI:
        r[rd] = this.rd32(pc + 4); npc = pc + 8; break;
      case OP.MOV: r[rd] = r[ra]; break;
      case OP.LD: ea = (r[ra] + imm) | 0; r[rd] = this.rd32(ea); break;
      case OP.ST: ea = (r[ra] + imm) | 0; this.wr32(ea, r[rb]); break;
      case OP.LDB: ea = (r[ra] + imm) | 0; r[rd] = this.rd8(ea) & 0xff; break;
      case OP.STB: ea = (r[ra] + imm) | 0; this.wr8(ea, r[rb]); break;
      case OP.ADD: res = (r[ra] + r[rb]) | 0; r[rd] = res; this.setZS(res); break;
      case OP.SUB: res = (r[ra] - r[rb]) | 0; r[rd] = res; this.setZS(res); break;
      case OP.MUL: res = Math.imul(r[ra], r[rb]); r[rd] = res; this.setZS(res); break;
      case OP.DIV:
        b = r[rb];
        if (b === 0) { res = 0; this.cf = 0; }
        else if (r[ra] === -2147483648 && b === -1) res = -2147483648;
        else res = (r[ra] / b) | 0;
        r[rd] = res; this.setZS(res); break;
      case OP.MOD:
        b = r[rb];
        res = b === 0 ? 0 : (r[ra] % b) | 0;
        r[rd] = res; this.setZS(res); break;
      case OP.AND: res = r[ra] & r[rb]; r[rd] = res; this.setZS(res); break;
      case OP.OR: res = r[ra] | r[rb]; r[rd] = res; this.setZS(res); break;
      case OP.XOR: res = r[ra] ^ r[rb]; r[rd] = res; this.setZS(res); break;
      case OP.SHL: res = (r[ra] << (r[rb] & 31)) | 0; r[rd] = res; this.setZS(res); break;
      case OP.SHR: res = (r[ra] >>> (r[rb] & 31)) | 0; r[rd] = res; this.setZS(res); break;
      case OP.SAR: res = (r[ra] >> (r[rb] & 31)) | 0; r[rd] = res; this.setZS(res); break;
      case OP.NOT: r[rd] = ~r[ra]; this.setZS(r[rd]); break;
      case OP.NEG: r[rd] = (-r[ra]) | 0; this.setZS(r[rd]); break;
      case OP.CMP:
        a = r[ra]; b = r[rb];
        this.cf = a < b ? -1 : (a > b ? 1 : 0);
        this.zf = a === b ? 1 : 0;
        this.sf = (a - b) < 0 ? 1 : 0;
        break;
      case OP.JMP: npc = this.rd32(pc + 4); break;
      case OP.JZ: if (this.zf) npc = this.rd32(pc + 4); else npc = pc + 8; break;
      case OP.JNZ: if (!this.zf) npc = this.rd32(pc + 4); else npc = pc + 8; break;
      case OP.JL: if (this.cf < 0) npc = this.rd32(pc + 4); else npc = pc + 8; break;
      case OP.JLE: if (this.cf <= 0) npc = this.rd32(pc + 4); else npc = pc + 8; break;
      case OP.JG: if (this.cf > 0) npc = this.rd32(pc + 4); else npc = pc + 8; break;
      case OP.JGE: if (this.cf >= 0) npc = this.rd32(pc + 4); else npc = pc + 8; break;
      case OP.CALL: this.push(pc + 8); npc = this.rd32(pc + 4); break;
      case OP.RET: npc = this.pop(); break;
      case OP.PUSH: this.push(r[ra]); break;
      case OP.POP: r[rd] = this.pop(); break;
      case OP.JR: npc = r[ra]; break;
      case OP.SYS: this.softInt(0x80); npc = this.pc; return true;
      case OP.IN: r[rd] = this.inb(immu); break;
      case OP.OUT: this.outb(immu, r[ra]); break;
      case OP.IRET:
        this.IF = this.pop() & 1;
        npc = this.pop();
        break;
      case OP.EI:
        this.IF = 1;
        if (this.pendingVecs.length) { this.deliver(this.takePending()); this.instrs++; this.cycles++; return true; }
        break;
      case OP.DI: this.IF = 0; break;
      case OP.HLT: this.halted = true; npc = pc + 4; break;
      case OP.ADDI: res = (r[ra] + imm) | 0; r[rd] = res; this.setZS(res); break;
      case OP.OUTR: this.outb(r[ra] | 0, r[rb] | 0); break;
      case OP.INR: r[rd] = this.inb(r[ra] | 0) | 0; break;
      default:
        this.raiseFault('bad opcode 0x' + op.toString(16) + ' @0x' + pc.toString(16));
        return false;
    }
    if (this.trace) this.log.push(pc.toString(16));
    this.pc = npc | 0;
    this.instrs++;
    this.cycles++;
    // 中断被挂起时, 一旦 IF 恢复就立刻投递
    if (this.IF && this.pendingVecs.length) this.deliver(this.takePending());
    return true;
  };

  Machine.prototype.setZS = function (v) {
    this.zf = v === 0 ? 1 : 0;
    this.sf = v < 0 ? 1 : 0;
  };

  Machine.prototype.softInt = function (vec) {
    var handler = this.rd32(IVT + vec * 8);
    if (!handler) { this.raiseFault('unhandled software interrupt 0x' + vec.toString(16)); return; }
    this.push(this.pc + 4);          // SYS 指令之后
    this.push(this.IF ? 1 : 0);
    this.IF = 0;
    this.pc = handler;
  };

  Machine.prototype.run = function (budget) {
    budget = budget || 200000;
    var n = 0;
    while (n < budget) {
      if (this.dead || this.halted) break;
      if (!this.step()) break;
      n++;
    }
    return n;
  };

  // ---------- 引导 ----------
  Machine.prototype.loadImage = function (bytes) {
    this.reset();
    this.disk = bytes;
    // 搬运引导扇区到 0x7C00
    this.mem.set(bytes.subarray(0, 512), BOOT_ADDR);
    this.pc = BOOT_ADDR;
    this.IF = 0;
  };

  Machine.prototype.attachDisk = function (bytes) { this.disk = bytes; };

  // ---------- 显存 ----------
  Machine.prototype.screenText = function () {
    var out = '';
    for (var y = 0; y < 25; y++) {
      var line = '';
      for (var x = 0; x < 80; x++) {
        var cp = this.dv.getUint32(VRAM + (y * 80 + x) * 8, true);
        if (cp === WIDE) continue;
        if (cp === 0) line += ' ';
        else if (cp < 0x110000) {
          try { line += String.fromCodePoint(cp); } catch (e) { line += ' '; }
        }
      }
      out += line.replace(/\s+$/, '') + '\n';
    }
    return out;
  };

  Machine.prototype.screenCells = function () {
    var out = new Int32Array(2000 * 2);
    for (var i = 0; i < 2000; i++) {
      out[i * 2] = this.dv.getInt32(VRAM + i * 8, true);
      out[i * 2 + 1] = this.dv.getInt32(VRAM + i * 8 + 4, true);
    }
    return out;
  };

  Machine.prototype.regs = function () {
    var r = this.r, o = {};
    for (var i = 0; i < 10; i++) o['r' + i] = r[i];
    o.fp = r[10]; o.sp = r[11]; o.pc = this.pc;
    return o;
  };

  var api = {
    Machine: Machine, OP: OP, MEM_SIZE: MEM_SIZE,
    VRAM: VRAM, IVT: IVT, BOOT_ADDR: BOOT_ADDR, FS_BASE_LBA: FS_BASE_LBA
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LUX = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
