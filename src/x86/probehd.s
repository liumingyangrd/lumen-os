; Lumen OS · 硬盘仿真引导探针
;
; El Torito 介质类型 0x04（硬盘仿真）：整张引导映像被当成一块硬盘，
; 引导映像的第 0 扇区被读进 0x7C00，DL = 0x80。
; 映像的第 1 扇区开始是 payload（魔数 'LMN1'）。
; 这里测试：能不能用 INT 13h AH=42h 把 payload 读上来。

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

    ; 初始 DL
    mov al, 'D'
    call vputc
    mov al, 'L'
    call vputc
    mov al, '='
    call vputc
    mov al, dl
    call vhex
    mov al, ' '
    call vputc

    ; AH=42h 读 LBA 1 起 44 个扇区到 0000:8000
    mov si, dap
    mov bx, 0x8000
    mov dl, 0x80
    mov ah, 0x42
    int 0x13
    mov al, 0
    jnc .ok
    mov al, 1
.ok:
    mov [cf], al
    mov [st], ah

    mov al, 'R'
    call vputc
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

    ; 0x8000 与 0x8800 各看 8 字节
    call dump8
    call dump8b
    mov al, 10
    call vputc

    mov si, msg1
    call vputs
halt:
    hlt
    jmp halt

; ---------- 打印 0x8000 起 8 字节 ----------
dump8:
    push ax
    push cx
    push si
    mov al, '['
    call vputc
    mov si, 0x8000
    call dumploop
    mov al, ']'
    call vputc
    pop si
    pop cx
    pop ax
    ret

; ---------- 打印 0x8800 起 8 字节 ----------
dump8b:
    push ax
    push cx
    push si
    mov al, '<'
    call vputc
    mov si, 0x8800
    call dumploop
    mov al, '>'
    call vputc
    pop si
    pop cx
    pop ax
    ret

dumploop:
    mov cx, 8
.l:
    push cx
    mov al, [si]
    call vhex
    mov al, ' '
    call vputc
    inc si
    pop cx
    loop .l
    ret

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

cf:   db 0
st:   db 0
dap:
    db 0x10
    db 0x00
    dw 0x0000
    dw 0x8000
    dw 0x0000
    dq 1
    dw 44

msg0: db "LUMEN harddisk-emul probe", 13, 10, 0
msg1: db "== done ==", 13, 10, 0
