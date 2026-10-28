'use strict';
// x86 汇编器（16 位实模式子集），专为写 Lumen OS 的 x86 版内核而做。
// 支持：标签、org、db/dw、字符串、mov/add/sub/cmp/and/or/xor/test、
//      inc/dec/push/pop、jmp/jcc/call/ret/loop、int/in/out、
//      lodsb/stosb/movsb/movsw、rep 前缀、shl/shr/cld/sti/cli/hlt。
//
// 没有第三方依赖。两遍扫描：第一遍记标签，第二遍生成机器码并回填。

const REG16 = { ax: 0, cx: 1, dx: 2, bx: 3, sp: 4, bp: 5, si: 6, di: 7 };
const REG8 = { al: 0, cl: 1, dl: 2, bl: 3, ah: 4, ch: 5, dh: 6, bh: 7 };
const SREG = { es: 0, cs: 1, ss: 2, ds: 3 };

const JCC = { je: 0x74, jz: 0x74, jne: 0x75, jnz: 0x75, jl: 0x7C, jnl: 0x7D, jge: 0x7D,
  jle: 0x7E, jg: 0x7F, jb: 0x72, jc: 0x72, jae: 0x73, jnc: 0x73, ja: 0x77, jbe: 0x76 };

const ARITH = { add: [0x01, 0], or: [0x09, 1], and: [0x21, 4], sub: [0x29, 5], xor: [0x31, 6], cmp: [0x39, 7] };
// "r/m, r" 形式（rm 是目的）
const ARITH_RM16 = { add: 0x03, or: 0x0B, and: 0x23, sub: 0x2B, xor: 0x33, cmp: 0x3B };
const ARITH_RM8  = { add: 0x00, or: 0x08, and: 0x20, sub: 0x28, xor: 0x30, cmp: 0x3A };
// "r, r/m" 形式（目标是寄存器，源是内存）
const ARITH_R16  = { add: 0x03, or: 0x0B, and: 0x23, sub: 0x2B, xor: 0x33, cmp: 0x3B };
const ARITH_R8   = { add: 0x02, or: 0x0A, and: 0x22, sub: 0x2A, xor: 0x32, cmp: 0x3A };

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === ';') return line.slice(0, i);
  }
  return line;
}

function parseNum(tok, labels) {
  tok = tok.trim();
  if (labels[tok] !== undefined) return labels[tok];
  if (/^0x[0-9a-f]+$/i.test(tok)) return parseInt(tok, 16);
  if (/^\d+$/.test(tok)) return parseInt(tok, 10);
  if (/^'[^']'$/.test(tok)) return tok.charCodeAt(1);

  // 表达式求值：支持 + - * / % ( ) 和常量名
  // 例如 (WIN_Y + WIN_H - 1) * SCRW + WIN_X
  const s = tok.replace(/\s+/g, '');
  let pos = 0;
  const eat = (c) => { if (s[pos] === c) { pos++; return true; } return false; };

  const parsePrimary = () => {
    if (eat('(')) {
      const v = parseSum();
      if (!eat(')')) throw new Error('括号不匹配: ' + tok);
      return v;
    }
    if (eat('-')) return -parsePrimary();
    if (eat('+')) return parsePrimary();
    // 数字字面量
    let j = pos;
    if (s.slice(j, j + 2).toLowerCase() === '0x') {
      j += 2;
      while (j < s.length && /[0-9a-fA-F]/.test(s[j])) j++;
      if (j > pos + 2) { const v = parseInt(s.slice(pos, j), 16); pos = j; return v; }
    } else {
      while (j < s.length && /[0-9]/.test(s[j])) j++;
      if (j > pos) { const v = parseInt(s.slice(pos, j), 10); pos = j; return v; }
    }
    // 标识符：常量名或标签
    j = pos;
    while (j < s.length && /[A-Za-z0-9_.]/.test(s[j])) j++;
    if (j > pos) {
      const name = s.slice(pos, j);
      pos = j;
      if (labels[name] !== undefined) return labels[name];
      throw new Error('无法识别的数值: ' + name);
    }
    throw new Error('无法识别的数值: ' + tok);
  };

  const parseProduct = () => {
    let v = parsePrimary();
    for (;;) {
      if (eat('*')) v = v * parsePrimary();
      else if (eat('/')) v = Math.floor(v / parsePrimary());
      else if (eat('%')) v = v % parsePrimary();
      else break;
    }
    return v;
  };

  const parseSum = () => {
    let v = parseProduct();
    for (;;) {
      if (eat('+')) v = v + parseProduct();
      else if (eat('-')) v = v - parseProduct();
      else break;
    }
    return v;
  };

  const v = parseSum();
  if (pos !== s.length) throw new Error('无法识别的数值: ' + tok);
  return v;
}


