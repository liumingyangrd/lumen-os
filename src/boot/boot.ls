; ============================================================
;  Lumen 引导扇区 (512 字节, 由固件装入 0x7C00)
;  任务: 从磁盘读入内核到 0x100000, 然后跳转
; ============================================================
.org 0x7C00
.entry start
.global start

start:
  di
  ldi sp, 0x7C00          ; 临时栈
  ldi r1, 0x100000        ; 装载目标
  ldi r2, 1               ; 起始 LBA
  ldi r3, ksec
  ld r3, [r3+0]           ; 内核扇区数 (构建时写入)
  ldi r8, 0
  cmp r3, r8
  jle .Lgo

.Lsector:
  ldi r5, 0x1F1
  outr r5, r2
  ldi r5, 0x1F2
  ldi r6, 1
  outr r5, r6             ; 命令: 读一个扇区
  ldi r5, 0
.Lcopy:
  ldi r7, 0x1F4
  inr r6, r7
  stb [r1+0], r6
  addi r1, r1, 1
  addi r5, r5, 1
  ldi r7, 512
  cmp r5, r7
  jl .Lcopy
  addi r2, r2, 1
  addi r3, r3, -1
  ldi r7, 0
  cmp r3, r7
  jg .Lsector

.Lgo:
  ldi r6, 0x100000
  jr r6

ksec:
  .word 0                 ; ← build 时回填真实扇区数

.org 0x7DFE
  .byte 0x55, 0xAA
