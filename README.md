# Lumen OS

一个从指令集开始、完全自建的计算机系统。**不是 Linux，不是 POSIX，不是任何现有系统的改版**，
也没有直接使用任何现成的内核、编译器或文件系统。

打开 `dist/LumenOS.html` 即可开机（单文件，双击就用，无需安装任何东西）。

```
    _      _   _ __  __  ___ _  _
  | |    | | | |  \/  || __| \| |
  | |__  | |_| | |\/| || _|| .` |
  |____|  \___/|_|  |_||___|_|\_|
```

## 一、这套系统里有什么

| 层 | 名称 | 说明 |
|---|---|---|
| 处理器 | **LUX-32** | 自行设计的 32 位 RISC 指令集：12 个寄存器、定长指令、端口 I/O、中断向量 |
| 机器 | **LUX-32 VM** | 自行实现的整机：16 MiB 内存、80×25 文本显存、键盘、PIT、RTC、磁盘 |
| 引导 | `boot.ls` | 512 字节引导扇区，从磁盘把内核读到 `0x100000` 再跳转 |
| 内核 | **Lumen** | 约 1500 行（汇编 + Lumen-C）：控制台、键盘、磁盘、文件系统、调度器、系统调用、加载器 |
| 汇编器 | **luxasm** | 自行实现：两遍扫描、符号表、宏、伪指令、UTF-8 字符串、重定位表 |
| 编译器 | **lcc** | 自行实现：Lumen-C → LUX-32 原生机器码（词法/语法/代码生成，约 700 行） |
| 语言 | **Lumen-C** | C 子集：int/char/void/指针/数组/结构控制流/位运算/三元 |
| 可执行格式 | **LMX** | 自研格式，扩展名 `.lmx`，带重定位表，可加载到任意基址 |
| 文件系统 | **LMFS** | 自研格式，扩展名 `.lmfs`，超级块 + 目录表 + 连续分配的块 |
| Shell | **lsh** | 独立用户程序，从磁盘加载，不是内核内置 |

## 二、跑起来

```
node tools/build.js          # 编译全部用户程序 + 内核 + 打包磁盘镜像
```

产物：

| 文件 | 大小 | 说明 |
|---|---|---|
| `dist/LumenOS-x86.iso` | 600 KB | **x86 原生版光盘**，VMware / VirtualBox / 真机 BIOS 可直接启动，运行 x86 汇编写的内核 |
| `dist/LumenOS-1.0.iso` | 1.15 MB | **可启动光盘镜像**（El Torito），可在 PC / VMware / VirtualBox 引导；也可直接挂载浏览内容 |
| `dist/lumen.lmi` | 384 KB | 完整启动镜像：引导扇区 + 内核 + LMFS 磁盘（512 B 扇区） |
| `dist/LumenOS.html` | 541 KB | 单文件系统，内嵌整块启动镜像，浏览器打开即开机 |
| `dist/kernel.debug.s` | 119 KB | 内核的完整汇编输出（编译器真实产物，可阅读） |
| `dist/SHA256SUMS.txt` | — | 校验值 |

光盘里装的是：

```
README.TXT     1.0 KB   说明（含免责声明：本盘不是 x86 启动盘）
LUMENOS.HTM  541 KB     浏览器里跑的整机
LUMEN.LMI    384 KB     LUX-32 可引导镜像
LUMEN.MAN    4.7 KB     LUX-32 体系结构手册
SOURCE.ZIP   157 KB     36 个源文件（汇编器/编译器/内核/程序/前端）
```

ISO 是纯手写的 ISO 9660 Level 1 写入器生成的（`tools/iso.js`），源码包也是手写的
ZIP 打包器（`tools/zip.js`），同样没有用任何第三方库。

## 三、x86 原生版（VMware / 真机直接启动）

`dist/LumenOS-x86.iso` 是一个**能真启动**的系统盘：内核用 x86 机器码写，由真实 CPU
直接执行，中间没有模拟层。同一张盘既能当光盘引导（El Torito），也能 `dd` 到 U 盘引导
（混合 MBR）。

```
Lumen OS 1.0  ·  x86 native build
==========================================
arch    x86 16-bit real mode (no emulation)
memory  640 KiB low, video 80x25 text
fs      LMFS volume loaded with the boot image
serial  COM1 115200 8N1 - every character mirrored
note    the LUX-32 original lives in LUMENOS.HTM

type help to list commands

