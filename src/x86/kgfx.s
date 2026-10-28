; Lumen OS · 图形内核
;
; 显示：VGA 模式 13h，320x200，256 色，线性帧缓冲 A000:0000
; 字体：ASCII 8x16（半角）+ 汉字 16x16（全角），点阵字库由 tools/fontgen.py
;       从本文件的 db 字符串里自动提取生成
; 布局：标题栏 + 窗口 + 状态栏，像一个刚开机的小桌面
;
; 全部手写机器码：没有第三方内核、引导程序、编译器或图形库。

org 0x8000

; ---------- 屏幕与布局常量 ----------
SCRW = 320
SCRH = 200

WIN_X = 10
WIN_Y = 24
WIN_W = 300
WIN_H = 144
STATUS_Y = 180

; ---------- 调色板 ----------
C_BLACK = 0
C_NAVY = 1
C_RED = 4
C_GRAY = 7
C_DKGRAY = 8
C_LCYAN = 11
C_YELLOW = 14
C_WHITE = 15

start:
    cli
    cld                    ; BIOS 退出时 DF 可能是 1，rep 指令会倒着写
    xor ax, ax
    mov ds, ax
    mov es, ax
    mov ss, ax
    mov sp, 0x7000
    sti

    call com_init
    call load_font
    call vga_init
    call draw_desktop
    call draw_title
    call draw_window
    call draw_status

    mov si, msg_boot
    call sc_puts

main_loop:
    call draw_clock
    hlt
    jmp main_loop

; ================================================================
;  显示初始化
; ================================================================

; 切到 13h 模式并调整几个关键颜色
vga_init:
    mov ax, 0x0013
    int 0x10

    ; 桌面深蓝 (R=16 G=24 B=60)
    mov bl, 0x00
    mov bh, C_NAVY
    mov ch, 24
    mov cl, 60
    mov dh, 0
    mov dl, 16
    call setpal

    ; 浅灰 (R=200 G=200 B=210)
    mov bl, 0x00
    mov bh, C_GRAY
    mov ch, 200
    mov cl, 210
    mov dh, 0
    mov dl, 200
    call setpal

    ; 纯白 (R=235 G=235 B=245)
    mov bl, 0x00
    mov bh, C_WHITE
    mov ch, 235
    mov cl, 245
    mov dh, 0
    mov dl, 235
    call setpal

    ; 淡青 (R=80 G=230 B=230)
    mov bl, 0x00
    mov bh, C_LCYAN
    mov ch, 230
    mov cl, 230
    mov dh, 0
    mov dl, 80
    call setpal

    ; 黄 (R=235 G=210 B=70)
    mov bl, 0x00
    mov bh, C_YELLOW
    mov ch, 210
    mov cl, 70
    mov dh, 0
    mov dl, 235
    call setpal
    ret

; 设置一个调色板项：BH=颜色号 CH=绿 CL=蓝 DH=品红 DL=红 BL=属性
setpal:
    push ax
    push bx
    push cx
    push dx
    mov ax, 0x1000
    int 0x10
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; ================================================================
;  字库
; ================================================================
; fonthead 结构（偏移相对 fonthead）：
;   +0 ASCII 字形数   +2 汉字字形数   +4 ASCII 区偏移
;   +6 码点表偏移     +8 汉字字模偏移
load_font:
    mov bx, fonthead
    mov ax, [bx+0]
    mov [ascicount], ax
    mov ax, [bx+2]
    mov [cjkcount], ax
    mov ax, [bx+4]
    add ax, bx
    mov [ascigly], ax
    mov ax, [bx+6]
    add ax, bx
    mov [cjkmap], ax
    mov ax, [bx+8]
    add ax, bx
    mov [cjkgly], ax
    ret

; ================================================================
;  背景与窗口
; ================================================================

; 垂直渐变：用 VGA 的 6x6x6 立方体，颜色索引 16+36r+6g+b 递减即平滑过渡
draw_desktop:
    mov ax, 0xA000
    mov es, ax
    xor di, di
    mov cx, SCRH
    mov ax, 69              ; 16+36*1+6*2+5
    mov bx, 4
