'use strict';
// 在 VMware Workstation 的"客户机操作系统"列表里加入 Lumen OS。
//
// 说明白：这个工具只改"显示文字"，不会让 VMware 执行 LUX-32 指令。
// VMware 的 vCPU 是闭源的，指令译码只认宿主架构（x86_64 / ARM64），没有
// 加指令集的接口。列表里选什么，只影响虚拟硬件默认值和图标。
//
// 用法（需要管理员权限，Program Files 不可写）：
//   node tools/vmware-lumen.js add        追加 Lumen 条目（非破坏，是否显示取决于界面实现）
//   node tools/vmware-lumen.js relabel    把"其他"改名为 "Lumen OS (LUX-32)"（一定能看到）
//   node tools/vmware-lumen.js restore    还原备份
//   node tools/vmware-lumen.js status     查看当前状态
//   --dir=<安装目录>   指定 VMware 安装目录（测试用）

const fs = require('fs');
const path = require('path');

const MARK_ADD = 'msg.gostable.family.lumen';
const ADD_LINES = [
  'msg.gostable.family.lumen = "Lumen OS (LUX-32)"',
  'msg.gostable8.guest.lumen = "Lumen OS 1.0 (LUX-32)"',
  'msg.gostable7.guest.lumen = "Lumen OS 1.0 (LUX-32)"'
];

function findInstall(argDir) {
  if (argDir) return argDir;
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)'];
  for (const r of roots) {
    if (!r) continue;
    const p = path.join(r, 'VMware', 'VMware Workstation');
    if (fs.existsSync(path.join(p, 'messages'))) return p;
  }
  throw new Error('找不到 VMware Workstation 安装目录，请用 --dir= 指定');
}

function vmsgFiles(install) {
  const dir = path.join(install, 'messages');
  if (!fs.existsSync(dir)) throw new Error('没有 messages 目录：' + dir);
  const out = [];
  for (const loc of fs.readdirSync(dir)) {
    const f = path.join(dir, loc, 'vmware.vmsg');
    if (fs.existsSync(f)) out.push(f);
  }
  return out;
}

function backupOf(file) {
  return file + '.lumenbak';
}

function status(install) {
  for (const f of vmsgFiles(install)) {
    const t = fs.readFileSync(f, 'utf8');
    const hasAdd = t.includes(MARK_ADD);
    const relabeled = t.includes('msg.gostable.family.other = "Lumen OS');
    const bak = fs.existsSync(backupOf(f));
    console.log(path.basename(path.dirname(f)).padEnd(8),
      '已追加=' + (hasAdd ? '是' : '否'),
      '已改名=' + (relabeled ? '是' : '否'),
      '有备份=' + (bak ? '是' : '否'));
  }
}

function write(file, text) {
  try {
    fs.writeFileSync(file, text, 'utf8');
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      throw new Error('没有写入权限。请用管理员身份打开终端再运行本工具。');
    }
    throw e;
  }
}

function add(install) {
  for (const f of vmsgFiles(install)) {
    let t = fs.readFileSync(f, 'utf8');
    if (t.includes(MARK_ADD)) { console.log('跳过（已存在）:', f); continue; }
    if (!fs.existsSync(backupOf(f))) fs.copyFileSync(f, backupOf(f));
    const anchor = 'msg.gostable.family.windows = "Microsoft Windows"\r\n';
    if (!t.includes(anchor)) throw new Error('找不到插入点：' + f);
    t = t.replace(anchor, anchor + ADD_LINES.join('\r\n') + '\r\n');
    write(f, t);
    console.log('已追加 Lumen 条目:', f);
  }
  console.log('\n重启 VMware Workstation 后生效（关闭所有窗口，包括后台的 vmware-tray）。');
  console.log('注意：界面如果按固定清单渲染，追加不会多出选项——那就用 relabel。');
}

function relabel(install) {
  for (const f of vmsgFiles(install)) {
    let t = fs.readFileSync(f, 'utf8');
    if (!fs.existsSync(backupOf(f))) fs.copyFileSync(f, backupOf(f));
    const re = /msg\.gostable\.family\.other = "[^"]*"/;
    if (!re.test(t)) throw new Error('找不到"其他"条目：' + f);
    t = t.replace(re, 'msg.gostable.family.other = "Lumen OS (LUX-32)"');
    write(f, t);
    console.log('已把"其他"改名为 "Lumen OS (LUX-32)":', f);
  }
  console.log('\n重启 VMware Workstation 后生效。');
  console.log('还原：node tools/vmware-lumen.js restore');
}

function restore(install) {
  let n = 0;
  for (const f of vmsgFiles(install)) {
    const b = backupOf(f);
    if (!fs.existsSync(b)) continue;
    write(f, fs.readFileSync(b, 'utf8'));
    fs.unlinkSync(b);
    n++;
    console.log('已还原:', f);
  }
  console.log(n ? '' : '没有找到备份，无需还原。');
}

function main() {
  const args = process.argv.slice(2);
  const dirArg = args.find((a) => a.startsWith('--dir='));
  const install = findInstall(dirArg ? dirArg.slice(6) : null);
  const cmd = args.find((a) => !a.startsWith('--')) || 'status';
  console.log('VMware 安装目录:', install, '\n');
  if (cmd === 'add') add(install);
  else if (cmd === 'relabel') relabel(install);
  else if (cmd === 'restore') restore(install);
  else status(install);
}

main();
