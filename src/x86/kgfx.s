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
CUR_H = 13                        ; 光标高度（像素）

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
    call mouse_init

    ; 初始光标位置 + 画出来
    mov word [mx], 150
    mov word [my], 92
    call cursor_draw

    mov si, msg_boot
    call sc_puts

main_loop:
    call mouse_poll
    call key_poll
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
    ; VMware 的 BIOS INT 1A 会破坏 ES！重设到显存段，否则下面的
    ; put_char 写到垃圾段里，什么都看不见。
    mov ax, 0xA000
    mov es, ax

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
    mov al, 'F'
    call sc_putc
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
    add bx, fonthead        ; 与 draw_text 相同的常量寻址（[ascigly] 间接读在此环境中不可靠）
    add bx, 12
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
;  PS/2 鼠标（轮询，无中断）
; ================================================================

; 等控制器输入缓冲空（可以往 64h 写）
kwait_w:
    push cx
    push ax
    mov cx, 60000
.w:
    mov dx, 0x64
    in al, dx
    test al, 2
    jz .done
    loop .w
.done:
    pop ax
    pop cx
    ret

; 等输出缓冲有数据（可以从 60h 读）。CF=1 超时
kwait_r:
    push cx
    mov cx, 60000
.w:
    mov dx, 0x64
    in al, dx
    test al, 1
    jnz .ok
    loop .w
    stc
    pop cx
    ret
.ok:
    clc
    pop cx
    ret

; 把 AL 发给辅助设备（鼠标），并吃掉 ACK
aux_send:
    push ax
    call kwait_w
    mov dx, 0x64
    mov al, 0xD4
    out dx, al
    pop ax
    push ax
    call kwait_w
    mov dx, 0x60
    out dx, al
    call kwait_r
    mov dx, 0x60
    in al, dx
    pop ax
    ret

mouse_init:
    ; 允许辅助端口
    call kwait_w
    mov dx, 0x64
    mov al, 0xA8
    out dx, al
    ; 读控制器命令字节，清掉 IRQ12 使能位（我们轮询，不要中断）
    call kwait_w
    mov dx, 0x64
    mov al, 0x20
    out dx, al
    call kwait_r
    mov dx, 0x60
    in al, dx
    and al, 0xFD
    mov [cmdbyte], al
    ; 写回命令字节
    call kwait_w
    mov dx, 0x64
    mov al, 0x60
    out dx, al
    call kwait_w
    mov dx, 0x60
    mov al, [cmdbyte]
    out dx, al
    ; 鼠标：设默认值、10 次/秒采样、允许上报
    mov al, 0xF6
    call aux_send
    mov al, 0xF3
    call aux_send
    mov al, 10
    call aux_send
    mov al, 0xF4
    call aux_send
    ret

; 主循环里轮询：只收鼠标字节（bit5），凑满 3 字节处理一包
; 键盘字节（bit5=0）不碰，留给 BIOS 的 IRQ1 处理
mouse_poll:
    mov cx, 16                ; 一帧最多消化 16 字节
.loop:
    mov dx, 0x64
    in al, dx
    test al, 1
    jz .done                  ; 输出缓冲空
    test al, 0x20
    jz .done                  ; bit5=0：是键盘字节，留给 BIOS
    mov dx, 0x60
    in al, dx
    cmp word [mphase], 0
    jne .store
    test al, 0x08             ; 包首字节的 bit3 恒为 1，用来同步
    jz .done                  ; 不同步就丢弃，等真正的包首
.store:
    mov bx, [mphase]
    add bx, mpkt
    mov [bx], al
    add word [mphase], 1
    cmp word [mphase], 3
    jne .next
    mov word [mphase], 0
    call mouse_packet
.next:
    loop .loop
.done:
    ret

; 键盘轮询：方向键移动光标，空格切换按下状态
; （鼠标之外的第二输入路径，VMware 窗口和真机都可用）
key_poll:
    mov ah, 0x01
    int 0x16
    jz .done                 ; 无按键
    mov ah, 0x00
    int 0x16                 ; AH=扫描码

    cmp ah, 0x39             ; 空格 = 左键
    jne .dir
    xor byte [mbtn], 1
    call draw_btn
    jmp .done

.dir:
    ; 只有方向键才继续
    cmp ah, 0x48
    je .ok
    cmp ah, 0x50
    je .ok
    cmp ah, 0x4B
    je .ok
    cmp ah, 0x4D
    je .ok
    jmp .done

.ok:
    call hide_if_drawn       ; 先在旧位置擦掉光标（坐标还是旧的！）
    cmp ah, 0x48             ; 上
    jne .n1
    sub word [my], 8
    jmp .apply
.n1:
    cmp ah, 0x50             ; 下
    jne .n2
    add word [my], 8
    jmp .apply
.n2:
    cmp ah, 0x4B             ; 左
    jne .n3
    sub word [mx], 8
    jmp .apply
.n3:
    add word [mx], 8         ; 右
.apply:
    call clamp_cursor
    call cursor_draw
.done:
    ret

