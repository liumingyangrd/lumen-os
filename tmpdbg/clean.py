import io, re

p = 'src/x86/kgfx.s'
s = io.open(p, 'rb').read().decode('utf-8')

# 1) 删掉 draw_text 里的诊断块
diag_txt = """    ; 诊断：字模地址 + 该地址第 8 字节（'A' 的横杠应为 0x7E）
    mov dx, bx
    mov al, dh
    call sc_putc
    mov al, dl
    call sc_putc
    mov al, '='
    call sc_putc
    mov al, [bx+8]
    call sc_putc
    mov al, ' '
    call sc_putc
"""
assert diag_txt in s
s = s.replace(diag_txt, '')

# 2) 删掉内核开头的 SP / 内存检查 / 地址诊断
start_block = s[s.index('    ; 立刻打印 SP'):s.index('    call load_font')]
s = s.replace(start_block, '')

# 3) 删掉 'A' 字符的诊断与画 A 的整块
a_block = """    ; 诊断：ascigly 变量的值 + 该地址处的 4 字节 + 0x8A2B 处的字节
    mov ax, [ascigly]
    mov dx, ax
    mov al, dh
    call sc_putc
    mov al, dl
    call sc_putc
    mov al, '='
    call sc_putc
    mov si, [ascigly]
    mov cx, 4
.d1:
    push cx
    mov al, [si]
    call sc_putc
    mov al, ' '
    call sc_putc
    inc si
    pop cx
    loop .d1
    mov al, [0x8A2B]
    call sc_putc
    mov al, ' '
    call sc_putc

    ; 诊断：绕过 draw_text，直接把 'A' 画到 (200, 100)
    mov al, 15
    call mark
    mov ax, 0xA000
    mov es, ax
    mov al, 'A'
    sub al, 0x20
    mov bl, al
    mov bh, 0
    shl bx, 4
    add bx, [ascigly]
    ; 诊断：字模地址 + 该地址第 8 字节（'A' 的横杠应为 0x7E）
    mov dx, bx
    mov al, dh
    call sc_putc
    mov al, dl
    call sc_putc
    mov al, '='
    call sc_putc
    mov al, [bx+8]
    call sc_putc
    mov al, ' '
    call sc_putc
    mov si, bx
    mov word [curx], 200
    mov word [cury], 100
    mov byte [fgcol], C_WHITE
    mov byte [bgcol], C_RED
    call draw_ascii
    mov al, 6
    call mark

    ; 诊断方块：位置 = (运行时代码地址 - 0x8000) + 20000
    call .here
.here:
    pop si
    mov ax, si
    sub ax, 0x8000
    add ax, 20000
    mov di, ax
    mov al, C_YELLOW
    mov cx, 16
    mov dx, 16
    call fill_rect

"""
if a_block in s:
    s = s.replace(a_block, '')
else:
    # 兜底：按标记切
    i = s.index('    ; 诊断：ascigly 变量的值')
    j = s.index('main_loop:')
    s = s[:i] + s[j:]

# 4) 删掉 curx/cury 的诊断块
cur_block = """    ; 诊断：curx 变量地址 + 写入后的值 + cury 变量地址 + 值
    mov si, curx
    mov dx, si
    mov al, dh
    call sc_putc
    mov al, dl
    call sc_putc
    mov al, '='
    call sc_putc
    mov ax, [curx]
    mov dx, ax
    mov al, dh
    call sc_putc
    mov al, dl
    call sc_putc
    mov al, '/'
    call sc_putc
    mov si, cury
    mov dx, si
    mov al, dh
    call sc_putc
    mov al, dl
    call sc_putc
    mov al, '='
    call sc_putc
    mov ax, [cury]
    mov dx, ax
    mov al, dh
    call sc_putc
    mov al, dl
    call sc_putc
    mov al, ' '
    call sc_putc
"""
if cur_block in s:
    s = s.replace(cur_block, '')

# 5) 删掉 mark 调用与 mark 例程（恢复正常内核）
s = re.sub(r'    mov al, \d+\n    call mark\n', '', s)
i = s.find('mark:\n')
if i >= 0:
    j = s.index('dbg2:\n')
    s = s[:i] + s[j:]
# 删掉 dbg2/pr16/pr8/prn 例程
i = s.find('dbg2:\n')
if i >= 0:
    j = s.index('mk1: mov al, ')
    s = s[:i] + s[j:]
# 删掉 mk1..mk7 例程
i = s.find('mk1: mov al, ')
if i >= 0:
    j = s.index('; ================================================================\n;  串口镜像')
    s = s[:i] + s[j:]

io.open(p, 'wb').write(s.encode('utf-8'))
print('清理完成，剩余行数', len(s.split('\n')))