.rows:
    push cx
    push ax
    push bx
    mov ah, 0
    mov cx, SCRW
    rep stosb
    pop bx
    pop ax
    dec bx
    jnz .keep
    mov bx, 4
    dec ax
.keep:
    pop cx
    loop .rows
    ret

; 标题栏：整条深蓝 + 下边一条亮线
draw_title:
    mov ax, 0xA000
    mov es, ax
    xor di, di
    mov al, C_NAVY
    mov cx, SCRW
    mov dx, 15
    call fill_rect

    mov di, SCRW * 15
    mov al, C_LCYAN
    mov cx, SCRW
    mov dx, 1
    call fill_rect

    mov word [curx], 8
    mov word [cury], 0
    mov byte [fgcol], C_WHITE
    mov byte [bgcol], C_NAVY
    mov si, msg_title
    call draw_text
    ret

; 窗口：黑底 + 立体边框
draw_window:
    mov ax, 0xA000
    mov es, ax

    ; 窗口内部
    mov di, WIN_Y * SCRW + WIN_X + 2
    mov al, C_BLACK
    mov cx, WIN_W - 4
    mov dx, WIN_H - 4
    call fill_rect

    ; 边框（外浅内深，做出凸起的感觉）
    mov di, WIN_Y * SCRW + WIN_X
    mov al, C_GRAY
    mov cx, WIN_W
    mov dx, 1
    call fill_rect

    mov di, (WIN_Y + WIN_H - 1) * SCRW + WIN_X
    mov al, C_DKGRAY
    mov cx, WIN_W
    mov dx, 1
    call fill_rect

    mov di, (WIN_Y + 1) * SCRW + WIN_X
    mov al, C_GRAY
    mov cx, 1
    mov dx, WIN_H - 2
    call fill_rect

    mov di, (WIN_Y + 1) * SCRW + WIN_X + WIN_W - 1
    mov al, C_DKGRAY
    mov cx, 1
    mov dx, WIN_H - 2
    call fill_rect

    call draw_window_text
    ret

; 窗口里的中文内容
draw_window_text:
    mov byte [fgcol], C_GRAY
    mov byte [bgcol], C_BLACK

    mov word [curx], WIN_X + 10
    mov word [cury], WIN_Y + 8
    mov si, txt_head
    call draw_text

    mov word [curx], WIN_X + 10
    mov word [cury], WIN_Y + 28
    mov si, txt_1
    call draw_text

    mov word [curx], WIN_X + 10
    mov word [cury], WIN_Y + 46
    mov si, txt_2
    call draw_text

    mov word [curx], WIN_X + 10
    mov word [cury], WIN_Y + 68
    mov si, txt_3
    call draw_text

    mov word [curx], WIN_X + 10
    mov word [cury], WIN_Y + 86
    mov si, txt_4
    call draw_text

    mov word [curx], WIN_X + 10
    mov word [cury], WIN_Y + 104
    mov si, txt_5
    call draw_text

    mov word [curx], WIN_X + 10
    mov word [cury], WIN_Y + 122
    mov si, txt_6
    call draw_text
    ret

; 状态栏
draw_status:
    mov ax, 0xA000
    mov es, ax
    mov di, STATUS_Y * SCRW
    mov al, C_DKGRAY
    mov cx, SCRW
    mov dx, SCRH - STATUS_Y
    call fill_rect

    mov word [curx], 6
    mov word [cury], STATUS_Y + 2
    mov byte [fgcol], C_WHITE
    mov byte [bgcol], C_DKGRAY
    mov si, msg_status
    call draw_text
    ret

; 标题栏右边的时钟 HH:MM:SS
draw_clock:
    mov ah, 0x02
    int 0x1A
    jc .fail

    mov al, ch
    call bcd2bin
    mov [hour], al
    mov al, cl
    call bcd2bin
    mov [minute], al
    mov al, dh
    call bcd2bin
    mov [second], al

    mov byte [fgcol], C_WHITE
    mov byte [bgcol], C_NAVY
    mov word [curx], SCRW - 58
    mov word [cury], 0
    mov al, [hour]
    call put_2digit
    mov al, ':'
    call put_char
    mov al, [minute]
    call put_2digit
    mov al, ':'
    call put_char
    mov al, [second]
    call put_2digit
    ret
