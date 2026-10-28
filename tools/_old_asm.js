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
  if (/^-?\d+$/.test(tok)) return parseInt(tok, 10);
  if (/^'[^']'$/.test(tok)) return tok.charCodeAt(1);
  throw new Error('无法识别的数值: ' + tok);
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

  const firstPass = () => {
    let pc = 0;
    let scope = '';
    for (const raw of lines) {
      let line = raw;
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
      if (op === 'org') { pc = parseNum(rest, labels); continue; }
      pc += sizeOf(op, rest);
    }
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
      case 'mov':
      case 'add': case 'sub': case 'cmp': case 'and': case 'or': case 'xor': case 'test': {
        const dst = ops[0], src = ops[1];
        const IND = ['[bx]', '[si]', '[di]'];
        if (SREG[dst] !== undefined || SREG[src] !== undefined) return 2;
        const dMem = dst.startsWith('[');
        const sMem = src.startsWith('[');
        const isImm = REG16[src] === undefined && REG8[src] === undefined && !sMem;
        const dst8 = REG8[dst] !== undefined;
        if (sMem) return IND.indexOf(src) >= 0 ? 2 : 4;
        if (dMem) return IND.indexOf(dst) >= 0 ? 2 : (isImm ? 5 : 4);
        if (!isImm) return 2;
        if (dst8) return (op === 'mov' || (op === 'test' && dst === 'al')) ? 2 : 3;
        if (op === 'mov' || dst === 'ax') return 3;
        return 4;
      }
      case 'inc': case 'dec': {
        const r = ops[0];
        if (REG16[r] !== undefined) return 1;
        if (REG8[r] !== undefined) return 2;
        throw new Error('inc/dec 不支持的寄存器: ' + r);
      }
      case 'push': case 'pop': return 1;
      case 'div': return 2;
      case 'int': return 2;
      case 'in': case 'out': return 1;
      case 'call': return 3;
      case 'ret': case 'lodsb': case 'stosb': case 'movsb': case 'movsw':
      case 'cld': case 'sti': case 'cli': case 'hlt': case 'nop': return 1;
      case 'rep': return 1 + sizeOf(ops[0].toLowerCase(), ops.slice(1).join(','));
      case 'shl': case 'shr': return 2;
      case 'loop': case 'jmp': return JCC[op] ? 4 : (op === 'jmp' ? 3 : 2);
      default:
        if (JCC[op]) return 4;
        throw new Error('未知指令: ' + op);
    }
  };

  const modrmRR = (reg, rm) => 0xC0 | ((reg & 7) << 3) | (rm & 7);
  // 绝对寻址 [addr]：ModRM = mod 00 / reg=目标寄存器 / rm=110，再跟 16 位地址
  const dirRef = (addr) => [0x06, addr & 0xFF, (addr >> 8) & 0xFF];
  const memRef = (reg, addr) => [((reg & 7) << 3) | 0x06, addr & 0xFF, (addr >> 8) & 0xFF];

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
      const put16 = (v) => put(v & 0xFF, (v >> 8) & 0xFF);
      const rel8 = (target) => { fixups.push({ kind: 'rel8', at: out.length, target: key(target), next: pc + 1 }); put(0); };
      const rel16 = (target) => { fixups.push({ kind: 'rel16', at: out.length, target: key(target), next: pc + 2 }); put(0, 0); };

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

      if (op === 'mov') {
        const [dst, src] = ops;
        if (src === undefined) throw new Error('mov 操作数不足: ' + line);
        const dMem = dst.startsWith('[');
        const sMem = src.startsWith('[');
        const IND = { '[bx]': 7, '[si]': 4, '[di]': 5 };
        if (SREG[dst] !== undefined) {
          put(0x8E, modrmRR(SREG[dst], REG16[src]));
        } else if (SREG[src] !== undefined) {
          put(0x8C, modrmRR(SREG[src], REG16[dst]));
        } else if (dMem && IND[dst] !== undefined) {
          const rm = IND[dst];
          if (REG16[src] !== undefined) put(0x89, (REG16[src] << 3) | rm);
          else if (REG8[src] !== undefined) put(0x88, (REG8[src] << 3) | rm);
          else throw new Error('暂不支持 [reg],imm');
        } else if (sMem && IND[src] !== undefined) {
          const rm = IND[src];
          if (REG8[dst] !== undefined) put(0x8A, (REG8[dst] << 3) | rm);
          else put(0x8B, (REG16[dst] << 3) | rm);
        } else if (dMem) {
          const addr = parseNum(dst.slice(1, -1), labels);
          if (REG16[src] !== undefined) { put(0x89); put(...memRef(REG16[src], addr)); }
          else if (REG8[src] !== undefined) { put(0x88); put(...memRef(REG8[src], addr)); }
          else { put(0xC7); put(...dirRef(addr)); put16(parseNum(src, labels)); }
        } else if (sMem) {
          const addr = parseNum(src.slice(1, -1), labels);
          if (REG8[dst] !== undefined) { put(0x8A); put(...memRef(REG8[dst], addr)); }
          else if (REG16[dst] !== undefined) { put(0x8B); put(...memRef(REG16[dst], addr)); }
          else throw new Error('mov 源无法识别: ' + src);
        } else if (REG16[dst] !== undefined && REG16[src] !== undefined) {
          put(0x89, modrmRR(REG16[src], REG16[dst]));
        } else if (REG8[dst] !== undefined && REG8[src] !== undefined) {
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
        if (REG16[dst] !== undefined && REG16[src] !== undefined) {
          put(base, modrmRR(REG16[src], REG16[dst]));
        } else if (REG8[dst] !== undefined && REG8[src] !== undefined) {
          put(base - 1, modrmRR(REG8[src], REG8[dst]));
        } else if (REG8[dst] !== undefined && !src.startsWith('[')) {
          put(0x80, modrmRR(digit, REG8[dst]), parseNum(src, labels));
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
        case 'call': put(0xE8); rel16(ops[0]); break;
        case 'ret': put(0xC3); break;
        case 'jmp': put(0xE9); rel16(ops[0]); break;
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
        case 'sti': put(0xFB); break;
        case 'cli': put(0xFA); break;
        case 'hlt': put(0xF4); break;
        case 'nop': put(0x90); break;
        case 'shl': put(0xD1, modrmRR(4, REG16[ops[0]])); break;
        case 'shr': put(0xD1, modrmRR(5, REG16[ops[0]])); break;
        default:
          if (JCC[op]) { put(0x0F, JCC[op] + 0x10); rel16(ops[0]); }
          else throw new Error('未知指令: ' + op);
      }

      } catch (e) { throw new Error(e.message + '  <<< ' + line); }
      if (pc - start === 0) throw new Error('空指令: ' + line);

    }
  };

  firstPass();
  originSet = true;
  org = labels.__org || 0;
  // 第一遍若遇到 org，用 labels 里记录的起点
  const orgMatch = source.match(/^\s*org\s+(\S+)/m);
  if (orgMatch) org = parseNum(orgMatch[1], {});
  secondPass();

  for (const f of fixups) {
    const target = labels[f.target];
    if (target === undefined) throw new Error('未定义标签: ' + f.target);
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
