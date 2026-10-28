; Lumen OS · x86 原生内核（16 位实模式）
; 同一套项目、同样的系统语义，换一个架构：x86 机器码由真 CPU 直接执行。
; 文件系统 LMFS 随引导映像一起载入（相当于 initrd），不依赖磁盘驱动。
;
; 汇编: tools/x86asm.js     打包: tools/build-x86.js
;
; 内存布局（加载于 0x7C00）：
;   0x7C00 + [0, 4K)    内核代码与数据
;   0x8C00              LMFS 映像

org 0x7C00

start:
    cli
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7C00
    sti

    mov ax, 3
    int 0x10

    call com_init
    call clear
    mov si, banner
    call puts

shell:
    mov si, prompt
    call puts

    mov di, linebuf
    mov cx, 0

readkey:
    xor ah, ah
    int 0x16
    cmp al, 13
    je exec
    cmp al, 8
    je bksp
    test al, al
    jz readkey
    cmp cx, 60
    jae readkey
    mov bl, al
    call putc
    mov [di], bl
    inc di
    inc cx
    jmp readkey

bksp:
    test cx, cx
    jz readkey
    dec di
    dec cx
    mov al, 8
    call putc
    mov al, ' '
    call putc
    mov al, 8
    call putc
    jmp readkey

exec:
    mov al, 13
    call putc
    mov al, 10
    call putc
    xor ax, ax
    mov [di], al
    call runcmd
    jmp shell

; ---------- 命令分发 ----------
runcmd:
    mov di, c_help
    call streq
    jz h_help
    mov di, c_ver
    call streq
    jz h_ver
    mov di, c_clear
    call streq
    jz h_clear
    mov di, c_ls
    call streq
    jz h_ls
    mov di, c_reboot
    call streq
    jz h_reboot

    call try_cat
    jz .out

    mov si, msg_nf
    call puts
    mov si, linebuf
    call puts
    mov si, msg_nf2
    call puts
.out:
    ret

h_help:
    mov si, txt_help
    call puts
    ret

h_ver:
    mov si, txt_ver
    call puts
    ret

h_clear:
    call clear
    ret

h_reboot:
    mov si, txt_reboot
    call puts
    mov ax, 0
    int 0x19
    ret

; ---------- ls：列出根目录 ----------
h_ls:
    mov si, 0x9000
    mov cx, 64
.l:
    mov al, [si]
    test al, al
    jz .n
    call puts
    mov al, ' '
    call putc
    mov ax, si
    add ax, 44
    mov bx, ax
    mov ax, [bx]
    call putdec
    mov al, 13
    call putc
    mov al, 10
    call putc
.n:
    add si, 64
    loop .l
    ret

; ---------- cat <文件> ----------
try_cat:
    mov si, linebuf
    mov al, [si]
    cmp al, 'c'
    jne .no
    inc si
    mov al, [si]
    cmp al, 'a'
    jne .no
    inc si
    mov al, [si]
    cmp al, 't'
    jne .no
    inc si
    mov al, [si]
    cmp al, ' '
    jne .no
    call do_cat
    xor al, al
    ret
.no:
    or al, 1
    ret

do_cat:
    mov si, linebuf
    add si, 4
.s:
    mov al, [si]
    cmp al, ' '
    jne .n
    inc si
    jmp .s
.n:
    mov [namep], si
    mov di, 0x9000
    mov cx, 64
.e:
    mov al, [di]
    test al, al
    jz .next
    mov si, [namep]
    call strcmpz
    jz .found
.next:
    add di, 64
    loop .e
    mov si, msg_nofile
    call puts
    ret
.found:
    mov si, di
    add si, 44
    mov cx, [si]
    mov si, di
    add si, 40
    mov ax, [si]
    mov bx, ax
    push cx
    mov cx, 9
.sh:
    shl bx
    loop .sh
    pop cx
    mov ax, 0x8C00
    add bx, ax
    mov si, bx
.p:
    test cx, cx
    jz .d
    mov al, [si]
    call putc
    inc si
    dec cx
    jmp .p
.d:
    ret

; ---------- streq：比较 linebuf（跳过前导空格）与 di ----------
streq:
    push ax
    push bx
    push si
    push di
    mov si, linebuf
.sk:
    mov al, [si]
    cmp al, ' '
    jne .c
    inc si
    jmp .sk
.c:
    mov al, [si]
    mov bl, [di]
    cmp al, bl
    jne .no
    test al, al
    jz .yes
    inc si
    inc di
    jmp .c
.no:
    pop di
    pop si
    pop bx
    pop ax
    or al, 1
    ret
.yes:
    pop di
    pop si
    pop bx
    pop ax
    xor al, al
    ret

; ---------- strcmpz：比较 si 与 di 两个 0 结尾串 ----------
strcmpz:
    push ax
    push bx
    push si
    push di
.a:
    mov al, [si]
    mov bl, [di]
    cmp al, bl
    jne .no
    test al, al
    jz .yes
    inc si
    inc di
    jmp .a
.no:
    pop di
    pop si
    pop bx
    pop ax
    or al, 1
    ret
.yes:
    pop di
    pop si
    pop bx
    pop ax
    xor al, al
    ret

