; 最小图形内核：只做"切模式 → 读字库 → 画一个字符"，
; 用来逐步定位崩溃点。

org 0x7C00

HDR_ADDR = 0x8C00

start:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7C00
    sti

    call com_init
    mov si, msg_a
    call scstr

    ; 1) 切到 13h
    mov ax, 0x0013
    int 0x10
    mov si, msg_b
    call scstr

    ; 2) 读字库头（编在内核里，地址是相对内核的偏移）
    mov si, fonthead
    mov ax, [si+0]
    mov [ascicount], ax
    mov ax, [si+2]
    mov [cjkcount], ax
    mov ax, [si+4]
    add ax, 0x7C00
    mov [ascigly], ax
    mov ax, [si+6]
    add ax, 0x7C00
    mov [cjkmap], ax
    mov ax, [si+8]
    add ax, 0x7C00
    mov [cjkgly], ax
    mov si, msg_c
    call scstr

    ; 3) 整屏填成青色（验证显示通路）
    mov ax, 0xA000
    mov es, ax
    xor di, di
    mov cx, 0xFA00
    mov al, 9
    cld
    rep stosb
    mov si, msg_d
    call scstr

    ; 4) 在 (0,0) 画一个 'A'
    mov al, 0x41
    call draw_char
    mov si, msg_e
    call scstr

    ; 4.5) 探测 BIOS 实际加载了多少字节：
    ;      从 0x7C00 起每 256 字节找一次标记 'LMN0'
    mov si, 0x7C00
    mov cx, 0x40           ; 扫 64 KB
.scan:
    push cx
    mov al, [si]
    cmp al, 0x4C
    jne .nx
    mov al, [si+1]
    cmp al, 0x4D
    jne .nx
    mov al, [si+2]
    cmp al, 0x4E
    jne .nx
    mov al, [si+3]
    cmp al, 0x30
    jne .nx
    mov si, msg_m
    call scstr
    push si
    call hex16
    pop si
    call scnl
    jmp .scanend
.nx:
    add si, 0x100
    pop cx
    loop .scan
.scanend:

    ; 5) 读回显存前 8 字节 + 字模首字节 + fgcol
    mov ax, 0xA000
    mov es, ax
    xor di, di
    mov cx, 8
.rd:
    push cx
    mov al, [di]
    call hex8
    mov al, ' '
    call sc
    inc di
    pop cx
    loop .rd
    call scnl
    mov si, msg_f
    call scstr
    ; 打印 ascigly 的地址与首字节
    mov si, [ascigly]
    call hex16
    mov al, ' '
    call sc
    mov al, [si]
    call hex8
    mov al, ' '
    call sc
    ; 打印 fgcol 的地址与值
    mov si, msg_g
    call scstr
    mov si, FGCOL_ADDR
    call hex16
    mov al, ' '
    call sc
    mov al, [si]
    call hex8
    call scnl

    mov si, msg_end
    call scstr
halt:
    jmp halt

; ---------- 画一个 ASCII 字符到 (0,0)，8x16 ----------
; AL = 码点
draw_char:
    push ax
    push bx
    push cx
    push dx
    push si
    push di
    push es

    ; 字模地址 = ascigly + (码点 - 0x20) * 16
    mov si, [ascigly]
    sub al, 0x20
    mov ah, 0
    mov bx, 16
    mul bx
    add si, ax

    ; 目标 = 0xA000:0000
    mov ax, 0xA000
    mov es, ax
    xor di, di

    mov cx, 16
.dr:
    push cx
    mov al, [si]
    call draw_row8
    inc si
    add di, LINE_BYTES
    pop cx
    loop .dr

    pop es
    pop di
    pop si
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; ---------- 画一行 8 像素 ----------
; AL = 位图, DI = 显存偏移
draw_row8:
    push ax
    push bx
    push cx
    push dx
    push si
    push di
    push es

    mov ax, 0xA000
    mov es, ax
    mov bx, 0x80           ; 位掩码
    mov cx, 8
.bl:
    push cx
    push ax
    test al, bl
    jz .bg
    pop ax
    mov dl, [fgcol]
    mov [es:di], dl
    jmp .nx
.bg:
    pop ax
    mov dl, [bgcol]
    mov [es:di], dl
.nx:
    inc di
    shl al, 1
    shl bx, 1
    pop cx
    loop .bl

    pop es
    pop di
    pop si
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; ---------- 串口 ----------
com_init:
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
    mov dx, 0x3FA
    mov al, 0xC7
    out dx, al
    mov dx, 0x3F9
    mov al, 0
    out dx, al
    pop dx
    pop ax
    ret

sc:
    push ax
    push dx
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
    pop dx
    pop ax
    ret

scstr:
    push ax
    push si
.l:
    mov al, [si]
    test al, al
    jz .d
    call sc
    inc si
    jmp .l
.d:
    pop si
    pop ax
    ret

scnl:
    mov al, 10
    call sc
    ret

; AL → 两个十六进制字符（纯串口，不嵌套）
hex8:
    push ax
    push bx
    mov bl, al
    mov al, bl
    shr al
    shr al
    shr al
    shr al
    call hexnib
    mov al, bl
    and al, 0x0F
    call hexnib
    pop bx
    pop ax
    ret

; AX → 四个十六进制字符
hex16:
    push ax
    push bx
    mov bx, ax
    mov al, bh
    call hex8
    mov al, bl
    call hex8
    pop bx
    pop ax
    ret

hexnib:
    push ax
    cmp al, 10
    jb .d
    add al, 87
    jmp .o
.d:
    add al, 48
.o:
    call sc
    pop ax
    ret

LINE_BYTES = 320
ascicount: dw 0
ascigly:   dw 0
fgcol:     db 8
bgcol:     db 0

msg_a:   db "[1 mode]", 0
msg_b:   db "[2 hdr]", 0
msg_c:   db "[3 fill]", 0
msg_d:   db "[4 draw]", 0
msg_e:   db "[5 read]", 0
msg_f:   db "[ascigly addr glyph0]", 0
msg_m:   db "[marker at]", 0
msg_g:   db "[fgcol addr val]", 0
FGCOL_ADDR = 0
msg_end: db "== done ==", 13, 10, 0
