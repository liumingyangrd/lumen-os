; Lumen OS · 第一阶段引导扇区（stage1）
;
; 职责：把真正的内核从引导介质读上来，放到固定地址 0x8000，然后跳过去。
;
; 为什么需要两阶段：El Torito 无仿真引导时 BIOS 只把引导映像的第一个扇区
; 读进内存，后面二十多 KB 的内核根本没加载。两阶段引导是标准做法。
;
; 本文件同时是两种介质的引导扇区：
;   光盘：El Torito 硬盘仿真（介质类型 0x04），BIOS 把映像当硬盘，DL=0x80
;   U 盘：dd 出来的磁盘映像第 0 扇区就是本文件，DL=0x80
;
; 读盘用 INT 13h AH=42h（LBA 扩展读）。不同 BIOS 的 LBA 基准可能差一格，
; 所以读完不直接用，而是扫描缓冲区找魔数 'LMN1'，再按头部里的长度
; 把内核搬到 0x8000。这样不管 BIOS 怎么映射都能对上。
;
; 内存布局：
;   0x7C00   本引导扇区
;   0x8000   读盘缓冲区 → 内核最终也放在这里
;
; 本扇区同时是合法的 MBR（末尾有分区表和 0x55AA），dd 到 U 盘即可启动。

org 0x7C00

KERNEL_ENTRY = 0x8000
SCRATCH = 0x8000

start:
    cli
    cld
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7C00
    sti

    ; ---------- 读盘到 0x8000 ----------
    mov si, dap
    mov bx, SCRATCH
    mov ax, PAYLOAD_SECTORS
    mov [dap_cnt], ax
    mov ax, 1
    mov [dap_lba], ax
    mov dl, 0x80
    mov ah, 0x42
    int 0x13
    jc .readfail
    cmp ah, 0
    jne .readfail

    ; ---------- 扫描 'LMN1' ----------
    mov si, SCRATCH
    mov cx, PAYLOAD_SECTORS * 512
.scan:
    push cx
    mov al, [si]
    cmp al, 'L'
    jne .nx
    mov al, [si+1]
    cmp al, 'M'
    jne .nx
    mov al, [si+2]
    cmp al, 'N'
    jne .nx
    mov al, [si+3]
    cmp al, '1'
    jne .nx
    pop cx
    jmp .found
.nx:
    inc si
    pop cx
    loop .scan
    jmp .notfound

    ; ---------- 找到：按头部长度搬到 0x8000 ----------
    ; 头部：+0 'LMN1'  +4 内核长度（4 字节，小端）  +8 内核开始
.found:
    mov ax, [si+4]
    mov [klen], ax
    mov ax, [si+6]
    mov [klen+2], ax
    add si, 8
    mov di, KERNEL_ENTRY
    mov cx, [klen]
    cld
    rep movsb
    jmp KERNEL_ENTRY           ; 交给内核

.readfail:
    mov si, msg_rd
    call vputs
.halt:
    hlt
    jmp .halt

.notfound:
    mov si, msg_nf
    call vputs
    jmp .halt

; ---------- 屏幕（VGA 文本，只在出错时用得上）----------
vputs:
    push ax
    push si
.l:
    mov al, [si]
    test al, al
    jz .d
    call vputc
    inc si
    jmp .l
.d:
    pop si
    pop ax
    ret

vputc:
    push ax
    push bx
    push cx
    push dx
    mov ah, 0x0E
    mov bh, 0x00
    int 0x10
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; ---------- 磁盘地址包（DAP）----------
;   +0 结构长度 0x10 / +1 保留 / +2 段数 / +4 偏移 / +6 段
;   +8 起始 LBA（8 字节）/ +16 扇区数
dap:
    db 0x10
    db 0x00
    dw 0x0000
    dw SCRATCH
    dw 0x0000
dap_lba:
    dq 0
dap_cnt:
    dw PAYLOAD_SECTORS

klen: dw 0
      dw 0

msg_rd: db "Lumen: disk read failed", 13, 10, 0
msg_nf: db "Lumen: payload magic not found", 13, 10, 0

; 下面这些会被构建脚本替换
PAYLOAD_SECTORS = 48
