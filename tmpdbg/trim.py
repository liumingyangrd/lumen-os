import io, re, sys

p = 'src/x86/stage1.s'
lines = io.open(p, 'rb').read().decode('utf-8').splitlines()

# 删掉 ser_put / ser_hex / ser_nib / ser_nl 四个例程（只保留 ser_init 与 ser_putc）
def drop(labels):
    out = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        m = re.match(r'^([A-Za-z_][\w]*):', ln)
        if m and m.group(1) in labels:
            i += 1
            while i < len(lines) and not re.match(r'^[A-Za-z_.][\w.]*:\s*', lines[i]):
                i += 1
            continue
        out.append(ln)
        i += 1
    return out

lines = drop({'ser_put', 'ser_hex', 'ser_nib', 'ser_nl'})
s = '\n'.join(lines) + '\n'

old = """    ; 串口输出同样的内容
    mov al, dl
    call ser_hex
    mov al, ':'
    call ser_putc
    mov al, [errstat]
    call ser_hex
    mov al, ' '
    call ser_putc
"""
new = """    ; 串口输出同样的内容（原始字节，方便脚本解析）
    mov al, dl
    call ser_putc
    mov al, ':'
    call ser_putc
    mov al, [errstat]
    call ser_putc
    mov al, ' '
    call ser_putc
"""
assert old in s, 'pattern not found'
s = s.replace(old, new)

s = s.replace('msg_try: db "[s1 read]", 13, 10, 0', 'msg_try: db "LUMEN stage1", 13, 10, 0')
s = s.replace('msg_ok:  db "[s1 ok]", 13, 10, 0', 'msg_ok:  db "OK", 13, 10, 0')
s = s.replace('msg_err: db "[s1 err]", 13, 10, 0', 'msg_err: db "FAIL", 13, 10, 0')

io.open(p, 'wb').write(s.encode('utf-8'))
print('trimmed, lines =', len(lines))
