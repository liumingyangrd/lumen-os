/*
 * LUX-32 汇编器 luxasm
 * 两遍扫描 · 符号表 · 宏 · 伪指令 · 重定位表
 * 直接产出可加载的机器码镜像
 */
(function (root) {
  'use strict';
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
  // 三寄存器类
  var RR3 = { add: OP.ADD, sub: OP.SUB, mul: OP.MUL, div: OP.DIV, mod: OP.MOD, and: OP.AND, or: OP.OR, xor: OP.XOR, shl: OP.SHL, shr: OP.SHR, sar: OP.SAR };
  var RR2 = { not: OP.NOT, neg: OP.NEG };
  var JUMP2 = { jmp: OP.JMP, jz: OP.JZ, jnz: OP.JNZ, jl: OP.JL, jle: OP.JLE, jg: OP.JG, jge: OP.JGE, call: OP.CALL };

  function AsmError(msg, line) { this.message = msg + (line ? '  (行 ' + line + ')' : ''); }

  function regNum(tok, line) {
    tok = tok.trim().toLowerCase();
    if (tok === 'sp') return 11;
    if (tok === 'fp') return 10;
    if (tok === 'zr') return 9;  // r9 常被用零
    var m = /^r(\d+)$/.exec(tok);
    if (!m) throw new AsmError('需要寄存器，得到 "' + tok + '"', line);
    var n = parseInt(m[1], 10);
    if (n < 0 || n > 11) throw new AsmError('寄存器越界 r' + n, line);
    return n;
  }

  function stripComment(s) {
    var out = '', inStr = false, esc = false;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (inStr) {
        out += c;
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; out += c; continue; }
      if (c === ';') break;
      if (c === '/' && s[i + 1] === '/') break;
      out += c;
    }
    return out;
  }

  function splitOps(s) {
    var parts = [], cur = '', depth = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '[') depth++;
      if (c === ']') depth--;
      if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim() !== '' || parts.length) parts.push(cur.trim());
    return parts;
  }

  function parseImmText(t) { return t.trim(); }

  // 助记符别名归一: jmpi/jzi/... -> jmp/jz/..., li -> ldi
  function normalizeOp(op) {
    if (op === 'li') return 'ldi';
    if (JUMP2[op] === undefined && op.length > 1 && op.charAt(op.length - 1) === 'i') {
      var base = op.slice(0, -1);
      if (JUMP2[base] !== undefined) return base;
    }
    return op;
  }

  // ---------- 表达式求值 ----------
  function evalExpr(text, symbols, line) {
    var pos = 0, src = text.replace(/\s+/g, '');
    var usedSymbol = false;
    function peek() { return src[pos]; }
    function num() {
      if (peek() === "'") {           // 字符常量
        pos++;
        var ch = src[pos++];
        if (ch === '\\') {
          var e = src[pos++];
          var map = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39, '"': 34 };
          ch = String.fromCharCode(map[e] !== undefined ? map[e] : e.charCodeAt(0));
        }
        if (src[pos] === "'") pos++;
        return ch.charCodeAt(0);
      }
      if (peek() === '(') {
        pos++;
        var v = expr();
        if (peek() === ')') pos++;
        return v;
      }
      if (src.startsWith('lo(', pos)) { pos += 3; var a = expr(); if (src[pos] === ')') pos++; return a & 0xff; }
      if (src.startsWith('hi(', pos)) { pos += 3; var b = expr(); if (src[pos] === ')') pos++; return (b >>> 8) & 0xff; }
      if (peek() === '-') { pos++; return -num(); }
      if (peek() === '~') { pos++; return ~num(); }
      var m = /^(0x[0-9a-fA-F]+|0b[01]+|\d+)/.exec(src.slice(pos));
      if (m) { pos += m[0].length; return m[0].startsWith('0x') ? parseInt(m[0], 16) : m[0].startsWith('0b') ? parseInt(m[0].slice(2), 2) : parseInt(m[0], 10); }
      var id = /^[A-Za-z_.$][A-Za-z0-9_.$]*/.exec(src.slice(pos));
      if (id) {
        pos += id[0].length;
        var name = id[0];
        if (symbols[name] === undefined) throw new AsmError('未定义符号 "' + name + '"', line);
        usedSymbol = true;
        return symbols[name];
      }
      throw new AsmError('表达式非法: "' + text + '"', line);
    }
    function term() {
      var v = num();
      for (; ;) {
        if (peek() === '*') { pos++; v = v * num(); }
        else if (peek() === '/') { pos++; v = (v / num()) | 0; }
        else if (peek() === '%') { pos++; v = v % num(); }
        else break;
      }
      return v;
    }
    function expr() {
      var v = term();
      for (; ;) {
        if (peek() === '+') { pos++; v = v + term(); }
        else if (peek() === '-') { pos++; v = v - term(); }
        else if (peek() === '|') { pos++; v = v | term(); }
        else if (peek() === '&') { pos++; v = v & term(); }
        else if (peek() === '^') { pos++; v = v ^ term(); }
        else if (src.startsWith('<<', pos)) { pos += 2; v = v << term(); }
        else if (src.startsWith('>>', pos)) { pos += 2; v = v >> term(); }
        else break;
      }
      return v;
    }
    var val = expr();
    if (pos !== src.length) throw new AsmError('表达式尾部多余: "' + src.slice(pos) + '"', line);
    return { value: val | 0, hasSymbol: usedSymbol };
  }

  function utf8Encode(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var cp = str.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return out;
  }

  function parseString(text, line) {
    var raw = '', i = 0, s = text.trim();
    while (i < s.length) {
      if (s[i] !== '"') throw new AsmError('字符串格式错误', line);
      i++;
      while (i < s.length && s[i] !== '"') {
        var c = s[i++];
        if (c === '\\') {
          var e = s[i++];
          var map = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, '"': 34, "'": 39, 'e': 27, b: 8 };
          if (e === 'x') {
            var h = s.substr(i, 2); i += 2;
            raw += String.fromCharCode(parseInt(h, 16) & 0xff);
          } else raw += String.fromCharCode(map[e] !== undefined ? map[e] : e.charCodeAt(0));
        } else raw += c;
      }
      if (s[i] !== '"') throw new AsmError('字符串未闭合', line);
      i++;
    }
    return utf8Encode(raw);
  }

  /*
   * assemble(source, {base})
   * -> { code:Uint8Array, base, entry, symbols, relocs:[wordOffset...], org }
   */
  function assemble(source, opts) {
    opts = opts || {};
    var lines = source.split(/\r?\n/);
    var symbols = Object.create(null);
    var equ = Object.create(null);
    var macros = Object.create(null);
    var items = [];       // 中间表示
    var base = opts.base || 0;
    var hasOrg = false;

    // ---- 第一遍：展开宏、收集指令 ----
    var macroName = null, macroBody = null;
    for (var ln = 0; ln < lines.length; ln++) {
      var raw = stripComment(lines[ln]);
      if (!raw.trim()) continue;
      var line = raw.trim();
      var lineNo = ln + 1;

      if (line.startsWith('.macro')) {
        macroName = line.split(/\s+/)[1];
        macroBody = [];
        continue;
      }
      if (line.startsWith('.endmacro')) {
        if (macroName) macros[macroName] = macroBody;
        macroName = null; macroBody = null;
        continue;
      }
      if (macroName) { macroBody.push(line); continue; }
      if (line.startsWith('.include')) continue;  // 由 build 预处理

      // 标签
      var lb = /^([A-Za-z_.$][A-Za-z0-9_.$]*):/.exec(line);
      if (lb) {
        items.push({ t: 'label', name: lb[1], line: lineNo });
        line = line.slice(lb[0].length).trim();
        if (!line) continue;
      }

      if (line.startsWith('.')) {
        var d = line.split(/\s+/);
        var dir = d[0].toLowerCase();
        var rest = line.slice(d[0].length).trim();
        if (dir === '.org') {
          var o = evalExpr(rest, equ, lineNo).value;
          items.push({ t: 'org', addr: o, line: lineNo });
          hasOrg = true;
        } else if (dir === '.equ' || dir === '.set') {
          var parts = splitOps(rest);
          equ[parts[0].trim()] = evalExpr(parts[1], equ, lineNo).value;
        } else if (dir === '.global' || dir === '.entry' || dir === '.export') {
          if (dir === '.entry') equ.__entry = rest.trim();
          items.push({ t: 'global', name: rest.trim(), line: lineNo });
        } else if (dir === '.align') {
          var al = evalExpr(rest, equ, lineNo).value;
          items.push({ t: 'align', n: al, line: lineNo });
        } else if (dir === '.space' || dir === '.zero') {
          items.push({ t: 'space', n: evalExpr(rest, equ, lineNo).value, line: lineNo });
        } else if (dir === '.string') {
          items.push({ t: 'bytes', data: parseString(rest, lineNo), line: lineNo });
        } else if (dir === '.asciz' || dir === '.asciiz') {
          var sd = parseString(rest, lineNo); sd.push(0);
          items.push({ t: 'bytes', data: sd, line: lineNo });
        } else if (dir === '.byte') {
          var bs = splitOps(rest).map(function (p) { return evalExpr(p, equ, lineNo).value & 0xff; });
          items.push({ t: 'bytes', data: bs, line: lineNo });
        } else if (dir === '.word' || dir === '.long') {
          var ws = splitOps(rest).map(function (p) { return p.trim(); });
          items.push({ t: 'words', exprs: ws, line: lineNo });
        } else if (dir === '.size' || dir === '.type' || dir === '.section' || dir === '.text' || dir === '.data') {
          // 忽略（单段模型）
        } else {
          throw new AsmError('未知伪指令 ' + dir, lineNo);
        }
        continue;
      }

      // 宏调用
      if (macros[line.trim()]) {
        var body = macros[line.trim()];
        for (var k = 0; k < body.length; k++) lines.splice(ln + 1 + k, 0, body[k]);
        continue;
      }

      // 指令
      var mm = /^([a-z]+)\s*(.*)$/i.exec(line);
      if (!mm) throw new AsmError('无法解析: ' + line, lineNo);
      items.push({ t: 'ins', op: normalizeOp(mm[1].toLowerCase()), args: mm[2].trim(), line: lineNo });
    }

    // ---- 第二遍：分配地址 ----
    var addr = base, entryAddr = null, entryName = equ.__entry || opts.entry || null;
    var minAddr = Infinity, maxAddr = 0;
    function sizeOf(it) {
      switch (it.t) {
        case 'ins': {
          var op = it.op;
          if (op === 'ldi' || JUMP2[op] !== undefined) return 8;
          return 4;
        }
        case 'words': return it.exprs.length * 4;
        case 'bytes': return it.data.length;
        case 'space': return it.n;
        case 'align': return 0;
        default: return 0;
      }
    }
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.t === 'org') { addr = it.addr; if (base === 0) minAddr = Math.min(minAddr, addr); continue; }
      if (it.t === 'label') { symbols[it.name] = addr; if (it.name === entryName) entryAddr = addr; continue; }
      if (it.t === 'global') { continue; }
      if (it.t === 'align') { addr = (addr + it.n - 1) & ~(it.n - 1); continue; }
      it.addr = addr;
      addr += sizeOf(it);
    }
    if (items.length && symbols[entryName] === undefined && entryName) throw new AsmError('找不到入口符号 ' + entryName);
    if (entryAddr === null) {
      // 默认取最小地址处的第一条指令
      for (var j = 0; j < items.length; j++) if (items[j].addr !== undefined) { entryAddr = items[j].addr; break; }
      if (entryAddr === null) entryAddr = base;
    }
    var startAddr = Infinity;
    for (var j2 = 0; j2 < items.length; j2++) if (items[j2].addr !== undefined) { startAddr = items[j2].addr; break; }
    if (!isFinite(startAddr)) startAddr = base;

    // ---- 第三遍：编码 ----
    var code = new Uint8Array(Math.max(0, addr - startAddr));
    var dv = new DataView(code.buffer);
    var relocs = [];
    var emitPos = 0;

    function putWord(at, v) { dv.setInt32(at - startAddr, v | 0, true); }
    function symTable() { return Object.assign(Object.create(null), symbols, equ); }

    for (var i2 = 0; i2 < items.length; i2++) {
      var it2 = items[i2];
      if (it2.addr === undefined) continue;
      var at = it2.addr;
      emitPos = at - startAddr;
      if (it2.t === 'bytes') {
        for (var b = 0; b < it2.data.length; b++) code[emitPos + b] = it2.data[b];
      } else if (it2.t === 'space') {
        for (var s = 0; s < it2.n; s++) code[emitPos + s] = 0;
      } else if (it2.t === 'words') {
        for (var w = 0; w < it2.exprs.length; w++) {
          var ev = evalExpr(it2.exprs[w], symTable(), it2.line);
          putWord(at + w * 4, ev.value);
          if (ev.hasSymbol) relocs.push(at + w * 4 - startAddr);
        }
      } else if (it2.t === 'ins') {
        var enc = encode(it2, symTable(), at, relocs, startAddr);
        for (var e = 0; e < enc.length; e++) dv.setUint8(emitPos + e, enc[e]);
      }
    }

    // 未使用
    void minAddr; void maxAddr;
    return {
      code: code, base: startAddr, entry: entryAddr, symbols: symbols,
      relocs: relocs, size: code.length, entryName: entryName
    };
  }

  function encode(it, symbols, at, relocs, startAddr) {
    var op = it.op;
    if (JUMP2[op] === undefined && op.length > 1 && op.charAt(op.length - 1) === 'i') {
      var base = op.slice(0, -1);
      if (JUMP2[base] !== undefined) op = base;
    }
    var args = it.args ? splitOps(it.args) : [];
    var line = it.line;
    var L = new Uint8Array(8);
    var dv = new DataView(L.buffer);
    function word0(opcode, rd, ra, rb, imm) {
      return ((opcode << 24) | ((rd & 15) << 20) | ((ra & 15) << 16) | ((rb & 15) << 12) | (imm & 0xfff)) >>> 0;
    }
    function w32(opcode, rd, ra, rb, expr) {
      var ev = evalExpr(expr, symbols, line);
      dv.setUint32(0, word0(opcode, rd, ra, rb, 0), true);
      dv.setInt32(4, ev.value, true);
      if (ev.hasSymbol) relocs.push(at - startAddr + 4);
      return L.slice(0, 8);
    }
    function imm12(expr) {
      var ev = evalExpr(expr, symbols, line);
      if (ev.value < -2048 || ev.value > 2047) throw new AsmError('12 位立即数越界: ' + ev.value, line);
      return ev.value;
    }
    function memOperand(tok) {
      var m = /^\[\s*([a-zA-Z0-9]+)\s*([+-])?\s*(.*?)\s*\]$/.exec(tok);
      if (!m) throw new AsmError('内存操作数格式: ' + tok, line);
      var rn = regNum(m[1], line);
      var off = 0, hasSym = false;
      if (m[3] && m[3].length) {
        var ev = evalExpr(m[3], symbols, line);
        off = ev.value * (m[2] === '-' ? -1 : 1);
        hasSym = ev.hasSymbol;
      }
      return { reg: rn, off: off, hasSym: hasSym, symText: m[3] };
    }
    function memEncode(opcode, rdField, rbField, tok) {
      var mo = memOperand(tok);
      if (mo.hasSym || mo.off < -2048 || mo.off > 2047) {
        throw new AsmError('内存偏移必须是 12 位常量: ' + tok, line);
      }
      dv.setUint32(0, word0(opcode, rdField, mo.reg, rbField, mo.off), true);
      return L.slice(0, 4);
    }

    // 无操作数
    function plain(opcode) {
      var q = new Uint8Array(4);
      new DataView(q.buffer).setUint32(0, (opcode << 24) >>> 0, true);
      return q;
    }
    if (op === 'nop') return plain(OP.NOP);
    if (op === 'ret') return plain(OP.RET);
    if (op === 'sys') return plain(OP.SYS);
    if (op === 'iret') return plain(OP.IRET);
    if (op === 'ei') return plain(OP.EI);
    if (op === 'di') return plain(OP.DI);
    if (op === 'hlt') return plain(OP.HLT);

    if (op === 'ldi' || op === 'li') return w32(OP.LDI, regNum(args[0], line), 0, 0, args[1]);
    if (op === 'mov') return new Uint8Array(new Uint32Array([word0(OP.MOV, regNum(args[0], line), regNum(args[1], line), 0, 0)]).buffer);
    if (op === 'ld') return memEncode(OP.LD, regNum(args[0], line), 0, args[1]);
    if (op === 'ldb') return memEncode(OP.LDB, regNum(args[0], line), 0, args[1]);
    if (op === 'st') return memEncode(OP.ST, 0, regNum(args[1], line), args[0]);
    if (op === 'stb') return memEncode(OP.STB, 0, regNum(args[1], line), args[0]);
    if (RR3[op] !== undefined) {
      return new Uint8Array(new Uint32Array([word0(RR3[op], regNum(args[0], line), regNum(args[1], line), regNum(args[2], line), 0)]).buffer);
    }
    if (RR2[op] !== undefined) {
      return new Uint8Array(new Uint32Array([word0(RR2[op], regNum(args[0], line), regNum(args[1], line), 0, 0)]).buffer);
    }
    if (op === 'cmp') {
      return new Uint8Array(new Uint32Array([word0(OP.CMP, 0, regNum(args[0], line), regNum(args[1], line), 0)]).buffer);
    }
    if (op === 'push') return new Uint8Array(new Uint32Array([word0(OP.PUSH, 0, regNum(args[0], line), 0, 0)]).buffer);
    if (op === 'pop') return new Uint8Array(new Uint32Array([word0(OP.POP, regNum(args[0], line), 0, 0, 0)]).buffer);
    if (op === 'jr') return new Uint8Array(new Uint32Array([word0(OP.JR, 0, regNum(args[0], line), 0, 0)]).buffer);
    if (JUMP2[op] !== undefined) return w32(JUMP2[op], 0, 0, 0, args[0]);
    if (op === 'addi') {
      return new Uint8Array(new Uint32Array([word0(OP.ADDI, regNum(args[0], line), regNum(args[1], line), 0, imm12(args[2]))]).buffer);
    }
    if (op === 'in') {
      return new Uint8Array(new Uint32Array([word0(OP.IN, regNum(args[0], line), 0, 0, imm12(args[1]))]).buffer);
    }
    if (op === 'outr') {
      return new Uint8Array(new Uint32Array([word0(OP.OUTR, 0, regNum(args[0], line), regNum(args[1], line), 0)]).buffer);
    }
    if (op === 'inr') {
      return new Uint8Array(new Uint32Array([word0(OP.INR, regNum(args[0], line), regNum(args[1], line), 0, 0)]).buffer);
    }
    if (op === 'out') {
      return new Uint8Array(new Uint32Array([word0(OP.OUT, 0, regNum(args[1], line), 0, imm12(args[0]))]).buffer);
    }
    throw new AsmError('未知指令 ' + op, line);
  }

  var api = { assemble: assemble, AsmError: AsmError, OP: OP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LUXASM = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