.fail:
    ret

; ================================================================
;  绘图基元
; ================================================================

; 用 AL 填一块矩形：DI=显存偏移 CX=宽 DX=高
fill_rect:
    push ax
    push bx
    push cx
    push dx
    push di
    push bp
    cld
    mov bx, cx                ; BX = 宽度
    mov bp, dx                ; BP = 高度
.rows:
    push bx
    push di
    mov cx, bx
    mov ah, 0
    rep stosb
    pop di
    add di, SCRW
    pop bx
    dec bp
    jnz .rows
    pop bp
    pop di
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; 画一行 8 像素：AL=位掩码（高位在左），DI=显存偏移
put_row8:
    ; AL = 8 位掩码（高位在左），DI = 显存偏移
    push ax
    push bx
    push cx
    push dx
    push di
    mov bx, ax
    mov cx, 8
.l:
    push cx
    mov dl, [bgcol]
    test bl, 0x80          ; 最高位是 1 就是前景像素
    jz .put
    mov dl, [fgcol]
.put:
    mov [es:di], dl
    inc di
    shl bl, 1
    pop cx
    loop .l
    pop di
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; 画一行 16 像素：AX=位掩码（高位在左），DI=显存偏移
put_row16:
    push ax
    push bx
    push cx
    push dx
    push di
    ; AX 来自 mov ax,[si]（小端）：AL = 字模左半字节，AH = 右半字节
    ; 画法从 bit15 开始（左 -> 右），所以左半必须放到 BH
    mov bh, al
    mov bl, ah
    mov cx, 16
.l:
    push cx
    shl bx, 1
    jc .fg
    pop cx
    mov dl, [bgcol]
    jmp .put
.fg:
    pop cx
    mov dl, [fgcol]
.put:
    mov [es:di], dl
    inc di
    loop .l
    pop di
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; 画一个 ASCII 字形：SI=字模地址（8x16）
draw_ascii:
    push ax
    push cx
    push di
    mov ax, [cury]
    mov bx, SCRW
    mul bx
    add ax, [curx]
    mov di, ax
    mov cx, 16
.rows:
    push cx
    mov al, [si]
    call put_row8
    inc si
    add di, SCRW
    pop cx
    loop .rows
    pop di
    pop cx
    pop ax
    ret

; 画一个汉字字形：SI=字模地址（16x16）
draw_cjk:
    push ax
    push cx
    push di
    mov ax, [cury]
    mov bx, SCRW
    mul bx
    add ax, [curx]
    mov di, ax
    mov cx, 16
.rows:
    push cx
    mov ax, [si]
    call put_row16
    add si, 2
    add di, SCRW
    pop cx
    loop .rows
    pop di
    pop cx
    pop ax
    ret

; ================================================================
;  文本渲染（UTF-8，半角 8 宽，全角 16 宽）
; ================================================================

; SI = UTF-8 字符串（0 结尾），当前坐标用 curx / cury
; 字符串指针放在 BP：SI 要留给字模地址，DI 要留给显存偏移
draw_text:
    ; SI = UTF-8 字符串（0 结尾），当前坐标用 curx / cury
    ; 字符串指针放在内存变量 strp 里，避免寄存器互相干扰
    push ax
    push bx
    push cx
    push dx
    push si
    push di
    mov [strp], si

.loop:
    mov si, [strp]
    mov al, [si]
    test al, al
    jz .done
    inc si
    mov [strp], si

    cmp al, 0x80
    jae .utf

    ; --- 半角：字模地址 = fonthead + 12 + (码点 - 0x20) * 16 ---
    sub al, 0x20
    mov bl, al
    mov bh, 0
    shl bx, 4
    add bx, fonthead
    add bx, 12
    mov si, bx
    call draw_ascii
    add word [curx], 8
    jmp .loop

    ; --- 全角：3 字节 UTF-8 ---
