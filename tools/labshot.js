'use strict';
// 在 VMware 里跑一个镜像，并抓下客户机屏幕（PNG）
//
// 用法: node tools/labshot.js <iso路径> [等待秒数] [输出png]
//
// 两个关键点：
//   1. ISO 文件名每次都带时间戳 —— VMware 会缓存虚拟光驱里的 ISO 内容，
//      换文件名才能让客户机读到最新的镜像。
//   2. 客户机没装 VMware Tools，截不了图；VNC 直接读帧缓冲，不依赖客户机。

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VMRUN = 'C:/Program Files (x86)/VMware/VMware Workstation/vmrun.exe';
const LAB = path.join(ROOT, 'vmware', 'lab');
const VMX = path.join(LAB, 'lab.vmx');

const iso = process.argv[2];
const wait = process.argv[3] || '9';
const out = process.argv[4] || path.join('vmware', 'lab', 'shot.png');

const stamp = Date.now();
const isoName = 'lab-' + stamp + '.iso';
const isoPath = path.join(ROOT, 'dist', isoName);
fs.copyFileSync(iso, isoPath);

// 每次都在全新目录里建虚拟机：VMware 会缓存虚拟光驱里的 ISO 内容，
// 复用同一个 .vmx 就可能读到上一轮的旧镜像。
const runDir = path.join(LAB, 'run-' + stamp);
fs.mkdirSync(runDir, { recursive: true });
const runVmx = path.join(runDir, 'lab.vmx');

const template = fs.readFileSync(VMX, 'utf8');
let vmx = template.replace(/ide1:0\.fileName = ".*?"/,
  'ide1:0.fileName = "' + isoPath.replace(/\\/g, '\\\\') + '"');
vmx = vmx.replace(/serial0\.fileName = ".*?"/,
  'serial0.fileName = "' + path.join(runDir, 'serial.log').replace(/\\/g, '\\\\') + '"');
fs.writeFileSync(runVmx, vmx);

// 串口日志
const serial = path.join(runDir, 'serial.log');
try { fs.unlinkSync(serial); } catch (e) { /* ignore */ }

// 停掉所有还在跑的实例：VNC 端口是固定的，旧实例不死就会抢走端口，
// 导致截图连到上一轮的旧画面。
try {
  const list = execFileSync(VMRUN, ['-T', 'ws', 'list'], { encoding: 'utf8' });
  for (const line of list.split('\n')) {
    const m = line.match(/^(\S+\.vmx)$/);
    if (m && m[1] !== runVmx) {
      try { execFileSync(VMRUN, ['-T', 'ws', 'stop', m[1], 'hard'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
    }
  }
} catch (e) { /* ignore */ }
try { execFileSync(VMRUN, ['-T', 'ws', 'stop', runVmx, 'hard'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
execSync('sleep 1');

execFileSync(VMRUN, ['-T', 'ws', 'start', runVmx, 'nogui'], { stdio: 'ignore' });
execSync('sleep ' + wait);

// VNC 端口可能稍晚才起来，重试几次
execSync('sleep 2');

// 抓屏（VNC 端口可能要等一会儿才起来，重试几次）
// mousePath（第 5 个参数，"x,y x,y ..."）给了就注入指针移动并连拍
const outPath = path.isAbsolute(out) ? out : path.join(ROOT, out);
let shotOk = false;
for (let attempt = 0; attempt < 6 && !shotOk; attempt++) {
  try {
    let r;
    if (process.argv[5]) {
      const outs = outPath.replace(/\.png$/i, '') + '-1.png ' +
                   outPath.replace(/\.png$/i, '') + '-2.png';
      r = execFileSync('node', [path.join(__dirname, 'vncmouse.js')]
            .concat(outs.split(' ')), { encoding: 'utf8' });
    } else {
      r = execFileSync('node', [path.join(__dirname, 'vncshot.js'), outPath], { encoding: 'utf8' });
    }
    process.stdout.write(r);
    shotOk = true;
  } catch (e) {
    if (attempt === 5) process.stdout.write((e.stdout || '') + (e.stderr || '') + '\n');
    else execSync('sleep 3');
  }
}

// 停机后再读串口日志：虚拟机还在跑时 VMware 的串口文件是缓冲的，读到的是半截
try { execFileSync(VMRUN, ['-T', 'ws', 'stop', runVmx, 'hard'], { stdio: 'ignore' }); } catch (e) { /* ignore */ }
execSync('sleep 1');

// 串口日志
if (fs.existsSync(serial)) {
  const buf = fs.readFileSync(serial);
  process.stdout.write('--- 串口 ---\n');
  process.stdout.write(buf.toString('utf8').replace(/\0/g, ''));
  process.stdout.write('\n');
}