// 段前缀：mov [es:di], al → 0x26 前缀
const SEGPFX = { cs: 0x2E, ss: 0x36, ds: 0x3E, es: 0x26 };
const hasSegPfx = (ops) => ops.some((o) => {
  const t = o.trim();
  return /^\[\s*[a-z]{2}\s*:/i.test(t) || /^[a-z]{2}\s*:\s*\[/i.test(t);
});

// 是不是内存操作数（允许 byte/word/dword 尺寸前缀）
const isMemOp = (t) => /^(byte|word|dword)?\s*\[/i.test(t.trim());

// 解析内存操作数：{ base, disp }
//   base 为 'si'/'di'/'bx'/'bp'（间接寻址）或 null（绝对地址）
function parseMem(operand, labels) {
  let t = operand.trim();
  // 尺寸前缀：byte [..] / word [..] / dword [..]
  let size = null;
  const sm2 = t.match(/^(byte|word|dword)\s+(.*)$/i);
  if (sm2) { size = sm2[1].toLowerCase(); t = sm2[2].trim(); }
  if (t[0] !== '[' || t[t.length - 1] !== ']') return null;
  let inner = t.slice(1, -1).trim();
  // 去掉段前缀（由指令层单独处理）
  const pm = inner.match(/^([a-z]{2})\s*:\s*(.*)$/i);
  if (pm && SEGPFX[pm[1].toLowerCase()] !== undefined) inner = pm[2].trim();
  // 只有完整等于寄存器名（或寄存器名 + 位移）才算间接寻址
  const rm = inner.match(/^(si|di|bx|bp)(?:\s*([+-].*))?$/i);
  if (rm) {
    const base = rm[1].toLowerCase();
    let disp = 0;
    if (rm[2]) {
      try { disp = parseNum(rm[2].trim(), labels); }
      catch (e) { disp = null; }   // 标签还没定，两遍都用 disp16 估算
    }
    return { base, disp, size };
  }
  // 绝对地址
  let disp;
  try { disp = parseNum(inner, labels); }
  catch (e) { disp = null; }       // 标签未知
  return { base: null, disp, size };
}

function splitOps(s) {
  const out = [];
  let cur = '', q = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function assemble(source) {
  const lines = source.split('\n').map((l) => stripComment(l).trim()).filter((l) => l.length > 0);
  const labels = {};
  const out = [];
  const fixups = [];
  let org = 0;
  let originSet = false;

  const emit = (...b) => { for (const x of b) out.push(x & 0xFF); };
  const emit16 = (v) => { emit(v & 0xFF, (v >> 8) & 0xFF); };

  // 常量定义：NAME = expr
  const constNames = new Set();
  const isConstLine = (raw) => /^([A-Za-z_][\w]*)\s*=\s*(.+)$/.test(raw) && !/^\s*;/.test(raw);
  const prescan = () => {
    for (const raw of lines) {
      const cm = raw.match(/^([A-Za-z_][\w]*)\s*=\s*(.+)$/);
      if (cm && !/^\s*;/.test(raw)) {
        constNames.add(cm[1]);
        labels[cm[1]] = parseNum(cm[2].trim(), labels);
      }
    }
  };

  let firstLen = 0;
  const firstPass = () => {
    let pc = 0;
    let base = 0;
    let scope = '';
    const startPc = pc;
    for (const raw of lines) {
      let line = raw;
      if (isConstLine(line)) continue;
      const lm = line.match(/^([A-Za-z_.][\w.]*):\s*(.*)$/);
      if (lm) {
        if (lm[1].startsWith('.')) { labels[scope + lm[1]] = pc; }
        else { scope = lm[1]; labels[lm[1]] = pc; }
        line = lm[2].trim();
      }
      if (!line) continue;
      const m = line.match(/^(\w+)\s*(.*)$/);
      if (!m) throw new Error('无法解析: ' + raw);
      const op = m[1].toLowerCase();
      const rest = m[2];
      if (op === 'org') { pc = parseNum(rest, labels); base = pc; continue; }
      pc += sizeOf(op, rest);
    }
    firstLen = pc - base;
  };

  const sizeOf = (op, rest) => {
    const ops = splitOps(rest);
    switch (op) {
      case 'db': {
        let n = 0;
        for (const o of ops) n += (o.startsWith('"') || o.startsWith("'")) ? Buffer.byteLength(o.slice(1, -1), 'utf8') : 1;
        return n;
      }
      case 'dw': return ops.length * 2;
      case 'dq': return ops.length * 8;
      case 'resb': return parseNum(ops[0], labels);
      case 'resw': return parseNum(ops[0], labels) * 2;
      case 'mov':
      case 'add': case 'sub': case 'cmp': case 'and': case 'or': case 'xor': case 'test': {
        const dst = ops[0], src = ops[1];
        if (SREG[dst] !== undefined || SREG[src] !== undefined) return 2 + (hasSegPfx(ops) ? 1 : 0);
        const dMem = isMemOp(dst);
        const sMem = isMemOp(src);
        const seg = hasSegPfx(ops) ? 1 : 0;
        const isImm = REG16[src] === undefined && REG8[src] === undefined && !sMem;
        const dst8 = REG8[dst] !== undefined;

        // 间接寻址 [base+disp]：位移宽度两遍必须一致
        //   disp 未知（标签还没定）时按 disp16 算，第二遍若算出 disp8 会不一致 → 报错
        const indLen = (operand) => {
          const inf = parseMem(operand, labels);
          if (!inf || !inf.base) return 0;
          if (inf.disp === null) return 4;            // 未知 → disp16
          if (inf.disp === 0) return 2;
          return (inf.disp >= -128 && inf.disp <= 127) ? 3 : 4;
        };

        if (sMem) {
          const inf = parseMem(src, labels);
          if (inf && inf.base) return indLen(src) + seg;
          return 4 + seg;                              // 绝对寻址：恒 4 字节
        }
        if (dMem) {
          const inf = parseMem(dst, labels);
          const immSize = isImm ? ((inf && inf.size === 'byte') ? 1 : 2) : 0;
          if (inf && inf.base) return indLen(dst) + immSize + seg;
          // 绝对寻址：opcode + ModRM + moffs16 = 4 字节，再加立即数
          return 4 + immSize + seg;
        }
        if (!isImm) return 2;
        if (dst8) {
          if (op === 'mov') return 2 + seg;                     // B0+r ib
          if (op === 'test' && dst === 'al') return 2 + seg;     // A8 ib
          if (op === 'test' && REG8[src] !== undefined) return 2 + seg;  // 84 /r
          if (dst === 'al') return 2 + seg;                     // 累加器短编码
          return 3 + seg;                                      // 80 /r ib
        }
        if (op === 'mov' || dst === 'ax') return 3 + seg;
        return 4 + seg;
      }
      case 'inc': case 'dec': {
        const r = ops[0];
        if (REG16[r] !== undefined) return 1;
        if (REG8[r] !== undefined) return 2;
        throw new Error('inc/dec 不支持的寄存器: ' + r);
      }
      case 'push': case 'pop': return 1;
      case 'div': return 2;
      case 'mul': return 2;
      case 'int': return 2;
      case 'in': case 'out': return 1;
      case 'call': {
        const t = ops[0].trim().toLowerCase();
        if (REG16[t] !== undefined) return 2;         // FF /2 r/m16
        return 3;
      }
      case 'ret': case 'lodsb': case 'stosb': case 'movsb': case 'movsw':
      case 'cld': case 'sti': case 'cli': case 'hlt': case 'nop':
      case 'clc': case 'stc': case 'cmc': case 'std': case 'cld': return 1;
      case 'rep': return 1 + sizeOf(ops[0].toLowerCase(), ops.slice(1).join(','));
      case 'shl': case 'shr': {
        // shl r/m, imm8 → D0/D1 /4 ib（3 字节）；不带立即数则是移 1 位（2 字节）
        const hasImm = ops.length > 1;          // 第二个操作数是立即数
        return hasImm ? 3 : 2;
      }
      case 'loop': return 2;
      case 'jmp': {
        const t = ops[0].trim();
        if (t.startsWith('[')) {
          // jmp [addr]：FF /4 m16 —— 绝对地址 4 字节，寄存器间接 2 字节
          const inf = parseMem(t, labels);
          if (inf && inf.base) return 2;
          return 4;
        }
        if (JCC[op]) return 4;
        return 3;
      }
      default:
        if (JCC[op]) return 4;
        throw new Error('未知指令: ' + op);
    }
  };

  const modrmRR = (reg, rm) => 0xC0 | ((reg & 7) << 3) | (rm & 7);
  // 绝对寻址 [addr]：ModRM = mod 00 / reg=目标寄存器 / rm=110，再跟 16 位地址
  const dirRef = (addr) => [0x06, addr & 0xFF, (addr >> 8) & 0xFF];
  const memRef = (reg, addr) => [((reg & 7) << 3) | 0x06, addr & 0xFF, (addr >> 8) & 0xFF];
  // 间接寻址 [base+disp] 的 ModRM 与位移字节
  //   disp=0      → mod=00
  //   -128..127   → mod=01 + disp8
  //   其他/未知   → mod=10 + disp16
  const IND_RM = { si: 4, di: 5, bx: 7, bp: 5 };
  const indRef = (reg, base, disp) => {
    const rm = IND_RM[base];
    const out = [];
    if (disp === 0) {
      out.push(0x00 | ((reg & 7) << 3) | rm);
    } else if (disp !== null && disp !== undefined && disp >= -128 && disp <= 127) {
      out.push(0x40 | ((reg & 7) << 3) | rm);
      out.push(disp & 0xFF);
    } else {
      out.push(0x80 | ((reg & 7) << 3) | rm);
      out.push(disp === null || disp === undefined ? 0 : disp & 0xFF);
      out.push(disp === null || disp === undefined ? 0 : (disp >> 8) & 0xFF);
    }
    return out;
  };

  const secondPass = () => {
    let pc = org;
    let scope = '';
    const key = (n) => (n && n.startsWith('.') ? scope + n : n);
    const here = () => pc;
    let prev = null;
    const checkPrev = () => {
      if (prev && pc - prev.start !== prev.expect) {
        throw new Error('长度不一致: 实际 ' + (pc - prev.start) + ' 预期 ' + prev.expect + '  <<< ' + prev.line);
      }
    };
    for (const raw of lines) {
      let line = raw;
      if (isConstLine(line)) continue;
      const lm = line.match(/^([A-Za-z_.][\w.]*):\s*(.*)$/);
      if (lm) {
        const full = key(lm[1]);
        if (labels[full] !== pc) {
          throw new Error('标签偏移不一致: ' + full + ' 记录 ' + labels[full] + ' 实际 ' + pc);
        }
        if (!lm[1].startsWith('.')) scope = lm[1];
        line = lm[2].trim();
      }
      if (!line) continue;
      const m = line.match(/^(\w+)\s*(.*)$/);
      const op = m[1].toLowerCase();
      const ops = splitOps(m[2]);
      checkPrev();
      const start = here();
      prev = { start, expect: op === 'org' ? 0 : sizeOf(op, m[2]), line };
      try {

      const put = (...b) => { for (const x of b) { out.push(x & 0xFF); pc++; } };

      // 段前缀：mov [es:di], al → 先发 0x26 再发指令
      //   形式一 [es:di]   形式二 es:[di]
      let segPfx = 0;
      for (let i = 0; i < ops.length; i++) {
        const t0 = ops[i].trim();
        let m = t0.match(/^\[\s*([a-z]{2})\s*:(.*)$/i);
        if (m && SEGPFX[m[1].toLowerCase()] !== undefined) {
          segPfx = SEGPFX[m[1].toLowerCase()];
          ops[i] = '[' + m[2];
          continue;
        }
        m = t0.match(/^([a-z]{2})\s*:\s*(\[.*\])$/i);
        if (m && SEGPFX[m[1].toLowerCase()] !== undefined) {
          segPfx = SEGPFX[m[1].toLowerCase()];
          ops[i] = m[2];
        }
      }
      if (segPfx) put(segPfx);
      const put16 = (v) => put(v & 0xFF, (v >> 8) & 0xFF);
      // 跳转目标：标签名 → 符号；数值 → 绝对地址（换算成相对 org 的偏移）
      const relTarget = (target) => {
        const t = target.trim();
        if (labels[key(t)] !== undefined || /^[A-Za-z_.]/.test(t)) return { label: key(t) };
        return { abs: parseNum(t, labels) - org };
      };
      const rel8 = (target) => { fixups.push({ kind: 'rel8', at: out.length, target: relTarget(target), next: pc + 1 }); put(0); };
      const rel16 = (target) => { fixups.push({ kind: 'rel16', at: out.length, target: relTarget(target), next: pc + 2 }); put(0, 0); };

      if (op === 'org') { pc = parseNum(ops[0], labels); continue; }

      if (op === 'db') {
        for (const o of ops) {
          if (o.startsWith('"') || o.startsWith("'")) {
            for (const byte of Buffer.from(o.slice(1, -1), 'utf8')) put(byte);
          } else put(parseNum(o, labels));
        }
        continue;
      }
      if (op === 'dw') { for (const o of ops) put16(parseNum(o, labels)); continue; }
      if (op === 'dq') {
        for (const o of ops) {
          const v = parseNum(o, labels);
          put(v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >> 24) & 0xFF);
          put(v < 0 ? 0xFF : 0, v < 0 ? 0xFF : 0, v < 0 ? 0xFF : 0, v < 0 ? 0xFF : 0);
        }
        continue;
      }
      if (op === 'resb' || op === 'resw') {
        const n = parseNum(ops[0], labels);
        const bytes = op === 'resb' ? n : n * 2;
        for (let i = 0; i < bytes; i++) put(0);
        continue;
      }

      if (op === 'mov') {
        const [dst, src] = ops;
        if (src === undefined) throw new Error('mov 操作数不足: ' + line);
        const dInfo = isMemOp(dst) ? parseMem(dst, labels) : null;
        const sInfo = isMemOp(src) ? parseMem(src, labels) : null;
        if (SREG[dst] !== undefined) {
          put(0x8E, modrmRR(SREG[dst], REG16[src]));
        } else if (SREG[src] !== undefined) {
          put(0x8C, modrmRR(SREG[src], REG16[dst]));
        } else if (dInfo && dInfo.base) {
          // 89 /r 与 88 /r：MOV r/m, r —— ModRM 的 rm 是目的，reg 是来源
          if (REG16[src] !== undefined) { put(0x89); put(...indRef(REG16[src], dInfo.base, dInfo.disp)); }
          else if (REG8[src] !== undefined) { put(0x88); put(...indRef(REG8[src], dInfo.base, dInfo.disp)); }
          else throw new Error('暂不支持 [reg],imm');
        } else if (sInfo && sInfo.base) {
          // 8B /r 与 8A /r：MOV r, r/m —— ModRM 的 reg 是目的，rm 是来源
          if (REG8[dst] !== undefined) { put(0x8A); put(...indRef(REG8[dst], sInfo.base, sInfo.disp)); }
          else if (REG16[dst] !== undefined) { put(0x8B); put(...indRef(REG16[dst], sInfo.base, sInfo.disp)); }
          else throw new Error('mov 源无法识别: ' + src);
        } else if (dInfo) {
          const addr = dInfo.disp;
          if (REG16[src] !== undefined) { put(0x89); put(...memRef(REG16[src], addr)); }
          else if (REG8[src] !== undefined) { put(0x88); put(...memRef(REG8[src], addr)); }
          else if (dInfo.size === 'byte') {
            // MOV byte [abs], imm8 → C6 /0 ib
            put(0xC6); put(...dirRef(addr)); put(parseNum(src, labels) & 0xFF);
          }
          else { put(0xC7); put(...dirRef(addr)); put16(parseNum(src, labels)); }
        } else if (sInfo) {
          const addr = sInfo.disp;
          if (REG8[dst] !== undefined) { put(0x8A); put(...memRef(REG8[dst], addr)); }
          else if (REG16[dst] !== undefined) { put(0x8B); put(...memRef(REG16[dst], addr)); }
          else throw new Error('mov 源无法识别: ' + src);
        } else if (REG16[dst] !== undefined && REG16[src] !== undefined) {
          put(0x89, modrmRR(REG16[src], REG16[dst]));
        } else if (REG8[dst] !== undefined && REG8[src] !== undefined) {
          // 88 /r = MOV r/m8, r8 → rm 是目的，reg 是来源
          put(0x88, modrmRR(REG8[src], REG8[dst]));
        } else if (REG8[dst] !== undefined) {
          put(0xB0 + REG8[dst], parseNum(src, labels));
        } else if (REG16[dst] !== undefined) {
          put(0xB8 + REG16[dst]); put16(parseNum(src, labels));
        } else {
          throw new Error('mov 目标无法识别: ' + dst);
        }
        continue;
      }

      if (ARITH[op] || op === 'test') {
        const [dst, src] = ops;
        if (op === 'test') {
          if (REG16[dst] !== undefined && REG16[src] !== undefined) {
            put(0x85, modrmRR(REG16[src], REG16[dst]));
          } else if (REG8[dst] !== undefined && REG8[src] !== undefined) {
            put(0x84, modrmRR(REG8[src], REG8[dst]));
          } else if (REG16[dst] !== undefined) {
            const v = parseNum(src, labels);
            if (dst === 'ax') { put(0xA9); put16(v); }
            else { put(0xF7, modrmRR(0, REG16[dst])); put16(v); }
          } else if (REG8[src] !== undefined) {
            put(0x84, modrmRR(REG8[src], REG8[dst]));
          } else {
            const v = parseNum(src, labels);
            if (dst === 'al') put(0xA8, v);
            else { put(0xF6, modrmRR(0, REG8[dst]), v); }
          }
          continue;
        }
        const [base, digit] = ARITH[op];
        const sInfo = isMemOp(src) ? parseMem(src, labels) : null;
        if (REG16[dst] !== undefined && REG16[src] !== undefined) {
          put(base, modrmRR(REG16[src], REG16[dst]));
        } else if (REG8[dst] !== undefined && REG8[src] !== undefined) {
          put(base - 1, modrmRR(REG8[src], REG8[dst]));
        } else if (sInfo && sInfo.base) {
          // 寄存器 与 内存：3B/3A 是 CMP r, r/m；03/00 等是 r/m 方向
          const is8 = REG8[dst] !== undefined;
          const reg = is8 ? REG8[dst] : REG16[dst];
          if (op === 'cmp') put(is8 ? 0x3A : 0x3B);
          else put(is8 ? ARITH_RM8[op] : ARITH_RM16[op]);
          put(...indRef(reg, sInfo.base, sInfo.disp));
        } else if (REG8[dst] !== undefined && isMemOp(src)) {
          // op r8, [moffs16] → 02/0A/22/2A/32/3A /r + moffs16（4 字节）
          const inf = parseMem(src, labels);
          put(ARITH_R8[op], ...memRef(REG8[dst], inf.disp));
        } else if (REG16[dst] !== undefined && isMemOp(src)) {
          // op r16, [moffs16] → 03/0B/23/2B/33/3B /r + moffs16（4 字节）
          const inf = parseMem(src, labels);
          put(ARITH_R16[op], ...memRef(REG16[dst], inf.disp));
        } else if (isMemOp(dst) && REG16[src] === undefined && REG8[src] === undefined) {
          // op [mem], imm → 80/81 /digit + moffs16 或 modrm
          const inf = parseMem(dst, labels);
          const digit = ARITH[op][1];
          const imm = parseNum(src, labels);
          const byteOp = (inf.size === 'byte');
          if (inf.base) {
            if (byteOp) { put(0x80, ...indRef(digit, inf.base, inf.disp)); put(imm & 0xFF); }
            else { put(0x81, ...indRef(digit, inf.base, inf.disp)); put16(imm); }
          } else {
            const addr = inf.disp;
            const modrm = ((digit & 7) << 3) | 0x06;
            if (byteOp) { put(0x80, modrm, addr & 0xFF, (addr >> 8) & 0xFF); put(imm & 0xFF); }
            else { put(0x81, modrm, addr & 0xFF, (addr >> 8) & 0xFF); put16(imm); }
          }
        } else if (isMemOp(dst) && REG16[src] !== undefined) {
          // op [moffs16], r16 → 01/09/21/29/31/39 /r + moffs16（4 字节）
          const inf = parseMem(dst, labels);
          put(ARITH[op][0], ...memRef(REG16[src], inf.disp));
        } else if (isMemOp(dst) && REG8[src] !== undefined) {
          // op [moffs16], r8 → 00/08/20/28/30/38 /r + moffs16（4 字节）
          const inf = parseMem(dst, labels);
          put(ARITH_RM8[op], ...memRef(REG8[src], inf.disp));
        } else if (REG8[dst] !== undefined && !isMemOp(src)) {
          const v8 = parseNum(src, labels);
          if (dst === 'al') {
            const sh = { add: 0x04, or: 0x0C, and: 0x24, sub: 0x2C, xor: 0x34 }[op];
            if (sh !== undefined) put(sh, v8);
            else put(0x3C, v8);              // cmp al, imm8
          } else {
            put(0x80, modrmRR(digit, REG8[dst]), v8);
          }
        } else if (REG16[dst] !== undefined) {
          const v = parseNum(src, labels);
          if (dst === 'ax') { put(base + 4); put16(v); }
          else { put(0x81, modrmRR(digit, REG16[dst])); put16(v); }
        } else {
          throw new Error('暂不支持的运算形式: ' + line);
        }
        continue;
      }

      switch (op) {
        case 'inc': {
          if (REG16[ops[0]] !== undefined) put(0x40 + REG16[ops[0]]);
          else if (REG8[ops[0]] !== undefined) put(0xFE, modrmRR(0, REG8[ops[0]]));
          else throw new Error('inc 不支持的寄存器: ' + ops[0]);
          break;
        }
        case 'div': put(0xF7, modrmRR(6, REG16[ops[0]])); break;
        case 'mul': {
          if (REG16[ops[0]] !== undefined) { put(0xF7, modrmRR(4, REG16[ops[0]])); break; }
          if (REG8[ops[0]] !== undefined) { put(0xF6, modrmRR(4, REG8[ops[0]])); break; }
          throw new Error('mul 不支持的寄存器: ' + ops[0]);
        }
        case 'dec': {
          if (REG16[ops[0]] !== undefined) put(0x48 + REG16[ops[0]]);
          else if (REG8[ops[0]] !== undefined) put(0xFE, modrmRR(1, REG8[ops[0]]));
          else throw new Error('dec 不支持的寄存器: ' + ops[0]);
          break;
        }
        case 'push': {
          const PUSHSEG = { es: 0x06, cs: 0x0E, ss: 0x16, ds: 0x1E };
          if (PUSHSEG[ops[0]] !== undefined) put(PUSHSEG[ops[0]]);
          else if (REG16[ops[0]] !== undefined) put(0x50 + REG16[ops[0]]);
          else throw new Error('push 不支持: ' + ops[0]);
          break;
        }
        case 'pop': {
          const POPSEG = { es: 0x07, cs: 0x0F, ss: 0x17, ds: 0x1F };
          if (POPSEG[ops[0]] !== undefined) put(POPSEG[ops[0]]);
          else if (REG16[ops[0]] !== undefined) put(0x58 + REG16[ops[0]]);
          else throw new Error('pop 不支持: ' + ops[0]);
          break;
        }
        case 'int': put(0xCD, parseNum(ops[0], labels)); break;
        case 'in': put(0xEC); break;
        case 'out': put(0xEE); break;
        case 'call': {
          const t = ops[0].trim().toLowerCase();
          if (REG16[t] !== undefined) { put(0xFF, modrmRR(2, REG16[t])); break; }
          put(0xE8); rel16(ops[0]); break;
        }
        case 'ret': put(0xC3); break;
        case 'jmp': {
          const t = ops[0].trim();
          if (t.startsWith('[')) {
            // 间接跳转：FF /4 m16
            const inf = parseMem(t, labels);
            if (inf && inf.base) {
              put(0xFF, modrmRR(4, IND_RM[inf.base]));
              if (inf.disp) put(...indRef(0, inf.base, inf.disp).slice(1));
            } else {
              put(0xFF, modrmRR(4, 6));
              put(inf.disp & 0xFF, (inf.disp >> 8) & 0xFF);
            }
            break;
          }
          put(0xE9); rel16(ops[0]); break;
        }
        case 'loop': put(0xE2); rel8(ops[0]); break;
        case 'lodsb': put(0xAC); break;
        case 'stosb': put(0xAA); break;
        case 'movsb': put(0xA4); break;
        case 'movsw': put(0xA5); break;
        case 'rep': {
          put(0xF3);
          const sub = ops[0].toLowerCase();
          if (sub === 'movsb') put(0xA4); else if (sub === 'movsw') put(0xA5);
          else if (sub === 'stosb') put(0xAA); else if (sub === 'stosw') put(0xAB);
          else throw new Error('rep 不支持: ' + sub);
          break;
        }
        case 'cld': put(0xFC); break;
        case 'clc': put(0xF8); break;
        case 'stc': put(0xF9); break;
        case 'cmc': put(0xF5); break;
        case 'std': put(0xFD); break;
        case 'sti': put(0xFB); break;
        case 'cli': put(0xFA); break;
        case 'hlt': put(0xF4); break;
        case 'nop': put(0x90); break;
        case 'shl': case 'shr': case 'sar': {
          // 移位指令的编码：
          //   不带立即数      D0/D1 /n r/m        —— 移 1 位，没有 imm 字节
          //   带立即数        C0/C1 /n r/m, imm8  —— 移 imm 位
          // 注意：D1 后面跟 imm8 是错的，那会让 imm8 变成下一条指令！
          const t = ops[0];
          const hasImm = ops.length > 1;
          const imm = hasImm ? parseNum(ops[1], labels) : null;
          const digit = op === 'shl' ? 4 : op === 'shr' ? 5 : 7;
          if (REG16[t] !== undefined) {
            if (hasImm) { put(0xC1, modrmRR(digit, REG16[t])); put(imm & 0xFF); }
            else put(0xD1, modrmRR(digit, REG16[t]));
          } else if (REG8[t] !== undefined) {
            if (hasImm) { put(0xC0, modrmRR(digit, REG8[t])); put(imm & 0xFF); }
            else put(0xD0, modrmRR(digit, REG8[t]));
          } else throw new Error(op + ' 不支持的寄存器: ' + t);
          break;
        }
        default:
          if (JCC[op]) { put(0x0F, JCC[op] + 0x10); rel16(ops[0]); }
          else throw new Error('未知指令: ' + op);
      }

      } catch (e) { throw new Error(e.message + '  <<< ' + line); }
      if (pc - start === 0) throw new Error('空指令: ' + line);

    }
  };

  prescan();
  firstPass();
  originSet = true;
  org = labels.__org || 0;
  // 第一遍若遇到 org，用 labels 里记录的起点
  const orgMatch = source.match(/^\s*org\s+(\S+)/m);
  if (orgMatch) org = parseNum(orgMatch[1], {});
  secondPass();

  // 两遍扫描必须得到同样的长度，否则标签偏移会整体错位
  if (firstLen !== 0 && out.length !== firstLen) {
    throw new Error('两遍扫描长度不一致: 首遍 ' + firstLen + ' 字节, 二遍 ' + out.length +
                    ' 字节 —— 标签偏移会错位');
  }

  for (const f of fixups) {
    const target = (f.target && f.target.label !== undefined) ? labels[f.target.label] : f.target.abs + org;
    if (target === undefined) throw new Error('未定义标签: ' + (f.target.label || f.target.abs));
    const d = target - f.next;
    if (f.kind === 'rel8') {
      if (d < -128 || d > 127) throw new Error('短跳转越界: ' + f.target + ' (' + d + ')');
      out[f.at] = d & 0xFF;
    } else {
      out[f.at] = d & 0xFF;
      out[f.at + 1] = (d >> 8) & 0xFF;
    }
  }

  return { code: out, labels, org };
}

module.exports = { assemble };
