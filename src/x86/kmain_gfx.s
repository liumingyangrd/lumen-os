; Lumen OS · x86 原生内核（16 位实模式）
; 同一套项目、同样的系统语义，换一个架构：x86 机器码由真 CPU 直接执行。
;
; 显示：VGA 模式 0x12（640x480，16 色，四平面显存），自绘点阵字形。
;   ASCII 8x16 居中放进 16x16 格，汉字 16x16 —— 40 列 x 30 行。
;   字库是构建时按源码实际用字生成的子集（tools/fontgen.py）。
;
; 引导映像布局（加载于 0x7C00，整张须 < 64 KiB，否则 BIOS 跨段出错）：
;   0x7C00  内核
;   0x8C00  头：fsBase cjkCount cjkTable cjkData asciiData（各 u16）
;   0x8C0C  字库
;   之后    LMFS 卷

org 0x7C00

HDR     equ 0x8C00

start:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7C00
    sti

    mov ax, 0x12            ; 640x480x16
    int 0x10

    mov si, HDR
    mov ax, [si]
    mov [fsbase], ax
    add si, 2
    mov ax, [si]
    mov [cjkcnt], ax
    add si, 2
    mov ax, [si]
    mov [cjkmap], ax
    add si, 2
    mov ax, [si]
    mov [cjkgly], ax
    add si, 2
    mov ax, [si]
    mov [ascg], ax

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
    cmp al, 0x80
    jae readkey
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

h_ls:
    mov si, [fsbase]
    add si, 1024
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
    mov di, [fsbase]
    add di, 1024
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
    add bx, [fsbase]
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

; ---------- 字符串比较 ----------
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
    push es
    call maskall            ; 四个平面全开
    mov ax, 0xA000
    mov es, ax
    xor di, di
    mov cx, 38400
    xor ax, ax
.cl:
    mov [di], al
    inc di
    loop .cl
    pop es
    xor ax, ax
    mov [crow], ax
    mov [ccol], ax
    mov al, 0
    mov [u8len], al
    call cursor_on
    pop di
    pop cx
    pop ax
    ret

; ---------- 输出一个字节（UTF-8 状态机） ----------
putc:
    push ax
    push bx
    push cx
    push dx
    push si
    push di
    push es

    call sc                 ; 串口镜像（原始字节）

    mov bl, al
    mov al, [u8len]
    test al, al
    jz .fresh
    ; 续字节
    mov al, bl
    and al, 0x3F
    mov ah, [ucp+1]
    mov al, [ucp]
    mov bh, ah
    shl bx, 1               ; 无 32 位移位，改用两次 16 位
    jmp .acc2
.fresh:
    mov al, bl
    cmp al, 0x20
    jb .ctrl
    cmp al, 0x80
    jae .multi
    mov [ucp], al
    mov byte [u8len], 0
    mov ax, [ucp]
    call draw_char
    jmp .adv
.multi:
    cmp al, 0xE0
    jae .three
    ; 双字节（本字库不含，按缺字处理）
    mov byte [u8len], 1
    and al, 0x1F
    mov [ucp], al
    jmp .done
.three:
    mov byte [u8len], 2
    and al, 0x0F
    mov [ucp], al
    jmp .done
.acc2:
.done:
.adv:
    call cursor_off
    mov ax, [ccol]
    inc ax
    mov [ccol], ax
    cmp ax, 40
    jb .ok
    call newline
    jmp .ok2
.ok:
    call cursor_on
.ok2:
    pop es
    pop di
    pop si
    pop dx
    pop cx
    pop bx
    pop ax
    ret

.ctrl:
    cmp al, 13
    je .cr
    cmp al, 10
    je .nl
    cmp al, 8
    je .bs
    jmp .done
.cr:
    call newline
    jmp .done
.nl:
    call newline
    jmp .done
.bs:
    mov byte [u8len], 0
    jmp .done
