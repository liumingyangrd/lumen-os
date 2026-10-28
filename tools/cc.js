/*
 * Lumen-C 编译器 (lcc)
 * 自行设计的 C 子集 -> LUX-32 汇编文本
 *
 * 支持: int / char / void / 指针 / 数组 / 字符串 / 全局变量
 *       if / else / while / for / break / continue / return
 *       + - * / % 位运算 比较 && || ! 赋值 += -= ++ -- [] * &
 * 调用约定: 参数从右往左压栈, 返回值在 r0, 由调用者清理栈
 *           帧: [fp+4]=返回地址 [fp+8..]=参数, 局部变量在 [fp-4..]
 */
(function (root) {
  'use strict';

  function CErr(msg, line) { this.message = msg + (line ? '  (行 ' + line + ')' : ''); }

  // ---------------- 词法 ----------------
  var KEYWORDS = { 'int': 1, 'char': 1, 'void': 1, 'if': 1, 'else': 1, 'while': 1, 'for': 1, 'return': 1, 'break': 1, 'continue': 1, 'sizeof': 0 };

  function lex(src) {
    var toks = [], i = 0, line = 1;
    var two = ['==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '++', '--', '+=', '-='];
    while (i < src.length) {
      var c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
        i += 2; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        var j = i;
        while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        toks.push({ t: 'id', v: src.slice(i, j), line: line });
        i = j; continue;
      }
      if (/[0-9]/.test(c)) {
        var k = i;
        if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
          k = i + 2;
          while (k < src.length && /[0-9a-fA-F]/.test(src[k])) k++;
          toks.push({ t: 'num', v: parseInt(src.slice(i + 2, k), 16), line: line });
        } else {
          while (k < src.length && /[0-9]/.test(src[k])) k++;
          toks.push({ t: 'num', v: parseInt(src.slice(i, k), 10), line: line });
        }
        i = k; continue;
      }
      if (c === '"') {
        var s = '', p = i + 1;
        while (p < src.length && src[p] !== '"') {
          if (src[p] === '\\') {
            var e = src[p + 1], m = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"' };
            s += m[e] !== undefined ? m[e] : e; p += 2;
          } else { s += src[p]; p++; }
        }
        toks.push({ t: 'str', v: s, line: line });
        i = p + 1; continue;
      }
      if (c === "'") {
        var ch = src[i + 1];
        if (ch === '\\') {
          var e2 = src[i + 2], m2 = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39 };
          toks.push({ t: 'num', v: m2[e2] !== undefined ? m2[e2] : 0, line: line });
          i += 4;
        } else {
          toks.push({ t: 'num', v: ch.charCodeAt(0), line: line });
          i += 3;
        }
        continue;
      }
      var matched = false;
      for (var t = 0; t < two.length; t++) {
        if (src.startsWith(two[t], i)) { toks.push({ t: 'op', v: two[t], line: line }); i += 2; matched = true; break; }
      }
      if (matched) continue;
      if ('+-*/%=<>!&|^~?:;,.(){}[]'.indexOf(c) >= 0) { toks.push({ t: 'op', v: c, line: line }); i++; continue; }
      throw new CErr('非法字符 ' + JSON.stringify(c), line);
    }
    toks.push({ t: 'eof', v: '', line: line });
    return toks;
  }

  // ---------------- 语法 ----------------
  function Parser(toks) {
    this.toks = toks; this.p = 0;
  }
  Parser.prototype.peek = function (o) { return this.toks[this.p + (o || 0)]; };
  Parser.prototype.next = function () { return this.toks[this.p++]; };
  Parser.prototype.is = function (v, o) { var t = this.peek(o); return (t.t === 'op' || t.t === 'id') && t.v === v; };
  Parser.prototype.eat = function (v) { if (this.is(v)) { this.p++; return true; } return false; };
  Parser.prototype.expect = function (v) {
    if (!this.is(v)) throw new CErr('期望 "' + v + '"，实际 "' + this.peek().v + '"', this.peek().line);
    return this.next();
  };
  Parser.prototype.typeName = function () {
    var t = this.peek();
    if (t.t !== 'id' || !KEYWORDS[t.v]) return null;
    var base = this.next().v;
    var ty = { k: base };
    while (this.is('*')) { this.next(); ty = { k: 'ptr', base: ty }; }
    return ty;
  };

  Parser.prototype.parseProgram = function () {
    var decls = [];
    while (this.peek().t !== 'eof') decls.push(this.parseTop());
    return decls;
  };

  Parser.prototype.parseTop = function () {
    var ty = this.typeName();
    if (!ty) throw new CErr('期望类型声明', this.peek().line);
    var name = this.expect2('id');
    if (this.is('(')) {
      // 函数
      this.next();
      var params = [];
      if (!this.is(')')) {
        do {
          var pt = this.typeName();
          if (!pt) throw new CErr('参数缺少类型', this.peek().line);
          var pn = this.peek().t === 'id' ? this.next().v : ('a' + params.length);
          while (this.is('[')) { this.next(); this.expect(']'); pt = { k: 'ptr', base: pt }; }
          params.push({ name: pn, ty: pt });
        } while (this.eat(','));
      }
      this.expect(')');
      var body = this.parseBlock();
      return { k: 'func', name: name.v, ty: ty, params: params, body: body, line: name.line };
    }
    // 全局变量
    var gty = ty, len = 0;
    while (this.is('[')) {
      this.next();
      len = this.peek().t === 'num' ? this.next().v : 0;
      this.expect(']');
      gty = { k: 'arr', base: gty, len: len };
    }
    var init = null;
    if (this.eat('=')) init = this.parseAssign();
    this.expect(';');
    return { k: 'gvar', name: name.v, ty: gty, init: init, line: name.line };
  };

  Parser.prototype.expect2 = function (t) {
    var tok = this.peek();
    if (tok.t !== t) throw new CErr('期望标识符，实际 "' + tok.v + '"', tok.line);
    return this.next();
  };

  Parser.prototype.parseBlock = function () {
    this.expect('{');
    var stmts = [];
    while (!this.is('}')) {
      if (this.peek().t === 'eof') throw new CErr('块未闭合', this.peek().line);
      stmts.push(this.parseStmt());
    }
    this.expect('}');
    return { k: 'block', stmts: stmts };
  };

  Parser.prototype.parseStmt = function () {
    var t = this.peek();
    if (this.is('{')) return this.parseBlock();
    if (this.is('if')) {
      this.next(); this.expect('(');
      var c = this.parseExpr(); this.expect(')');
      var th = this.parseStmt();
      var el = null;
      if (this.eat('else')) el = this.parseStmt();
      return { k: 'if', cond: c, then: th, else: el };
    }
    if (this.is('while')) {
      this.next(); this.expect('(');
      var c2 = this.parseExpr(); this.expect(')');
      var body = this.parseStmt();
      return { k: 'while', cond: c2, body: body };
    }
    if (this.is('for')) {
      this.next(); this.expect('(');
      var init = null, cond = null, step = null;
      if (!this.is(';')) {
        if (this.typeName0()) {
          var ity = this.typeName();
          init = this.parseLocalAfterType(ity);
          this.expect(';');
        } else { init = { k: 'expr', e: this.parseExpr() }; this.expect(';'); }
      } else this.next();
      if (!this.is(';')) cond = this.parseExpr();
      this.expect(';');
      if (!this.is(')')) step = this.parseExpr();
      this.expect(')');
      var body2 = this.parseStmt();
      return { k: 'for', init: init, cond: cond, step: step, body: body2 };
    }
    if (this.is('return')) {
      this.next();
      var v = null;
      if (!this.is(';')) v = this.parseExpr();
      this.expect(';');
      return { k: 'return', e: v };
    }
    if (this.is('break')) { this.next(); this.expect(';'); return { k: 'break' }; }
    if (this.is('continue')) { this.next(); this.expect(';'); return { k: 'continue' }; }
    if (this.is(';')) { this.next(); return { k: 'empty' }; }
    var tn = this.typeName();
    if (tn) { var dl = this.parseLocalAfterType(tn); this.expect(';'); return dl; }
    var e2 = this.parseExpr();
    this.expect(';');
    return { k: 'expr', e: e2 };
  };

  Parser.prototype.typeName0 = function () { return this.peek().t === 'id' && KEYWORDS[this.peek().v]; };

  Parser.prototype.parseLocal = function () {
    var ty = this.typeName();
    return this.parseLocalAfterTypeNoSemi(ty);
  };
  Parser.prototype.parseLocalAfterTypeNoSemi = function (ty) {
    var name = this.expect2('id');
    var lt = ty, len = 0;
    while (this.is('[')) { this.next(); len = this.peek().t === 'num' ? this.next().v : 0; this.expect(']'); lt = { k: 'arr', base: lt, len: len }; }
    var init = null;
    if (this.eat('=')) init = this.parseAssign();
    return { k: 'decl', name: name.v, ty: lt, init: init };
  };
  Parser.prototype.parseLocalAfterType = function (ty) {
    var r = this.parseLocalAfterTypeNoSemi(ty);
    return r;
  };

  // 表达式优先级
  Parser.prototype.parseExpr = function () { return this.parseAssign(); };
  Parser.prototype.parseAssign = function () {
    var left = this.parseBin(0);
    if (this.is('?')) {
      this.next();
      var tv = this.parseAssign();
      this.expect(':');
      var fv = this.parseAssign();
      return { k: 'tern', c: left, a: tv, b: fv };
    }
    var t = this.peek();
    if (t.t === 'op' && ['=', '+=', '-='].indexOf(t.v) >= 0) {
      this.next();
      var right = this.parseAssign();
      return { k: 'assign', op: t.v, left: left, right: right };
    }
    return left;
  };
  var PREC = {
    '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
    '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7,
    '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10
  };
  Parser.prototype.parseBin = function (minPrec) {
    var left = this.parseUnary();
    for (; ;) {
      var t = this.peek();
      if (t.t !== 'op' || PREC[t.v] === undefined) break;
      var prec = PREC[t.v];
      if (prec < minPrec) break;
      this.next();
      var right = this.parseBin(prec + 1);
      left = { k: 'bin', op: t.v, left: left, right: right };
    }
    return left;
  };
  Parser.prototype.parseUnary = function () {
    var t = this.peek();
    if (t.t === 'op') {
      if (t.v === '-') { this.next(); return { k: 'neg', e: this.parseUnary() }; }
      if (t.v === '!') { this.next(); return { k: 'not', e: this.parseUnary() }; }
      if (t.v === '~') { this.next(); return { k: 'bnot', e: this.parseUnary() }; }
      if (t.v === '*') { this.next(); return { k: 'deref', e: this.parseUnary() }; }
      if (t.v === '&') { this.next(); return { k: 'addr', e: this.parseUnary() }; }
      if (t.v === '++') { this.next(); return { k: 'preinc', e: this.parseUnary(), d: 1 }; }
      if (t.v === '--') { this.next(); return { k: 'preinc', e: this.parseUnary(), d: -1 }; }
    }
    return this.parsePostfix();
  };
  Parser.prototype.parsePostfix = function () {
    var e = this.parsePrimary();
    for (; ;) {
      if (this.is('(')) {
        this.next();
        var args = [];
        if (!this.is(')')) {
          do { args.push(this.parseAssign()); } while (this.eat(','));
        }
        this.expect(')');
        e = { k: 'call', fn: e, args: args };
      } else if (this.is('[')) {
        this.next();
        var idx = this.parseExpr();
        this.expect(']');
        e = { k: 'index', arr: e, idx: idx };
      } else if (this.is('++')) { this.next(); e = { k: 'postinc', e: e, d: 1 }; }
      else if (this.is('--')) { this.next(); e = { k: 'postinc', e: e, d: -1 }; }
      else break;
    }
    return e;
  };
  Parser.prototype.parsePrimary = function () {
    var t = this.peek();
    if (t.t === 'num') { this.next(); return { k: 'num', v: t.v }; }
    if (t.t === 'str') { this.next(); return { k: 'str', v: t.v }; }
    if (t.t === 'id') {
      if (t.v === 'sizeof') {
        this.next(); this.expect('(');
        var ty = this.typeName();
        this.expect(')');
        return { k: 'num', v: sizeOf(ty) };
      }
      this.next();
      return { k: 'var', name: t.v };
    }
    if (this.is('(')) { this.next(); var e = this.parseExpr(); this.expect(')'); return e; }
    throw new CErr('无法解析的表达式 "' + t.v + '"', t.line);
  };

  function sizeOf(ty) {
    if (!ty) return 4;
    if (ty.k === 'int') return 4;
    if (ty.k === 'char') return 1;
    if (ty.k === 'ptr') return 4;
    if (ty.k === 'void') return 0;
    if (ty.k === 'arr') return (ty.len || 0) * sizeOf(ty.base);
    return 4;
  }

  // ---------------- 代码生成 ----------------
  function Gen(prog, opts) {
    this.prog = prog;
    this.out = [];
    this.data = [];
    this.labelN = 0;
    this.strN = 0;
    this.funcs = Object.create(null);
    this.globals = Object.create(null);
    this.opts = opts || {};
    this.cur = null;
    this.condStack = [];
    for (var i = 0; i < prog.length; i++) {
      var d = prog[i];
      if (d.k === 'func') this.funcs[d.name] = d;
      if (d.k === 'gvar') this.globals[d.name] = d;
    }
  }
  Gen.prototype.emit = function (s) { this.out.push(s); };
  Gen.prototype.label = function (p) { return '.' + (p || 'L') + (this.labelN++); };

  Gen.prototype.run = function () {
    var i, d;
    for (i = 0; i < this.prog.length; i++) {
      d = this.prog[i];
      if (d.k === 'func') this.genFunc(d);
    }
    // 数据段
    if (this.data.length) {
      this.emit('');
      this.emit('; ---- 数据段 ----');
      for (i = 0; i < this.data.length; i++) this.emit(this.data[i]);
    }
    // 入口
    if (!this.opts.noStart && (this.funcs['main'] || this.funcs['__cstart'])) {
      this.emit('');
      this.emit('.global _start');
      this.emit('.entry _start');
      this.emit('_start:');
      if (this.funcs['__cstart']) this.emit('  call __cstart');
      else this.emit('  call main');
      this.emit('  hlt');
    }
    return this.out.join('\n') + '\n';
  };

  Gen.prototype.genFunc = function (f) {
    this.cur = { f: f, locals: Object.create(null), off: 0, retLabel: null, name: f.name };
    for (var pi = 0; pi < f.params.length; pi++) {
      var pp = f.params[pi];
      this.cur.locals[pp.name] = { ty: pp.ty, param: true, index: pi };
    }
    // 分配局部变量偏移
    this.assignLocals(f.body);
    var frame = (this.cur.off + 15) & ~15;
    this.emit('');
    this.emit('.global ' + f.name);
    this.emit(f.name + ':');
    this.emit('  push fp');
    this.emit('  mov fp, sp');
    if (frame > 0) {
      if (frame <= 2047) this.emit('  addi sp, sp, -' + frame);
      else { this.emit('  ldi r1, ' + frame); this.emit('  sub sp, sp, r1'); }
    }
    var rl = this.label('ret');
    this.cur.retLabel = rl;
    this.genStmt(f.body);
    this.emit(rl + ':');
    this.emit('  mov sp, fp');
    this.emit('  pop fp');
    this.emit('  ret');
  };

  Gen.prototype.assignLocals = function (node) {
    if (!node) return;
    if (node.k === 'block') { for (var i = 0; i < node.stmts.length; i++) this.assignLocals(node.stmts[i]); return; }
    if (node.k === 'decl') {
      var sz = sizeOf(node.ty);
      if (sz < 4) sz = 4;
      this.cur.off += (sz + 3) & ~3;
      this.cur.locals[node.name] = { ty: node.ty, off: this.cur.off };
      return;
    }
    if (node.k === 'if') { this.assignLocals(node.then); this.assignLocals(node.else); return; }
    if (node.k === 'while') { this.assignLocals(node.body); return; }
    if (node.k === 'for') { this.assignLocals(node.init); this.assignLocals(node.body); return; }
  };

  Gen.prototype.lookup = function (name) {
    if (this.cur && this.cur.locals[name]) return { kind: 'local', info: this.cur.locals[name] };
    if (this.globals[name]) return { kind: 'global', info: this.globals[name] };
    if (this.funcs[name]) return { kind: 'func', info: this.funcs[name] };
    return null;
  };

  Gen.prototype.typeOf = function (n) {
    if (!n) return { k: 'int' };
    switch (n.k) {
      case 'num': return { k: 'int' };
      case 'str': return { k: 'ptr', base: { k: 'char' } };
      case 'var': {
        var s = this.lookup(n.name);
        if (!s) throw new CErr('未声明标识符 ' + n.name);
        if (s.kind === 'func') return { k: 'ptr', base: { k: 'void' } };
        return s.info.ty;
      }
      case 'call': {
        var fv = n.fn;
        if (fv.k === 'var' && this.funcs[fv.name]) return this.funcs[fv.name].ty;
        return { k: 'int' };
      }
      case 'index': {
        var at = this.typeOf(n.arr);
        if (at.k === 'arr') return at.base;
        if (at.k === 'ptr') return at.base;
        return { k: 'int' };
      }
      case 'deref': {
        var pt = this.typeOf(n.e);
        return pt.k === 'ptr' ? pt.base : { k: 'int' };
      }
      case 'addr': return { k: 'ptr', base: this.typeOf(n.e) };
      case 'assign': return this.typeOf(n.left);
      case 'bin': {
        if (['+', '-'].indexOf(n.op) >= 0) {
          var lt = this.typeOf(n.left), rt = this.typeOf(n.right);
          if (lt.k === 'ptr' && rt.k !== 'ptr') return lt;
          if (rt.k === 'ptr' && lt.k !== 'ptr') return rt;
        }
        return { k: 'int' };
      }
      case 'neg': case 'not': case 'bnot': case 'preinc': case 'postinc': return this.typeOf(n.e);
      case 'tern': return this.typeOf(n.a);
      default: return { k: 'int' };
    }
  };

  // 生成左值地址到 r1
  Gen.prototype.genAddr = function (n) {
    if (n.k === 'var') {
      var s = this.lookup(n.name);
      if (!s) throw new CErr('未声明 ' + n.name);
      if (s.kind === 'local') {
        if (s.info.param) {
          this.emit('  addi r1, fp, ' + (8 + 4 * s.info.index));
          return;
        }
        var off = s.info.off;
        if (off <= 2047) this.emit('  addi r1, fp, -' + off);
        else { this.emit('  ldi r1, ' + off); this.emit('  sub r1, fp, r1'); }
      } else if (s.kind === 'global') {
        this.emit('  ldi r1, ' + n.name);
      } else throw new CErr('不能取函数地址 ' + n.name);
      return;
    }
    if (n.k === 'index') {
      var at = this.typeOf(n.arr);
      var esz = at.k === 'arr' ? sizeOf(at.base) : at.k === 'ptr' ? sizeOf(at.base) : 4;
      // 基址: 数组取地址, 指针取存放的值
      this.gen(n.arr);
      this.emit('  push r0');
      this.gen(n.idx);
      if (esz !== 1) { this.emit('  ldi r2, ' + esz); this.emit('  mul r0, r0, r2'); }
      this.emit('  mov r2, r0');
      this.emit('  pop r1');
      this.emit('  add r1, r1, r2');
      return;
    }
    if (n.k === 'deref') { this.gen(n.e); this.emit('  mov r1, r0'); return; }
    throw new CErr('表达式不可赋值');
  };

  Gen.prototype.loadFrom = function (ty) {
    var sz = sizeOf(ty);
    if (ty.k === 'arr') return;  // 数组名=地址, 已在 r1 -> 移到 r0
    if (sz === 1) this.emit('  ldb r0, [r1+0]');
    else this.emit('  ld r0, [r1+0]');
  };

  Gen.prototype.gen = function (n) {
    var self = this;
    switch (n.k) {
      case 'num': this.emit('  ldi r0, ' + (n.v | 0)); return;
      case 'str': {
        var lbl = '.LC' + (this.strN++);
        var esc = n.v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
        this.data.push(lbl + ':');
        this.data.push('  .asciz "' + esc + '"');
        this.emit('  ldi r0, ' + lbl);
        return;
      }
      case 'var': {
        var s = this.lookup(n.name);
        if (!s) throw new CErr('未声明标识符 ' + n.name);
        if (s.kind === 'func') { this.emit('  ldi r0, ' + n.name); return; }
        this.genAddr(n);
        if (s.info.ty.k === 'arr') { this.emit('  mov r0, r1'); return; }
        this.loadFrom(s.info.ty);
        return;
      }
      case 'index': {
        this.genAddr(n);
        var ty = this.typeOf(n);
        if (ty.k === 'arr') { this.emit('  mov r0, r1'); return; }
        this.loadFrom(ty);
        return;
      }
      case 'deref': {
        this.gen(n.e);
        this.emit('  mov r1, r0');
        var ty2 = this.typeOf(n);
        if (ty2.k === 'arr') { this.emit('  mov r0, r1'); return; }
        this.loadFrom(ty2);
        return;
      }
      case 'addr': this.genAddr(n.e); this.emit('  mov r0, r1'); return;
      case 'neg': this.gen(n.e); this.emit('  ldi r1, 0'); this.emit('  sub r0, r1, r0'); return;
      case 'bnot': this.gen(n.e); this.emit('  not r0, r0'); return;
      case 'not': {
        this.gen(n.e);
        this.emit('  ldi r3, 0');
        this.emit('  cmp r0, r3');
        var l1 = this.label('nt'), l2 = this.label('ne');
        this.emit('  ldi r0, 0');
        this.emit('  jnz ' + l1);
        this.emit('  ldi r0, 1');
        this.emit(l1 + ':');
        void l2;
        return;
      }
      case 'bin': return this.genBin(n);
      case 'assign': {
        // 先算地址, 再算右值
        this.genAddr(n.left);
        this.emit('  push r1');
        this.gen(n.right);
        this.emit('  pop r1');
        var lty = this.typeOf(n.left);
        if (n.op === '+=' || n.op === '-=') {
          if (sizeOf(lty) === 1) this.emit('  ldb r2, [r1+0]');
          else this.emit('  ld r2, [r1+0]');
          this.emit(n.op === '+=' ? '  add r0, r2, r0' : '  sub r0, r2, r0');
        }
        if (sizeOf(lty) === 1) this.emit('  stb [r1+0], r0');
        else this.emit('  st [r1+0], r0');
        return;
      }
      case 'preinc': case 'postinc': {
        this.genAddr(n.e);
        var ty3 = this.typeOf(n.e);
        var sz2 = sizeOf(ty3) || 4;
        this.emit('  push r1');
        if (sz2 === 1) this.emit('  ldb r2, [r1+0]');
        else this.emit('  ld r2, [r1+0]');
        this.emit('  ldi r3, ' + sz2);
        this.emit(n.d > 0 ? '  add r2, r2, r3' : '  sub r2, r2, r3');
        this.emit('  pop r1');
        if (sz2 === 1) this.emit('  stb [r1+0], r2');
        else this.emit('  st [r1+0], r2');
        if (n.k === 'preinc') this.emit('  mov r0, r2');
        else { this.emit('  ldi r3, ' + sz2); this.emit(n.d > 0 ? '  sub r0, r2, r3' : '  add r0, r2, r3'); }
        return;
      }
      case 'tern': {
        var lf = this.label('tf'), le = this.label('te');
        this.gen(n.c);
        this.emit('  ldi r3, 0');
        this.emit('  cmp r0, r3');
        this.emit('  jz ' + lf);
        this.gen(n.a);
        this.emit('  jmp ' + le);
        this.emit(lf + ':');
        this.gen(n.b);
        this.emit(le + ':');
        return;
      }
      case 'call': return this.genCall(n);
      default: throw new CErr('无法生成 ' + n.k);
    }
  };

  Gen.prototype.genBin = function (n) {
    var op = n.op;
    if (op === '&&' || op === '||') {
      var lend = this.label('sc');
      this.gen(n.left);
      this.emit('  ldi r3, 0');
      this.emit('  cmp r0, r3');
      if (op === '&&') {
        this.emit('  jz ' + lend);        // 假 -> 结果0
      } else {
        var ltrue = this.label('or');
        this.emit('  jnz ' + ltrue);
        this.gen(n.right);
        this.emit('  ldi r3, 0');
        this.emit('  cmp r0, r3');
        this.emit('  ldi r0, 0');
        this.emit('  jz ' + lend);
        this.emit(ltrue + ':');
        this.emit('  ldi r0, 1');
        this.emit(lend + ':');
        return;
      }
      this.gen(n.right);
      this.emit('  ldi r3, 0');
      this.emit('  cmp r0, r3');
      this.emit('  ldi r0, 0');
      this.emit('  jz ' + lend);
      this.emit('  ldi r0, 1');
      this.emit(lend + ':');
      return;
    }
    // 指针缩放
    var lt = this.typeOf(n.left), rt = this.typeOf(n.right);
    var scale = 0;
    if (op === '+' || op === '-') {
      if (lt.k === 'ptr' && rt.k !== 'ptr') scale = sizeOf(lt.base) || 1;
      else if (rt.k === 'ptr' && lt.k !== 'ptr') scale = sizeOf(rt.base) || 1;
    }
    this.gen(n.left);
    this.emit('  push r0');
    this.gen(n.right);
    if (scale > 1) { this.emit('  ldi r3, ' + scale); this.emit('  mul r0, r0, r3'); }
    this.emit('  mov r2, r0');
    this.emit('  pop r1');
    switch (op) {
      case '+': this.emit('  add r0, r1, r2'); return;
      case '-': this.emit('  sub r0, r1, r2'); return;
      case '*': this.emit('  mul r0, r1, r2'); return;
      case '/': this.emit('  div r0, r1, r2'); return;
      case '%': this.emit('  mod r0, r1, r2'); return;
      case '&': this.emit('  and r0, r1, r2'); return;
      case '|': this.emit('  or r0, r1, r2'); return;
      case '^': this.emit('  xor r0, r1, r2'); return;
      case '<<': this.emit('  shl r0, r1, r2'); return;
      case '>>': this.emit('  sar r0, r1, r2'); return;
      case '==': case '!=': case '<': case '<=': case '>': case '>=': {
        var jmp = { '==': 'jz', '!=': 'jnz', '<': 'jl', '<=': 'jle', '>': 'jg', '>=': 'jge' }[op];
        var ltrue2 = this.label('ct'), lend2 = this.label('ce');
        this.emit('  cmp r1, r2');
        this.emit('  ldi r0, 0');
        this.emit('  ' + jmp + ' ' + ltrue2);
        this.emit('  jmp ' + lend2);
        this.emit(ltrue2 + ':');
        this.emit('  ldi r0, 1');
        this.emit(lend2 + ':');
        return;
      }
      default: throw new CErr('未知运算符 ' + op);
    }
  };

  Gen.prototype.genCall = function (n) {
    if (n.fn.k !== 'var') throw new CErr('只支持直接调用函数');
    var name = n.fn.name;
    var decl = this.funcs[name];
    var params = decl ? decl.params.length : n.args.length;
    var nargs = n.args.length;
    var total = Math.max(params, nargs);
    // 右往左压栈
    for (var i = total - 1; i >= 0; i--) {
      if (i < nargs) this.gen(n.args[i]);
      else this.emit('  ldi r0, 0');
      this.emit('  push r0');
    }
    this.emit('  call ' + name);
    if (total > 0) {
      var bytes = total * 4;
      if (bytes <= 2047) this.emit('  addi sp, sp, ' + bytes);
      else { this.emit('  ldi r1, ' + bytes); this.emit('  add sp, sp, r1'); }
    }
  };

  // ---- 语句 ----
  Gen.prototype.genStmt = function (s) {
    if (!s) return;
    switch (s.k) {
      case 'block': for (var i = 0; i < s.stmts.length; i++) this.genStmt(s.stmts[i]); return;
      case 'decl': {
        if (s.init) {
          this.genAddr({ k: 'var', name: s.name });
          this.emit('  push r1');
          this.gen(s.init);
          this.emit('  pop r1');
          var sz = sizeOf(s.ty);
          if (sz === 1) this.emit('  stb [r1+0], r0');
          else this.emit('  st [r1+0], r0');
        }
        return;
      }
      case 'expr': this.gen(s.e); return;
      case 'return': {
        if (s.e) this.gen(s.e);
        else this.emit('  ldi r0, 0');
        this.emit('  jmp ' + this.cur.retLabel);
        return;
      }
      case 'if': {
        var lelse = this.label('if'), lend = this.label('fi');
        this.gen(s.cond);
        this.emit('  ldi r3, 0');
        this.emit('  cmp r0, r3');
        this.emit('  jz ' + (s.else ? lelse : lend));
        this.genStmt(s.then);
        if (s.else) {
          this.emit('  jmp ' + lend);
          this.emit(lelse + ':');
          this.genStmt(s.else);
        }
        this.emit(lend + ':');
        return;
      }
      case 'while': {
        var ltop = this.label('wh'), lend2 = this.label('ew');
        this.condStack.push({ brk: lend2, cont: ltop });
        this.emit(ltop + ':');
        this.gen(s.cond);
        this.emit('  ldi r3, 0');
        this.emit('  cmp r0, r3');
        this.emit('  jz ' + lend2);
        this.genStmt(s.body);
        this.emit('  jmp ' + ltop);
        this.emit(lend2 + ':');
        this.condStack.pop();
        return;
      }
      case 'for': {
        var ltop2 = this.label('fo'), lend3 = this.label('ef'), lstep = this.label('st');
        this.condStack.push({ brk: lend3, cont: lstep });
        if (s.init) this.genStmt(s.init);
        this.emit(ltop2 + ':');
        if (s.cond) {
          this.gen(s.cond);
          this.emit('  ldi r3, 0');
          this.emit('  cmp r0, r3');
          this.emit('  jz ' + lend3);
        }
        this.genStmt(s.body);
        this.emit(lstep + ':');
        if (s.step) this.gen(s.step);
        this.emit('  jmp ' + ltop2);
        this.emit(lend3 + ':');
        this.condStack.pop();
        return;
      }
      case 'break': {
        if (!this.condStack.length) throw new CErr('break 不在循环中');
        this.emit('  jmp ' + this.condStack[this.condStack.length - 1].brk);
        return;
      }
      case 'continue': {
        if (!this.condStack.length) throw new CErr('continue 不在循环中');
        this.emit('  jmp ' + this.condStack[this.condStack.length - 1].cont);
        return;
      }
      case 'empty': return;
      default: throw new CErr('未知语句 ' + s.k);
    }
  };

  function compile(src, opts) {
    var toks = lex(src);
    var p = new Parser(toks);
    var prog = p.parseProgram();
    // 全局变量数据段
    var g = new Gen(prog, opts);
    for (var i = 0; i < prog.length; i++) {
      var d = prog[i];
      if (d.k !== 'gvar') continue;
      g.data.push('.global ' + d.name);
      g.data.push(d.name + ':');
      var sz = sizeOf(d.ty);
      if (d.init && d.init.k === 'num') {
        for (var w = 0; w < Math.max(1, sz / 4); w++) g.data.push('  .word ' + (w === 0 ? (d.init.v | 0) : 0));
      } else if (d.ty.k === 'arr' && d.ty.base.k === 'char') {
        g.data.push('  .space ' + sz);
      } else {
        g.data.push('  .space ' + Math.max(4, sz));
      }
    }
    return g.run();
  }

  var api = { compile: compile, CErr: CErr, lex: lex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LUMENC = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
