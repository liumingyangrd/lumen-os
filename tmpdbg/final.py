import io, re

p = 'src/x86/kgfx.s'
raw = io.open(p, 'rb').read().decode('utf-8')
crlf = '\r\n' in raw
s = raw.replace('\r\n', '\n')

def rep(old, new):
    global s
    assert old in s, '未找到: ' + old[:60]
    s = s.replace(old, new)

# 1) load_font：把 ASCII/汉字 字形数也存下来（查表循环要用）
rep("""load_font:
    mov bx, fonthead
    mov ax, [bx+4]""",
    """load_font:
    mov bx, fonthead
    mov ax, [bx+0]
    mov [ascicount], ax
    mov ax, [bx+2]
    mov [cjkcount], ax
    mov ax, [bx+4]""")

# 2) put_row8 改回 8 像素版本（借用 16 位画法会让行偏移错位）
i = s.index("put_row8:")
j = s.index("; 画一行 16 像素")
s = s[:i] + """put_row8:
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

""" + s[j:]

# 3) 删掉所有诊断代码
s = s.replace("    call dbg3\n", "")
s = s.replace("    call dbg4\n", "")

# 3a) 主流程里的诊断块
for marker in ["    ; 诊断：打印 fonthead", "    ; 诊断：draw_title 之后 curx"]:
    while marker in s:
        a = s.index(marker)
        b = s.find("\n    call draw_window", a)
        c = s.find("\n    call draw_status", a)
        if b < 0 or (c >= 0 and c < b):
            b = c
        if b < 0:
            b = s.index('\n', a + 1)
        s = s[:a] + s[b:]

# 3b) 单独画「一」的诊断块
if "    ; 诊断：绕过 draw_text" in s:
    a = s.index("    ; 诊断：绕过 draw_text")
    b = s.index("\nmain_loop:", a)
    s = s[:a] + s[b:]

# 3c) draw_text 里的两处诊断
for marker in ["    ; 诊断：打印 BP 与 AL", "    ; 诊断：打印解码出的码点"]:
    while marker in s:
        a = s.index(marker)
        # 该块以 "    pop dx" + "    pop ax" 结束
        b = s.index("\n    pop ax", a) + len("\n    pop ax")
        s = s[:a] + s[b:]

# 3d) dbg3 / dbg4 例程
for nm in ["dbg3:\n", "dbg4:\n"]:
    if nm in s:
        a = s.index(nm)
        b = s.find("; ================================================================\n;  串口镜像", a)
        s = s[:a] + s[b:]

out = s.replace('\n', '\r\n') if crlf else s
io.open(p, 'wb').write(out.encode('utf-8'))
print('完成，行数', len(s.split('\n')))
