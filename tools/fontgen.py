#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从内核源码里提取用到的汉字，渲染成点阵字库。

输出 dist/font.bin：
    u16  asciiCount         ASCII 字形数（固定 95，0x20..0x7E）
    u16  cjkCount           汉字/全角字形数
    u8   ascii[95][16]      ASCII 8x16 点阵（每行 1 字节，8 像素宽）
    u16  codepoints[N]      升序码点表（二分查找用）
    u8   glyphs[N][32]      汉字 16x16 点阵（每行 2 字节）

点阵按行存储，每字节高位在左。
"""
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'src', 'x86', 'kmain.s')
OUT = os.path.join(ROOT, 'dist', 'font.bin')
FONT_PATH = 'C:/Windows/Fonts/simhei.ttf'
SIZE = 16


def collect_chars():
    """收集会在屏幕上出现的非 ASCII 字符。

    只看内核里的 db 字符串（用户可见的文本），不看注释 —— 注释里的中文
    不需要字模，能把字库从 16KB 压到几 KB。
    """
    import re
    seen = {}
    src_dir = os.path.join(ROOT, 'src', 'x86')
    for name in sorted(os.listdir(src_dir)):
        if not name.endswith('.s'):
            continue
        text = open(os.path.join(src_dir, name), encoding='utf-8').read()
        # 去掉整行注释
        code_lines = []
        for line in text.split('\n'):
            idx = line.find(';')
            code_lines.append(line if idx < 0 else line[:idx])
        code = '\n'.join(code_lines)
        # 只取 db "..." 里的内容
        for m in re.finditer(r'db\s+"([^"]*)"', code):
            for ch in m.group(1):
                if ord(ch) > 0x7E:
                    seen[ch] = True
    return sorted(seen.keys(), key=ord)


def render_glyphs(chars, font):
    glyphs = []
    for ch in chars:
        img = Image.new('L', (SIZE, SIZE), 0)
        d = ImageDraw.Draw(img)
        d.text((0, 0), ch, font=font, fill=255)
        px = img.load()
        data = bytearray()
        for y in range(SIZE):
            b0 = 0
            b1 = 0
            for x in range(8):
                if px[x, y] > 100:
                    b0 |= 1 << (7 - x)
            for x in range(8, 16):
                if px[x, y] > 100:
                    b1 |= 1 << (15 - x)
            data.append(b0)
            data.append(b1)
        glyphs.append(bytes(data))
    return glyphs


def render_ascii(font):
    out = bytearray()
    for code in range(0x20, 0x7F):
        img = Image.new('L', (8, SIZE), 0)
        d = ImageDraw.Draw(img)
        d.text((0, 0), chr(code), font=font, fill=255)
        px = img.load()
        for y in range(SIZE):
            b = 0
            for x in range(8):
                if px[x, y] > 110:
                    b |= 1 << (7 - x)
            out.append(b)
    return bytes(out)


def main():
    chars = collect_chars()
    if not chars:
        print('源码里没有非 ASCII 字符')
        return
    font = ImageFont.truetype(FONT_PATH, SIZE)
    glyphs = render_glyphs(chars, font)
    ascii_data = render_ascii(font)

    blob = bytearray()
    blob += struct.pack('<HH', 95, len(chars))
    blob += ascii_data
    for ch in chars:
        blob += struct.pack('<H', ord(ch))
    for g in glyphs:
        blob += g

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(blob)

    print('字库生成 %s' % OUT)
    print('  ASCII 字形   95 x 16 B = %d B' % len(ascii_data))
    print('  汉字字形     %d x 32 B = %d B' % (len(chars), len(chars) * 32))
    print('  码点表       %d x 2 B  = %d B' % (len(chars), len(chars) * 2))
    print('  合计         %d B' % len(blob))
    print('  字符集       %s' % ''.join(chars))


if __name__ == '__main__':
    main()