.utf:
    and al, 0x0F
    mov ah, al
    shl ax, 12
    mov si, [strp]
    mov al, [si]
    inc si
    mov [strp], si
    and al, 0x3F
    mov bl, al
    mov bh, 0               ; BH 必须清零，否则 shl bx,6 会把垃圾位带进来
    shl bx, 6
    mov si, [strp]
    mov al, [si]
    inc si
    mov [strp], si
    and al, 0x3F
    or bl, al
    or ax, bx

    call find_cjk
    call draw_cjk
    add word [curx], 16
    jmp .loop

.done:
    pop di
    pop si
    pop dx
    pop cx
    pop bx
    pop ax
    ret

; 在码点表里查汉字，返回字模地址（SI）。查不到就返回方块。
find_cjk:
    push bx
    push cx
    push dx
    push di
    mov di, [cjkmap]
    mov cx, [cjkcount]
    mov bx, 0
.find:
    test cx, cx
    jz .notfound
    mov dx, [di]
    cmp ax, dx
    je .found
    add di, 2
    inc bx
    dec cx
    jmp .find
.found:
    mov si, bx
    shl si, 5              ; 索引 * 32
    add si, [cjkgly]
    pop di
    pop dx
    pop cx
    pop bx
    ret
.notfound:
    mov si, boxglyph
    pop di
    pop dx
    pop cx
    pop bx
    ret

; 画一个 ASCII 字符（AL），用于时钟等场合
put_char:
    push ax
    push bx
    push cx
    push si
    sub al, 0x20
    mov bl, al
    mov bh, 0
    shl bx, 4
    add bx, [ascigly]
    mov si, bx
    call draw_ascii
    add word [curx], 8
    pop si
    pop cx
    pop bx
    pop ax
    ret

; 画两位十进制数（AL = 0..99）
put_2digit:
    push ax
    push bx
    push cx
    mov ah, 0
    mov bl, 10
    div bl
    add al, '0'
    call put_char
    mov al, ah
    add al, '0'
    call put_char
    pop cx
    pop bx
    pop ax
    ret

; BCD 转二进制：AL = BCD → AL = 二进制
bcd2bin:
    push bx
    push cx
    mov bl, al
    and al, 0x0F
    mov ah, al
    mov al, bl
    shr al, 4
    mov bl, al
    shl bl, 1
    mov cl, bl
    shl bl, 1
    shl bl, 1
    add bl, cl
    add al, bl
    pop cx
    pop bx
    ret

; ================================================================
;  串口镜像
; ================================================================
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
    pop dx
    pop ax
    ret

sc_puts:
    push ax
    push si
.l:
    mov al, [si]
    test al, al
    jz .d
    call sc_putc
    inc si
    jmp .l
.d:
    pop si
    pop ax
    ret

sc_putc:
    push ax
    push cx
    push dx
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
    pop dx
    pop cx
    pop ax
    ret

; ================================================================
;  数据
; ================================================================
ascicount: dw 0
ascigly:   dw 0
cjkcount:  dw 0
cjkmap:    dw 0
cjkgly:    dw 0
curx:      dw 0
cury:      dw 0
cp:        dw 0
strp:      dw 0
fgcol:     db C_WHITE
bgcol:     db C_BLACK
hour:      db 0
minute:    db 0
second:    db 0

; 找不到字模时用的实心方块 16x16
boxglyph:
    db 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF
    db 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF
    db 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF
    db 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF, 0xFF,0xFF

msg_title: db " Lumen OS 1.0", 0
msg_status: db " x86 native  |  640K  |  LMFS  |  COM1 115200", 0
msg_boot: db "Lumen OS graphical kernel ready", 13, 10, 0

txt_head: db "欢迎使用 Lumen OS", 0
txt_1: db "这是完全用 x86 机器码手写的内核", 0
txt_2: db "没有用任何第三方内核或引导程序", 0
txt_3: db "界面  VGA 320x200 256 色", 0
txt_4: db "字体  16x16 点阵汉字字库", 0
txt_5: db "磁盘  LMFS 文件系统 512 字节块", 0
txt_6: db "全部为本项目自己写的代码", 0
