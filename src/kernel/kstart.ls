; ============================================================
;  Lumen 内核入口 · 中断存根 · 上下文切换 · 端口助手
;  内核装入地址: 0x100000
; ============================================================
.org 0x100000
.entry start
.global start

; ---- 保存/恢复全部通用寄存器 ----
; 栈帧(自 sp 向上): r10 r9 r8 r7 r6 r5 r4 r3 r2 r1 r0 flags pc
.macro pushall
  push r0
  push r1
  push r2
  push r3
  push r4
  push r5
  push r6
  push r7
  push r8
  push r9
  push r10
.endmacro

.macro popall
  pop r10
  pop r9
  pop r8
  pop r7
  pop r6
  pop r5
  pop r4
  pop r3
  pop r2
  pop r1
  pop r0
.endmacro

; ------------------------------------------------------------
start:
  di
  ldi sp, 0x1F0000

  ldi r1, 0x100            ; IVT[0x20] = 定时器
  ldi r2, timer_isr
  st [r1+0], r2

  ldi r1, 0x108            ; IVT[0x21] = 键盘
  ldi r2, kbd_isr
  st [r1+0], r2

  ldi r1, 0x400            ; IVT[0x80] = 系统调用
  ldi r2, sys_isr
  st [r1+0], r2

  call kmain

.Lhang:
  hlt
  jmpi .Lhang

; ------------------------------------------------------------
; 定时器中断: 累加滴答, 时间片到期则抢占切换
timer_isr:
  pushall
  ldi r1, 0x20
  out 0x20, r1
  call timer_tick
  ldi r1, sched_req
  ld r2, [r1+0]
  ldi r3, 0
  cmp r2, r3
  jz .Lt_no
  st [r1+0], r3
  push r11
  call sched_switch
  addi sp, sp, 4
  mov r11, r0
.Lt_no:
  popall
  iret

; ------------------------------------------------------------
; 键盘中断: 读扫描码交给内核队列
kbd_isr:
  pushall
.Lk_loop:
  ldi r1, 0x64
  inr r2, r1
  ldi r3, 0
  cmp r2, r3
  jz .Lk_done
  ldi r1, 0x60
  inr r0, r1
  push r0
  call kbd_irq
  addi sp, sp, 4
  jmpi .Lk_loop
.Lk_done:
  ldi r1, 0x20
  out 0x20, r1
  popall
  iret

; ------------------------------------------------------------
; 系统调用入口
; 注意: r0..r4 是系统调用参数, 只能用 r7-r9 做临时寄存器
sys_isr:
  pushall
  ldi r8, kern_busy
  ldi r9, 1
  st [r8+0], r9

  push r4
  push r3
  push r2
  push r1
  push r0
  call sys_dispatch
  addi sp, sp, 20

  st [sp+40], r0           ; 返回值写回保存的 r0 槽

  ldi r8, kern_busy
  ldi r9, 0
  st [r8+0], r9

  ldi r8, sched_req
  ld r9, [r8+0]
  ldi r7, 0
  cmp r9, r7
  jz .Ls_no
  st [r8+0], r7
  push r11
  call sched_switch
  addi sp, sp, 4
  mov r11, r0
.Ls_no:
  popall
  iret

; ------------------------------------------------------------
; 切入某个任务的初始上下文 (不返回)
.global jump_to_task
jump_to_task:
  di
  push fp
  mov fp, sp
  addi r1, fp, 8
  ld r11, [r1+0]
  popall
  iret

; ------------------------------------------------------------
; 空闲任务
.global idle_task
idle_task:
  hlt
  jmpi idle_task

.global get_idle_entry
get_idle_entry:
  ldi r0, idle_task
  ret

; ------------------------------------------------------------
; 端口 I/O 与杂项助手
.global inb
inb:
  push fp
  mov fp, sp
  addi r1, fp, 8
  ld r1, [r1+0]
  inr r0, r1
  mov sp, fp
  pop fp
  ret

.global outb
outb:
  push fp
  mov fp, sp
  addi r1, fp, 8
  ld r2, [r1+0]
  addi r1, fp, 12
  ld r3, [r1+0]
  outr r2, r3
  mov sp, fp
  pop fp
  ret

.global cpu_hlt
cpu_hlt:
  hlt
  ret

.global cpu_reboot
cpu_reboot:
  di
  ldi r0, 0x7C00
  jr r0

.global cpu_irq_on
cpu_irq_on:
  ei
  ret

.global cpu_irq_off
cpu_irq_off:
  di
  ret
