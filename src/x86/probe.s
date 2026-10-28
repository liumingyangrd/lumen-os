org 0x7C00
start:
    cli
    xor ax, ax
    mov ds, ax
    mov ss, ax
    mov sp, 0x7C00
    sti
    call com_init
    mov si, msg
    call puts
done:
    jmp done

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
w:
    mov dx, 0x3FD
    in al, dx
    test al, 0x20
    jnz txs
    loop w
txs:
    mov dx, 0x3F8
    mov al, ah
    out dx, al
    pop cx
    pop dx
    pop ax
    ret

puts:
    push ax
    push si
p:
    mov al, [si]
    test al, al
    jz d
    call sc
    inc si
    jmp p
d:
    pop si
    pop ax
    ret

msg: db "PROBE-OK", 13, 10, 0
