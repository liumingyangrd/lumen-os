/* 在 node 里用桩 DOM 运行真正的 web/app.js 逻辑 */
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'dist', 'LumenOS.html'), 'utf8');
const m1 = /"([A-Za-z0-9+/=]{500,})"/.exec(html);
const b64 = m1[1];
const syms = JSON.parse(/window\.__LUMEN_SYMS__ = (\{.*?\});/s.exec(html)[1]);

function mkEl() {
  const e = {
    _h: '', className: '', textContent: '', style: {}, children: [],
    set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; },
    appendChild(c) { this.children.push(c); }, addEventListener() {}
  };
  return e;
}
const els = {};
global.window = { addEventListener() { }, __LUMEN_IMAGE__: b64, __LUMEN_SYMS__: syms };
global.document = { getElementById(id) { return els[id] || (els[id] = mkEl()); }, createElement() { return mkEl(); } };
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = () => {};
const timers = []; global.setInterval = (fn) => { timers.push(fn); };

const vmSrc = fs.readFileSync(path.join(__dirname, '..', 'tools', 'vm.js'), 'utf8');
new Function(vmSrc)();
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'web', 'app.js'), 'utf8');
new Function(appSrc)();

const L = window.__lumen;
const m = L.machine();
for (let t = 0; t < 180; t++) { m.ticks++; m.raiseIRQ(0x20); L.frame(); }

timers.forEach(f => { try { f(); } catch (e) { console.log('定时器异常:', e.message); } });
const screen = els['screen'];
console.log('渲染单元格行数:', screen.children.length);
const rowsHtml = screen.children.map(c => c.innerHTML.replace(/<[^>]+>/g, ''));
console.log(rowsHtml.slice(0, 16).join('\n'));
const strip = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
console.log('--- CPU 面板 ---'); console.log(strip(els['pCpu'].innerHTML));
console.log('--- 任务面板 ---'); console.log(strip(els['pTask'].innerHTML));
console.log('--- 文件面板 ---'); console.log(strip(els['pFs'].innerHTML).slice(0, 200));
console.log('--- 状态 ---'); console.log(strip(els['pwr'].textContent || ''), 'dead:', m.dead, m.fault || '');
