; ============================================================
;  Lumen 用户库 · 系统调用胶水 (汇编部分)
;  __sys(nr, a, b, c, d) -> int
; ============================================================

.global __sys
__sys:
  push fp
  mov fp, sp
  addi r9, fp, 8
  ld r0, [r9+0]
  ld r1, [r9+4]
  ld r2, [r9+8]
  ld r3, [r9+12]
  ld r4, [r9+16]
  sys
  mov sp, fp
  pop fp
  ret