; ---------- putdec：打印 ax 的十进制 ----------
putdec:
    push ax
    push bx
    push cx
    push dx
    mov bx, 10
    xor cx, cx
.d:
    xor dx, dx
    div bx
    push dx
    inc cx
    test ax, ax
    jnz .d
.p:
    pop ax
    add al, 48
    call putc
    loop .p
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; ---------- 清屏 ----------
clear:
    push ax
    push cx
    push di
    push ds
    mov ax, 0xB800
    mov ds, ax
    mov di, 0
    mov cx, 2000
.cl:
    mov al, ' '
    mov [di], al
    inc di
    mov al, 0x0A
    mov [di], al
    inc di
    loop .cl
    pop ds
    xor ax, ax
    mov [row], ax
    mov [col], ax
    pop di
    pop cx
    pop ax
    ret

; ---------- 输出一个字符 ----------
putc:
    push ax
    push bx
    push cx
    push dx
    push si
    push di
    push ds

    call sc

    cmp al, 10
    je .nl
    cmp al, 13
    je .cr

    mov bl, al
    mov ax, [row]
    mov si, ax
    mov cx, 7
.ax7:
    shl ax
    loop .ax7
    mov cx, 5
.bx5:
    shl si
    loop .bx5
    add ax, si
    mov cx, [col]
    add cx, cx
    add ax, cx
    mov di, ax

    mov ax, 0xB800
    mov ds, ax
    mov [di], bl
    inc di
    mov bl, 0x0A
    mov [di], bl
    pop ds

    mov ax, [col]
    inc ax
    mov [col], ax
    cmp ax, 80
    jb .done
    call newline
    jmp .done

.cr:
    pop ds
    call newline
    jmp .done
.nl:
    pop ds
    call newline
    jmp .done

.done:
    call showcursor
    pop di
    pop si
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; ---------- 换行 ----------
newline:
    push ax
    xor ax, ax
    mov [col], ax
    mov ax, [row]
    inc ax
    cmp ax, 25
    jb .ok
    call scroll
    mov ax, 24
.ok:
    mov [row], ax
    pop ax
    ret

; ---------- 滚屏 ----------
scroll:
    push ax
    push cx
    push si
    push di
    push ds
    push es
    mov ax, 0xB800
    mov ds, ax
    mov es, ax
    mov si, 160
    mov di, 0
    mov cx, 3840
    cld
    rep movsb
    mov di, 3840
    mov cx, 80
.l:
    mov al, ' '
    mov [di], al
    inc di
    mov al, 0x0A
    mov [di], al
    inc di
    loop .l
    pop es
    pop ds
    pop di
    pop si
    pop cx
    pop ax
    ret

; ---------- 输出字符串 ----------
puts:
    push ax
    push si
.p:
    mov al, [si]
    test al, al
    jz .d
    call putc
    inc si
    jmp .p
.d:
    pop si
    pop ax
    ret

; ---------- 硬件光标 ----------
showcursor:
    push ax
    push bx
    push dx
    mov ah, 2
    mov bh, 0
    mov dh, [row]
    mov dl, [col]
    int 0x10
    pop dx
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

; ---------- 数据 ----------
row:      dw 0
col:      dw 0
namep:    dw 0
linebuf:  db 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
          db 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
          db 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0

c_help:   db "help", 0
c_ver:    db "ver", 0
c_clear:  db "clear", 0
c_ls:     db "ls", 0
c_reboot: db "reboot", 0

prompt:   db "lumen-x86> ", 0
msg_nf:   db "unknown command: ", 0
msg_nf2:  db "  (try: help)", 13, 10, 0
msg_nofile: db "no such file", 13, 10, 0

banner:
    db 13, 10
    db "Lumen OS 1.0  ·  x86 native build", 13, 10
    db "==========================================", 13, 10
    db "arch    x86 16-bit real mode (no emulation)", 13, 10
    db "memory  640 KiB low, video 80x25 text", 13, 10
    db "fs      LMFS volume loaded with the boot image", 13, 10
    db "serial  COM1 115200 8N1 - every character mirrored", 13, 10
    db "note    the LUX-32 original lives in LUMENOS.HTM", 13, 10
    db 13, 10
    db "type help to list commands", 13, 10
    db 13, 10, 0

txt_help:
    db 13, 10
    db "  help     list commands", 13, 10
    db "  ver      version and architecture", 13, 10
    db "  ls       list files on the LMFS volume", 13, 10
    db "  cat FILE show a file", 13, 10
    db "  clear    clear the screen", 13, 10
    db "  reboot   restart the machine", 13, 10
    db 13, 10, 0

txt_ver:
    db 13, 10
    db "Lumen OS 1.0  (x86 build)", 13, 10
    db "  kernel    Lumen, x86 target", 13, 10
    db "  arch      x86 16-bit real mode", 13, 10
    db "  console   VGA text 80x25, direct framebuffer writes", 13, 10
    db "  storage   LMFS volume loaded with the boot image", 13, 10
    db "  input     BIOS keyboard, blocking read", 13, 10
    db "  debug     COM1 mirror at 115200 8N1", 13, 10
    db "  sibling   LUX-32 build, same project, custom ISA", 13, 10
    db 13, 10, 0

txt_reboot:
    db "rebooting...", 13, 10, 0