; 把 mx/my 钳到屏幕内
clamp_cursor:
    cmp word [mx], 0
    jge .x1
    mov word [mx], 0
.x1:
    cmp word [mx], 312
    jle .x2
    mov word [mx], 312
.x2:
    cmp word [my], 0
    jge .y1
    mov word [my], 0
.y1:
    cmp word [my], 185
    jle .y2
    mov word [my], 185
.y2:
    ret

; 处理一个 3 字节包：[0]=状态 [1]=X 增量 [2]=Y 增量
mouse_packet:
    mov al, [mpkt]
    test al, 0xC0             ; 溢出位有效就丢包
    jnz .skip

    call hide_if_drawn        ; 先在旧位置擦掉光标（坐标还是旧的！）

    mov al, [mpkt+1]
    cbw                       ; AX = 有符号 X 增量
    add [mx], ax
    mov al, [mpkt+2]
    cbw
    sub [my], ax              ; PS/2 的 Y 正方向朝上，屏幕朝下

    ; 按钮状态 → 状态栏指示灯
    mov al, [mpkt]
    and al, 7
    mov [mbtn], al
    call draw_btn

    call clamp_cursor
    call cursor_draw
.skip:
    ret

; 光标画在屏幕上时才擦除
hide_if_drawn:
    cmp byte [mdrawn], 0
    jz .skip
    call cursor_hide
.skip:
    ret

; 状态栏右侧的三个按钮指示灯（左/中/右）
draw_btn:
    push ax
    push cx
    push dx
    push di
    mov ax, 0xA000
    mov es, ax
    mov di, (STATUS_Y + 5) * SCRW + 292
    mov dl, [mbtn]
    mov cx, 3
.b:
    push cx
    push di
    push ax
    mov al, C_DKGRAY
    test dl, 1
    jz .off
    mov al, C_WHITE
.off:
    mov cx, 5                 ; 宽
    mov dx, 5                 ; 高
    call fill_rect
    pop ax
    pop di
    add di, 8
    shr dl, 1
    pop cx
    loop .b
    pop di
    pop dx
    pop cx
    pop ax
    ret

; 画光标：把背景存进 cursav，再描轮廓/填白
cursor_draw:
    push ax
    push cx
    push dx
    push si
    push di
    mov ax, 0xA000
    mov es, ax
    mov ax, [my]
    mov dx, SCRW
    mul dx
    add ax, [mx]
    mov di, ax
    mov si, cur_gly
    mov bx, cursav
    mov cx, CUR_H
.row:
    push cx
    push di
    mov ah, [si]              ; 轮廓掩码
    mov al, [si+1]            ; 填充掩码
    mov cx, 8
.px:
    mov dl, [es:di]           ; 读背景像素
    mov [bx], dl              ; 存进保存缓冲
    inc bx
    mov dh, dl                ; 默认 = 背景原色
    test ah, 0x80
    jz .t1
    mov dh, 0x00              ; 轮廓：黑
    jmp .set
.t1:
    test al, 0x80
    jz .set
    mov dh, 0x0F              ; 填充：白
.set:
    mov [es:di], dh
    inc di
    shl ah, 1
    shl al, 1
    loop .px
    pop di
    add di, SCRW
    add si, 2
    pop cx
    loop .row
    mov byte [mdrawn], 1
    pop di
    pop si
    pop dx
    pop cx
    pop ax
    ret

; 擦光标：把 cursav 写回屏幕
; 注意：保存时是 13 行、每行 8 字节（行间隔 SCRW），
; 恢复必须逐行写，不能 rep movsb 连续写——否则背景被糊成横条
cursor_hide:
    push ax
    push cx
    push dx
    push si
    push di
    mov ax, 0xA000
    mov es, ax
    mov ax, [my]
    mov dx, SCRW
    mul dx
    add ax, [mx]
    mov di, ax
    mov si, cursav
    mov cx, CUR_H
.row:
    push cx
    push di
    mov cx, 8
.p:
    mov al, [si]
    mov [es:di], al
    inc si
    inc di
    loop .p
    pop di
    add di, SCRW
    pop cx
    loop .row
    mov byte [mdrawn], 0
    pop di
    pop si
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

; ---------- 鼠标 ----------
mx:        dw 150
my:        dw 92
mbtn:      db 0
mphase:    dw 0
mpkt:      db 0, 0, 0
mdrawn:    db 0                      ; 光标当前是否画在屏幕上
cmdbyte:   db 0
cursav:    resb CUR_H * 8      ; 光标下面的背景

; 光标字模：13 行 x 8 像素，每行两个掩码
;   第 1 字节 = 黑色轮廓，第 2 字节 = 白色填充，两者都是 0 的像素透出背景
cur_gly:
    db 0x80,0x00
    db 0xC0,0x00
    db 0xA0,0x40
    db 0x90,0x60
    db 0x88,0x70
    db 0x84,0x78
    db 0x82,0x7C
    db 0x81,0x7E
    db 0x83,0x7C
    db 0x92,0x6C
    db 0xA4,0x4A
    db 0xCA,0x04
    db 0x0C,0x00

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
