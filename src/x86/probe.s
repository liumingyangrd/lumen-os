; Lumen OS · BIOS 能力探针 v5
;
; 只针对 0x9F，测 INT 13h AH=42h 的几种组合：
;   LBA=0 count=1 / LBA=64 count=1 / LBA=96 count=1 / LBA=96 count=44
; 每次打印状态码和缓冲区首字节。

org 0x7C00

start:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7C00
    sti

    call ser_init
    mov si, msg0
    call vputs

    ; 先把 0x2000 填成 0xCC，方便看数据有没有落到那儿
    mov si, 0x2000
    mov cx, 32
    mov al, 0xCC
.fill:
    push cx
    mov [si], al
    inc si
    pop cx
    loop .fill

    mov ax, 64
    mov [lba], ax
    mov ax, 1
    mov [cnt], ax
    mov ax, 0x8000
    mov [buf], ax

    ; V1: 段数 0，缓冲 0x8000
    mov ax, 0
    mov [segcnt], ax
    call trial
    ; V2: 段数 1
    mov ax, 1
    mov [segcnt], ax
    call trial
    ; V3: 段数 0xFFFF
    mov ax, 0xFFFF
    mov [segcnt], ax
    call trial
    ; V4: 段数 0，缓冲 0x2000
    mov ax, 0
    mov [segcnt], ax
    mov ax, 0x2000
    mov [buf], ax
    call trial

    mov al, 10
    call vputc
    mov si, msg1
    call vputs
halt:
    hlt
    jmp halt

; ---------- 读一次并报告 ----------
; 参数：lba / cnt / segcnt / buf
trial:
    push ax
    push bx
    push cx
    push dx
    push si

    mov al, '['
    call vputc
    mov al, [segcnt]
    call vhex
    mov al, ']'
    call vputc

    ; 填 DAP
    mov si, dap
    mov ax, [lba]
    mov [dap_lba], ax
    mov ax, [cnt]
    mov [dap_cnt], ax
    mov ax, [segcnt]
    mov [dap_segcnt], ax
    mov ax, [buf]
    mov [dap_buf], ax

    mov bx, 0x8000
    mov dl, 0x9F
    mov ah, 0x42
    int 0x13
    mov al, 0
    jnc .ok
    mov al, 1
.ok:
    mov [cf], al
    mov [st], ah

    mov al, [st]
    call vhex
    mov al, [cf]
    test al, al
    jz .ok2
    mov al, '!'
    call vputc
    jmp .d
.ok2:
    mov al, '='
    call vputc
.d:
    mov al, ' '
    call vputc

    ; 0x8000 与 0x2000 各看 4 字节
    mov ax, 0x8000
    mov [daddr], ax
    call dump4
    mov ax, 0x2000
    mov [daddr], ax
    call dump4
    mov al, 10
    call vputc

    pop si
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; ---------- 打印 daddr 起的 4 字节 ----------
dump4:
    push ax
    push cx
    push si
    mov si, [daddr]
    mov cx, 4
.l:
    push cx
    mov al, [si]
    call vhex
    mov al, ' '
    call vputc
    inc si
    pop cx
    loop .l
    pop si
    pop cx
    pop ax
    ret

; ---------- 串口初始化 ----------
ser_init:
    push ax
    push dx
    mov dx, 0x3FB
    mov al, 0x80
    out dx, al
    mov dx, 0x3F8
    mov al, 1
    out dx, al
    mov dx, 0x3F9
    mov al, 0
    out dx, al
    mov dx, 0x3FB
    mov al, 3
    out dx, al
    pop dx
    pop ax
    ret

; ---------- 屏幕 + 串口输出 ----------
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
    push ax
    push cx
    mov ah, al
    mov cx, 3000
.w:
    mov dx, 0x3FD
    in al, dx
    test al, 0x20
    jnz .tx
    loop .w
.tx:
    mov dx, 0x3F8
    mov al, ah
    out dx, al
    pop cx
    pop ax
    pop dx
    pop cx
    pop bx
    pop ax
    ret

vhex:
    push ax
    push bx
    mov bl, al
    mov al, bl
    shr al
    shr al
    shr al
    shr al
    call vnib
    mov al, bl
    and al, 0x0F
    call vnib
    pop bx
    pop ax
    ret

vnib:
    push ax
    cmp al, 10
    jb .d
    add al, 87
    jmp .o
.d:
    add al, 48
.o:
    call vputc
    pop ax
    ret

; ---------- 数据 ----------
cf:   db 0
st:   db 0
lba:  dw 0
cnt:  dw 0
segcnt: dw 0
buf:   dw 0
daddr: dw 0
dap:
    db 0x10
    db 0x00
dap_segcnt:
    dw 0x0000
dap_buf:
    dw 0x8000
    dw 0x0000
dap_lba:
    dq 0
dap_cnt:
    dw 1

msg0: db "LUMEN BIOS probe v5", 13, 10, 0
msg1: db "== done ==", 13, 10, 0
