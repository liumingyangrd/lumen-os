/* Lumen OS 前端：把 LUX-32 虚拟机接到屏幕、键盘和监视面板上 */
(function () {
  'use strict';

  var IMG = Uint8Array.from(atob(window.__LUMEN_IMAGE__), function (c) { return c.charCodeAt(0); });
  var SYM = window.__LUMEN_SYMS__ || {};
  var Machine = LUX.Machine;

  var PAL = ['#0a0c0e', '#2b4bd8', '#33c46f', '#26b8c4', '#e0524f', '#c451c4', '#c07a2c', '#c6ccd4',
             '#5c6673', '#7b93ff', '#6df29a', '#66e8ec', '#ff7f74', '#f07ae0', '#ffe066', '#ffffff'];

  var vm = null;
  var rows = [];
  var cache = [];
  var blinkOn = true;
  var paused = false;

  /* ---------------- 屏幕 ---------------- */
  var screenEl = document.getElementById('screen');
  function buildRows() {
    screenEl.innerHTML = '';
    rows = []; cache = [];
    for (var y = 0; y < 25; y++) {
      var d = document.createElement('div');
      d.className = 'row';
      screenEl.appendChild(d);
      rows.push(d);
      cache.push('');
    }
  }
  buildRows();

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function spanHTML(text, at) {
    var fg = PAL[at & 0x0f];
    var bg = PAL[(at >> 4) & 0x0f];
    var st = 'color:' + fg;
    if (bg !== PAL[0]) st += ';background:' + bg;
    return '<span style="' + st + '">' + esc(text) + '</span>';
  }
  function isWide(cp) {
    return (cp >= 0x1100 && cp <= 0x115F) || (cp >= 0x2E80 && cp <= 0xA4CF) ||
           (cp >= 0xAC00 && cp <= 0xD7A3) || (cp >= 0xF900 && cp <= 0xFAFF) ||
           (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFF60) ||
           (cp >= 0xFFE0 && cp <= 0xFFE6);
  }
  function chOf(cp) {
    if (cp === 0) return ' ';
    try { return String.fromCodePoint(cp); } catch (e) { return ' '; }
  }

  function render() {
    if (!vm) return;
    var cells = vm.screenCells();
    var cur = vm.cursor | 0;
    for (var y = 0; y < 25; y++) {
      var html = '', run = '', runAttr = -1;
      for (var x = 0; x < 80; x++) {
        var i = y * 80 + x;
        var cp = cells[i * 2];
        var at = cells[i * 2 + 1];
        if (cp === 0xFFFF) continue;              // 宽字符占位单元
        var w = cp > 0 && isWide(cp);
        if (i === cur && blinkOn) {
          if (run) { html += spanHTML(run, runAttr); run = ''; runAttr = -1; }
          html += '<span class="cur">' + (w ? '&#12288;' : ' ') + '</span>';
          continue;
        }
        if (w) {
          if (run) { html += spanHTML(run, runAttr); run = ''; runAttr = -1; }
          html += '<span class="w2" style="color:' + PAL[at & 0x0f] + '">' + esc(chOf(cp)) + '</span>';
          continue;
        }
        if (at !== runAttr) {
          if (run) html += spanHTML(run, runAttr);
          run = '';
          runAttr = at;
        }
        run += chOf(cp);
      }
      if (run) html += spanHTML(run, runAttr);
      if (html !== cache[y]) { rows[y].innerHTML = html; cache[y] = html; }
    }
  }

  /* ---------------- 键盘 ---------------- */
  var KMAP = {};
  (function () {
    var letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (var i = 0; i < 26; i++) KMAP['Key' + letters[i]] = i + 1;
    for (var d = 0; d < 10; d++) KMAP['Digit' + d] = 27 + d;
    KMAP.Enter = 37; KMAP.Escape = 38; KMAP.Backspace = 39; KMAP.Tab = 40; KMAP.Space = 41;
    KMAP.Minus = 42; KMAP.Equal = 43; KMAP.Comma = 44; KMAP.Period = 45; KMAP.Slash = 46;
    KMAP.Semicolon = 47; KMAP.Quote = 48; KMAP.BracketLeft = 49; KMAP.BracketRight = 50;
    KMAP.Backslash = 51; KMAP.Backquote = 52;
    KMAP.ArrowUp = 53; KMAP.ArrowDown = 54; KMAP.ArrowLeft = 55; KMAP.ArrowRight = 56;
  })();

  function key(code) {
    if (!vm) return;
    if (vm.keyQueue.length > 24) vm.keyQueue.shift();
    vm.keyQueue.push(code);
    vm.raiseIRQ(0x21);
  }

  window.addEventListener('keydown', function (e) {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { key(57); return; }
    if (e.ctrlKey && e.code !== 'ControlLeft') return;
    var c = KMAP[e.code];
    if (c !== undefined) {
      e.preventDefault();
      key(c);
    }
  });
  window.addEventListener('keyup', function (e) {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') key(58);
  });

  /* ---------------- 监视面板 ---------------- */
  function hex(v) {
    v = v >>> 0;
    var s = v.toString(16).toUpperCase();
    while (s.length < 6) s = '0' + s;
    return '0x' + s;
  }
  function readStr(addr, max) {
    var s = '';
    for (var i = 0; i < max; i++) {
      var c = vm.mem[addr + i];
      if (!c) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  var STATE_NAME = { 1: '就绪', 2: '运行', 3: '等待', 4: '退出' };

  function updatePanel() {
    if (!vm) return;
    var r = vm.regs();
    document.getElementById('pCpu').innerHTML =
      kv('PC', hex(r.pc)) + kv('SP', hex(r.sp)) + kv('FP', hex(r.fp)) +
      kv('R0', (r.r0 | 0)) + kv('R1', (r.r1 | 0)) + kv('R2', (r.r2 | 0)) +
      kv('IF', vm.IF ? '开' : '关') + kv('指令数', vm.instrs.toLocaleString()) +
      kv('滴答', vm.ticks);

    var t = '';
    if (SYM.t_state !== undefined) {
      var curTask = vm.rd32(SYM.cur);
      for (var i = 0; i < 12; i++) {
        var st = vm.rd32(SYM.t_state + i * 4);
        if (!st) continue;
        var pid = vm.rd32(SYM.t_pid + i * 4);
        var nm = readStr(SYM.t_names + i * 16, 16) || '?';
        t += '<div class="taskrow' + (i === curTask ? ' on' : '') + '">' +
             '<b>' + pid + '</b><span>' + esc(nm) + '</span><i>' + (STATE_NAME[st] || st) + '</i></div>';
      }
    }
    document.getElementById('pTask').innerHTML = t || '<div class="dim">—</div>';

    var f = '';
    if (SYM.fsBase !== undefined && vm.disk && vm.disk.length) {
      var disk = vm.disk;
      var base = SYM.fsBase + 1024;          // 目录表在块 2
      var n = 0;
      var used = 0;
      for (var k = 0; k < 64; k++) {
        var e = base + k * 64;
        var name = '';
        for (var j = 0; j < 40; j++) {
          var c = disk[e + j];
          if (!c) break;
          name += String.fromCharCode(c);
        }
        if (!name) continue;
        var size = (disk[e + 44] | (disk[e + 45] << 8) | (disk[e + 46] << 16) | (disk[e + 47] << 24)) >>> 0;
        used += size;
        f += '<div class="filerow"><span>' + esc(name) + '</span><i>' + size + ' B</i></div>';
        n++;
      }
      f = '<div class="dim">' + n + ' 个文件 · ' + (used / 1024).toFixed(1) + ' KiB</div>' + f;
    }
    document.getElementById('pFs').innerHTML = f;

    var led = document.getElementById('led');
    led.className = 'led' + (paused ? ' off' : (vm.halted ? ' idle' : ' busy'));
    document.getElementById('pwr').textContent = paused ? 'PAUSED' : (vm.dead ? 'FAULT' : 'RUNNING');
  }

  function kv(k, v) {
    return '<div class="kvrow"><span>' + k + '</span><b>' + v + '</b></div>';
  }

  /* ---------------- 启动 / 主循环 ---------------- */
  function boot() {
    vm = new Machine();
    vm.loadImage(IMG);
    cache = [];
    for (var i = 0; i < rows.length; i++) { rows[i].innerHTML = ''; cache.push(''); }
    acc = 0;
    last = performance.now();
    paused = false;
    document.getElementById('btnPause').textContent = '暂停';
    render();
  }

  var acc = 0, last = 0;

  function frame() {
    var now = performance.now();
    if (vm && !paused) {
      acc += now - last;
      if (acc > 200) acc = 200;
      var n = 0;
      while (acc >= 10 && n < 6) {
        acc -= 10;
        vm.ticks++;
        vm.raiseIRQ(0x20);
        n++;
      }
      var t0 = performance.now();
      while (performance.now() - t0 < 7) {
        if (vm.run(20000) === 0) break;
      }
    }
    last = now;
    render();
    requestAnimationFrame(frame);
  }

  document.getElementById('btnPause').addEventListener('click', function () {
    paused = !paused;
    this.textContent = paused ? '继续' : '暂停';
    updatePanel();
  });
  document.getElementById('btnReset').addEventListener('click', function () {
    boot();
  });

  setInterval(function () { blinkOn = !blinkOn; }, 520);
  setInterval(updatePanel, 220);
  setInterval(function () {
    document.getElementById('uptime').textContent = (vm ? (vm.ticks / 100).toFixed(1) + 's' : '0s');
  }, 300);

  boot();
  requestAnimationFrame(frame);

  // 供自动化测试与调试使用
  window.__lumen = { machine: function () { return vm; }, render: render, frame: frame, boot: boot };
})();