lumen-x86> ls
README.TXT 280
MOTD.TXT 346
KMAIN.ASM 9949
HELLO.TXT 28
lumen-x86> cat HELLO.TXT
hello from the LMFS volume
lumen-x86> _
```

命令：`help` / `ver` / `ls` / `cat FILE` / `clear` / `reboot`。
屏幕输出同时镜像到 COM1，在没有 VMware Tools 的情况下也能用 `serial.log` 验证。

配套组件全是自己写的：

| 组件 | 文件 | 说明 |
|---|---|---|
| x86 汇编器 | `tools/x86asm.js` | 两遍扫描、局部标签作用域、逐行长度自检、ModRM 编码、段寄存器、`[si]/[di]/[bx]` 间接寻址 |
| x86 内核 | `src/x86/kmain.s` | 608 行汇编：控制台、滚屏、行编辑、命令分发、LMFS 读取、串口镜像 |
| 构建 | `tools/build-x86.js` | 汇编 → 打包 LMFS 卷 → El Torito 光盘 + 混合 MBR |

**内存映射**（整张映像加载于 `0x7C00`，必须小于 64 KiB，否则 BIOS 会跨越段边界出错）：

```
0x7C00 .. 0x8C00   内核代码与数据
0x8C00              LMFS 卷（超级块 + 目录表 64 项 + 文件数据）
```

**为什么要限制在 64 KiB 以内**：实模式 BIOS 读盘时按 `ES:BX` 递增缓冲区，跨 64 KiB
边界会被截断。第一版把文件系统放在 +64 KiB 处，`ls` 直接读到内核字符串——这就是那次
"乱码"的根因。

### 关于"在虚拟机里启动"

镜像带 El Torito 引导记录：`tools/x86boot.js` 里手工编码了一个 16 位实模式引导扇区
（`cld / sti / int 10h 设模式 / 直接写 0xB800 显存`），BIOS 会把光盘当启动盘读取，
显示一屏说明后停机。

**但系统本身跑不起来**——LUX-32 是自研指令集，与 x86 不兼容，PC 的 CPU 无法执行
`LUMEN.LMI` 里的机器码。这不是配置问题，任何 BIOS 设置都改不了。引导扇区的作用只是
把这件事讲清楚，而不是让 BIOS 静默滑到网络启动。

要真正运行系统：打开 `LUMENOS.HTM`，它内含一台完整的 LUX-32 整机。

在页面里直接敲键盘就能操作：

```
help            命令列表
ver             系统信息
ls              列出 LMFS 根目录
cat readme.txt  查看文件内容
calc            计算器（支持括号）
ps / mem        任务表 / 内存布局
date            从 RTC 读时间
write a.txt 你好   写文件
rm a.txt        删除文件
snake           贪吃蛇（方向键操作，ESC 退出）
reboot          重启
```

## 三、目录结构

```
lumen/
├─ tools/
│  ├─ vm.js        LUX-32 虚拟机（CPU + 设备，node 与浏览器共用）
│  ├─ asm.js       luxasm 汇编器 → 机器码 + 重定位表
│  ├─ cc.js        lcc 编译器 → LUX-32 汇编
│  └─ build.js     构建：.lc → .s → .lmx → LMFS → lumen.lmi → LumenOS.html
├─ src/
│  ├─ boot/boot.ls        512 字节引导扇区
│  ├─ kernel/kstart.ls    内核入口、中断存根、上下文切换
│  ├─ kernel/kernel.lc    内核主体
│  ├─ lib/lib.ls          系统调用胶水（__sys）
│  ├─ lib/lib.lc          用户库：字符串 / printf / 系统调用封装
│  └─ user/*.lc           lsh、ls、cat、calc、ps、mem、date、hello、write、rm、snake
├─ web/                   终端前端（CRT 渲染 + 监视面板）
└─ dist/                  构建产物
```

## 四、关键设计

**内存布局**

```
0x00000000  IVT（256 项中断向量）
0x00007C00  引导扇区
0x000B8000  文本显存（80×25，每单元 8 字节：码点 u32 + 属性 u32）
0x00100000  内核映像
0x001F0000  内核栈
0x00400000  用户程序槽位（12 × 256 KiB）
```

**中断**：`0x20` 定时器（100 Hz）、`0x21` 键盘、`0x80` 系统调用。
**调度**：时间片抢占（定时器）+ 协作让出（yield/sleep/wait），每个任务独立栈，
上下文切换在中断存根里完成，内核临界区用 `kern_busy` 保护。

**调用约定**：参数从右往左压栈，返回值在 `r0`，`r10` 是帧指针，`r11` 是栈指针。

**文本**：显存存的是 32 位码点，控制台自带 UTF-8 解码与宽字符（中文占两格）处理，
所以内核和用户程序里都可以直接写中文。

## 五、自测

```
node tests/t2.js     编译器：递归 / 循环 / 数组 / 字符串
node tests/run.js    开机并打印屏幕
node tests/cmd3.js   依次执行 cat / date / mem / ps / hello
node tests/ui.js     用桩 DOM 跑真实前端渲染逻辑（含监视面板）
```
