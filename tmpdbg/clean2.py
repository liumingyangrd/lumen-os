import io, re

p = 'src/x86/kgfx.s'
s = io.open(p, 'rb').read().decode('utf-8')

# 1) 去掉 dbg3 / dbg4 调用
s = s.replace("    call dbg3\n", "")
s = s.replace("    call dbg4\n", "")

# 2) 去掉主循环前那一整块诊断代码（从 dbg4 调用之后的测试块）
i = s.find("    ; 直接用 put_row8 画一个 'A'")
if i < 0:
    i = s.find("    mov al, 0x0F\n    mov di, 200")
if i >= 0:
    j = s.find("main_loop:", i)
    s = s[:i] + s[j:]

# 3) 去掉 dbg3 / dbg4 例程
i = s.find("dbg3:\n")
if i >= 0:
    j = s.find("; ================================================================\n;  串口镜像")
    s = s[:i] + s[j:]

io.open(p, 'wb').write(s.encode('utf-8'))
print('kgfx 清理完成')

# ---- stage1 的诊断也要去掉 ----
p2 = 'src/x86/stage1.s'
t = io.open(p2, 'rb').read().decode('utf-8')
t = t.replace("    call ser_init\n\n    ; ---------- 读盘到 0x8000 ----------", "\n    ; ---------- 读盘到 0x8000 ----------")
i = t.find("    ; 诊断：把魔数地址的高低字节打到串口")
if i >= 0:
    j = t.find("    mov ax, [si+4]\n    mov [klen], ax")
    t = t[:i] + t[j:]
# 去掉 ser_init / ser_putc（stage1 里不再需要串口输出）
i = t.find("ser_init:\n")
if i >= 0:
    j = t.find("; ---------- 磁盘地址包（DAP）----------")
    t = t[:i] + t[j:]
io.open(p2, 'wb').write(t.encode('utf-8'))
print('stage1 清理完成')
