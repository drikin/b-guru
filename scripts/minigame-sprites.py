#!/usr/bin/env python3
"""散財ダッシュ（B-guru ミニゲーム）のドット絵をコードで描き、
src/lib/minigame/sprites.generated.ts と確認用 PNG を書き出す。

    python3 -I scripts/minigame-sprites.py [--out DIR]

- 外部素材なし・Pillow なし（PNG は zlib で書く）。
- 画風は部室のドット絵に合わせる: 16px の升・夜の配色・キャラは 1px の暗い縁取り（ink）。
- 似顔絵の誇張はしない。3 人は同じ頭身で、帽子・眼鏡・髪・服の色・持ち物の記号で見分ける。
- PNG は --out（既定は一時ディレクトリの b-guru-minigame-art）に出し、リポジトリには入れない。
"""
import argparse, os, struct, sys, tempfile, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TS_OUT = os.path.join(ROOT, "src", "lib", "minigame", "sprites.generated.ts")

# ---------------- palette: 最大 36 色。並び順＝索引（"0"-"9","a"-"z"）。索引 0 も普通の色 ----------------
PAL_LIST = [
    ("night", "#120e14"), ("ink", "#1d1820"), ("plum", "#2b1d3a"), ("violet", "#5b3f7a"), ("lilac", "#8a67ab"),
    ("woodD", "#4b2f1d"), ("wood", "#7c5434"), ("woodL", "#a8784f"), ("paper", "#fdf0d2"),
    ("amberD", "#c98a2e"), ("amber", "#f2b24c"), ("lemon", "#f7e7a1"),
    ("redD", "#8c2f39"), ("red", "#dc4a3f"), ("pink", "#e86a92"),
    ("greenD", "#1f7a45"), ("green", "#3ccf74"), ("navy", "#1b2a4a"), ("blue", "#2f5d8a"), ("sky", "#4bacc6"),
    ("ice", "#a9e3ef"), ("black", "#2a1f1a"), ("grayD", "#55555f"), ("gray", "#8a8a96"), ("grayL", "#cfcfd6"),
    ("cream", "#f3e9d8"), ("white", "#fffaf0"), ("skin", "#f1c7a0"), ("skinS", "#d99a74"),
    ("tan", "#c97a3a"), ("brownD", "#7a4520"),
    # 今回足した色: 黒い服・帽子の明るい面 / リュックの肩ひも / 赤みのある茶髪 2 段 / 革ジャン
    ("char", "#3d3646"), ("orange", "#ec7a2c"), ("hairR", "#94482c"), ("hairL", "#c46a3e"), ("leather", "#7a5236"),
]
assert len(PAL_LIST) <= 36, len(PAL_LIST)
PAL = dict(PAL_LIST)
IDX = {n: i for i, (n, _) in enumerate(PAL_LIST)}
DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz"


def rgba(c):
    if c is None:
        return (0, 0, 0, 0)
    if isinstance(c, tuple):
        return c
    h = PAL.get(c, c).lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)


class Img:
    """ドットは色の名前（PAL のキー）か None（透明）。確認用シートだけ RGBA タプルも許す。"""

    def __init__(s, w, h, bg=None):
        s.w, s.h = w, h
        s.p = [[bg] * w for _ in range(h)]

    def set(s, x, y, c):
        if 0 <= x < s.w and 0 <= y < s.h:
            s.p[y][x] = c

    def get(s, x, y):
        return s.p[y][x] if 0 <= x < s.w and 0 <= y < s.h else None

    def rect(s, c, x, y, w=1, h=1):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                s.set(xx, yy, c)

    def pts(s, c, pts):
        for x, y in pts:
            s.set(x, y, c)

    def blit(s, o, ox, oy, k=1):
        for y in range(o.h):
            for x in range(o.w):
                c = o.p[y][x]
                if c is not None:
                    s.rect(c, ox + x * k, oy + y * k, k, k)

    def outline(s, col="ink"):
        add = []
        for y in range(s.h):
            for x in range(s.w):
                if s.p[y][x] is None:
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        n = s.get(x + dx, y + dy)
                        if n is not None and n != col:
                            add.append((x, y))
                            break
        for x, y in add:
            s.p[y][x] = col
        return s

    def rows(s):
        out = []
        for row in s.p:
            out.append("".join("." if c is None else DIGITS[IDX[c]] for c in row))
        return out

    def save(s, path):
        raw = b"".join(b"\x00" + bytes(v for c in row for v in rgba(c)) for row in s.p)

        def chunk(t, d):
            return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
        data = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", s.w, s.h, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
        with open(path, "wb") as f:
            f.write(data)


def load_png(path):
    """自前の writer が書いた RGBA PNG（フィルタ 0..4）を読む。前の試作との比較用。"""
    with open(path, "rb") as f:
        d = f.read()
    pos, idat, w = 8, b"", 0
    while pos < len(d):
        ln, = struct.unpack(">I", d[pos:pos + 4]); t = d[pos + 4:pos + 8]; body = d[pos + 8:pos + 8 + ln]
        if t == b"IHDR":
            w, h = struct.unpack(">II", body[:8])
        elif t == b"IDAT":
            idat += body
        pos += 12 + ln
    raw = zlib.decompress(idat); bpp = 4; stride = w * bpp
    img = Img(w, h); prev = bytearray(stride); i = 0
    for y in range(h):
        ft = raw[i]; line = bytearray(raw[i + 1:i + 1 + stride]); i += 1 + stride
        for x in range(stride):
            a = line[x - bpp] if x >= bpp else 0; b = prev[x]; c = prev[x - bpp] if x >= bpp else 0
            if ft == 1: line[x] = (line[x] + a) & 255
            elif ft == 2: line[x] = (line[x] + b) & 255
            elif ft == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif ft == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
        for x in range(w):
            px = tuple(line[x * 4:x * 4 + 4])
            img.p[y][x] = px if px[3] else None
    return img


def crop(img, x0, y0, w, h):
    o = Img(w, h)
    for y in range(h):
        for x in range(w):
            o.p[y][x] = img.get(x0 + x, y0 + y)
    return o


# ---------------- tiny 3x5 font (確認用シートのラベルだけ) ----------------
F = {
    "0": "111101101101111", "1": "010110010010111", "2": "111001111100111", "3": "111001111001111",
    "4": "101101111001001", "5": "111100111001111", "6": "111100111101111", "7": "111001010010010",
    "8": "111101111101111", "9": "111101111001111", "A": "010101111101101", "B": "110101110101110",
    "C": "011100100100011", "D": "110101101101110", "E": "111100110100111", "F": "111100110100100",
    "G": "011100101101011", "H": "101101111101101", "I": "111010010010111", "J": "001001001101010",
    "K": "101101110101101", "L": "100100100100111", "M": "101111111101101", "N": "110101101101101",
    "O": "010101101101010", "P": "110101110100100", "Q": "010101101110011", "R": "110101110101101",
    "S": "011100010001110", "T": "111010010010010", "U": "101101101101111", "V": "101101101101010",
    "W": "101101111111101", "X": "101101010101101", "Y": "101101010010010", "Z": "111001010100111",
    " ": "000000000000000", "-": "000000111000000", ".": "000000000000010", ":": "000010000010000",
    "/": "001001010100100", "_": "000000000000111", "(": "010100100100010", ")": "010001001001010",
    "+": "000010111010000", ">": "100010001010100",
}


def text(img, s, x, y, col="cream", k=1):
    for ch in s.upper():
        g = F.get(ch, F[" "])
        for i, b in enumerate(g):
            if b == "1":
                img.rect(col, x + (i % 3) * k, y + (i // 3) * k, k, k)
        x += 4 * k
    return x


# =====================================================================================
# 3 人の記号（見た目の部品）。似顔絵の誇張はしない。体形・頭身は全員共通。
# =====================================================================================
CAST = {
    # 黒いメッシュキャップ（白い小さなロゴ）・黒の四角い眼鏡・ひげなし（オーナー指定）・黒 T（明るい灰のインナー）・オレンジの肩ひも・カメラ
    "drikin": dict(head="cap", glasses="square", beard=None, shirt="char", shirtS="black", collar="grayL",
                   straps="orange", pants="navy", shoes="black", item="camera"),
    # スキンヘッド・細い灰色の丸眼鏡・口ひげ・白 T・にこやか・ハンドマイク（控えめ。MacBook は 16px だと板に見えるのでマイク）
    "matsuo": dict(head="bald", glasses="round", beard="mustache", shirt="white", shirtS="grayL", collar=None,
                   straps=None, pants="grayD", shoes="black", item="mic"),
    # 赤みのある茶色のボリュームある髪（前髪・毛先が跳ねる）・眼鏡なし・茶の革ジャン＋焦げ茶の襟付きシャツ・小さなイヤリング・コントローラー
    "zenji": dict(head="hair", glasses=None, beard=None, shirt="leather", shirtS="woodD", collar="brownD",
                  straps=None, pants="black", shoes="woodD", item="pad"),
}
SHEET_COLOR = {"drikin": "orange", "matsuo": "grayL", "zenji": "hairL", "beagle": "tan"}


def person16(L, pose):
    """16x16 右向きの走り役。pose: run1 | run2 | jump | hit。足は y14、縁取りは y15 まで。"""
    g = Img(16, 16)
    dy = 1 if pose == "run2" else 0      # run2 は 1px 沈む（上下の揺れ）
    by = 9 + dy                          # 胴の上
    hy = 1 + dy                          # 頭の上（髪・帽子の 1 段目）
    # ---- 脚と靴 ----
    P, S = L["pants"], L["shoes"]
    if pose == "run1":                   # 前脚を右へ大きく、後ろ脚を左へ
        g.rect(P, 8, 12, 2, 1); g.rect(P, 9, 13, 2, 1); g.rect(S, 10, 14, 3, 1)
        g.rect(P, 5, 12, 2, 1); g.rect(P, 4, 13, 2, 1); g.rect(S, 2, 13, 2, 1)
    elif pose == "run2":                 # 脚が交差する瞬間
        g.rect(P, 6, 12, 4, 2); g.rect(S, 6, 14, 2, 1); g.rect(S, 9, 14, 2, 1)
    elif pose == "jump":                 # ひざを曲げてたたむ
        g.rect(P, 5, 12, 2, 1); g.rect(S, 4, 13, 3, 1); g.rect(P, 9, 12, 2, 1); g.rect(S, 10, 12, 2, 1)
    else:                                # hit: 尻もち気味に足を投げ出す
        g.rect(P, 5, 12, 6, 1); g.rect(S, 3, 12, 2, 1); g.rect(S, 11, 12, 2, 1); g.rect(P, 5, 13, 6, 1)
    # ---- 胴 ----
    g.rect(L["shirt"], 4, by, 8, 3); g.rect(L["shirtS"], 4, by + 2, 8, 1)
    if L["collar"]:
        if L["shirt"] == "leather":      # 革ジャンの前を開けて、焦げ茶の襟付きシャツ
            g.rect(L["collar"], 7, by, 2, 3); g.set(6, by, "woodL"); g.set(9, by, "woodL")
        else:                            # 黒 T の襟元にのぞく明るい灰色のインナー
            g.rect(L["collar"], 7, by, 2, 1)
    if L["straps"]:                      # リュックの肩ひも（両肩）
        g.rect(L["straps"], 5, by, 1, 2); g.rect(L["straps"], 10, by, 1, 2)
    # ---- 腕（後ろの腕は左、前の手は持ち物を持つ） ----
    skin = "skin"
    sleeve = L["shirt"]
    if pose == "jump":
        g.set(3, by - 1, sleeve); g.set(3, by - 2, skin)          # 後ろの腕を上げる
    elif pose == "hit":
        g.set(3, by - 1, sleeve); g.set(2, by - 2, skin); g.set(12, by - 1, sleeve); g.set(13, by - 2, skin)
    elif pose == "run1":
        g.set(3, by + 1, sleeve); g.set(2, by + 2, skin)
    else:
        g.set(3, by, sleeve); g.set(3, by + 1, skin)
    if pose != "hit":
        item16(g, L["item"], by + (-1 if pose == "jump" else 0))
    # ---- 頭 ----
    g.rect(skin, 4, hy + 1, 8, 7)
    g.set(4, hy + 7, None); g.set(11, hy + 7, None); g.set(4, hy + 7, None)
    g.rect(skin, 5, hy + 7, 6, 1)
    ey = hy + 4                          # 目の上の段
    if L["glasses"]:
        ey = hy + 3                      # 眼鏡の人は 1 段上げて、下にひげの段を空ける
    h = L["head"]
    if h == "cap":
        g.rect("char", 5, hy, 6, 1); g.rect("char", 4, hy + 1, 8, 1)  # 丸い山
        g.pts("black", [(5, hy), (4, hy + 1), (6, hy + 1)])          # 後ろはメッシュ（網目）
        g.set(9, hy + 1, "white")                                   # 正面の小さな白いロゴ
        g.rect("black", 4, hy + 2, 4, 1); g.rect("ink", 8, hy + 2, 6, 1)  # 帽子のふち＋つば（右向き）
        g.set(4, hy + 3, "black"); g.set(4, hy + 4, "black")        # もみあげ
    elif h == "bald":
        g.rect(skin, 5, hy, 6, 1)                                   # 丸い頭頂
        g.set(4, hy + 1, skin); g.set(11, hy + 1, skin)
        g.set(6, hy + 1, "cream")                                   # 頭のつや
        g.set(4, hy + 4, "skinS")                                   # 耳
    elif h == "hair":
        H, HL = "hairR", "hairL"
        g.rect(H, 4, hy - 1 if hy > 0 else 0, 8, 1)                 # ボリュームの上段
        g.rect(H, 3, hy, 10, 3)
        g.pts(HL, [(6, hy), (7, hy), (9, hy)])                      # つや
        g.pts(H, [(5, hy + 3), (6, hy + 3), (8, hy + 3), (10, hy + 3), (11, hy + 3)])  # 前髪（ぎざぎざ）
        g.rect(H, 3, hy + 3, 1, 4); g.rect(H, 12, hy + 3, 1, 3)     # 横の髪（長め）
        g.set(2, hy + 6, H); g.set(13, hy + 5, H); g.set(2, hy + 1, H)  # 毛先の跳ね
        g.set(4, hy + 6, "lemon")                                   # 小さなイヤリング
    # ---- 顔 ----
    if pose == "hit":
        for cx in (7, 10):               # ＠＠: 3x3 の輪
            g.pts("ink", [(cx - 1, ey), (cx, ey), (cx + 1, ey), (cx - 1, ey + 1), (cx + 1, ey + 1), (cx - 1, ey + 2), (cx, ey + 2)])
            g.set(cx, ey + 1, skin)
        g.set(8, hy + 7, "redD"); g.set(9, hy + 7, "redD")          # 口を「お」の形
        g.pts("lemon", [(2, hy), (13, hy + 1)])                     # 頭の周りの星
        g.pts("amber", [(1, hy + 1), (14, hy)])
    else:
        gl = L["glasses"]
        if gl == "square":               # 太めの黒い四角い枠（ウェリントン）
            g.rect("ink", 6, ey, 6, 1)
            g.pts("ink", [(6, ey + 1), (7, ey + 1), (9, ey + 1), (10, ey + 1)])  # 枠＋目
            g.pts("ice", [(8, ey + 1), (11, ey + 1)])               # レンズの光
        elif gl == "round":              # 細い灰色の丸い枠（角を抜く）
            g.pts("gray", [(7, ey), (10, ey), (6, ey + 1), (8, ey + 1), (9, ey + 1), (11, ey + 1), (7, ey + 2), (10, ey + 2)])
            g.pts("ink", [(7, ey + 1), (10, ey + 1)])
        else:
            g.rect("ink", 7, ey, 1, 2); g.rect("ink", 10, ey, 1, 2)
            g.pts("pink", [(6, ey + 2), (11, ey + 2)])
        bd = L["beard"]
        my = hy + 6
        if bd == "stubble":              # 口ひげ＋薄いあごひげ（点）
            g.rect("black", 8, my, 3, 1)
            g.pts("pink", [(6, my - 1)])
            g.pts("grayD", [(6, my + 1), (8, my + 1), (10, my + 1)])
            g.set(9, my + 1, "redD")
        elif bd == "mustache":
            g.rect("black", 8, my, 3, 1); g.set(9, my + 1, "redD"); g.set(8, my + 1, "redD")
            g.pts("pink", [(6, my - 1), (11, my - 1)])
        elif gl:                         # 眼鏡でひげなし: 眼鏡の下にほお＋小さな笑顔
            g.pts("pink", [(6, my - 1), (11, my - 1)])
            g.pts("redD", [(8, my), (9, my)])                       # 善司と同じ小さな笑顔
        else:
            g.set(8, my, "redD"); g.set(9, my, "redD")              # 小さな笑顔
    return g.outline()


def item16(g, it, by):
    if it == "camera":                   # VLOG のカメラ（黒いボディ・灰色のレンズ・赤い録画ランプ）
        g.rect("ink", 12, by, 3, 2); g.set(14, by, "grayL"); g.set(12, by - 1, "red"); g.set(11, by + 1, "skin")
    elif it == "laptop":                 # 閉じた MacBook（銀）を前の手で抱える
        g.rect("grayL", 11, by + 1, 4, 1); g.rect("gray", 11, by + 2, 4, 1); g.set(11, by, "skin")
    elif it == "pad":                    # ゲームのコントローラー
        g.rect("grayL", 11, by, 4, 2); g.set(11, by, "ink"); g.set(14, by, "red"); g.set(13, by + 1, "sky")
    elif it == "mic":
        g.rect("gray", 12, by - 2, 2, 2); g.set(12, by - 2, "grayL"); g.rect("black", 12, by, 1, 2); g.set(11, by + 1, "skin")


def person32(L):
    """32x32 キャラ選び画面の立ち絵（正面、にこやか）。"""
    g = Img(32, 32)
    P = L["pants"]
    g.rect(P, 12, 24, 3, 4); g.rect(P, 17, 24, 3, 4)
    g.rect(L["shoes"], 11, 28, 4, 2); g.rect(L["shoes"], 17, 28, 4, 2)
    y0 = 17
    g.rect(L["shirt"], 10, y0, 12, 8); g.rect(L["shirtS"], 10, y0 + 6, 12, 2)
    if L["shirt"] == "leather":
        g.rect(L["collar"], 14, y0, 4, 8)                            # 焦げ茶のシャツ
        g.pts("woodD", [(14, y0), (17, y0), (15, y0 + 1), (16, y0 + 1)])  # シャツの襟
        g.rect("woodL", 12, y0, 2, 1); g.rect("woodL", 18, y0, 2, 1)       # 革ジャンの襟（明るい面）
        g.pts("woodL", [(13, y0 + 1), (18, y0 + 1), (13, y0 + 2), (18, y0 + 2)])
        g.set(16, y0 + 3, "woodL"); g.set(16, y0 + 5, "woodL")              # ボタン
        g.rect("woodD", 10, y0 + 2, 1, 4); g.rect("woodD", 21, y0 + 2, 1, 4)
    elif L["collar"]:
        g.rect(L["collar"], 14, y0, 4, 1); g.rect(L["collar"], 15, y0 + 1, 2, 1)  # インナーの丸首
        g.rect("char", 11, y0 + 2, 1, 4)
    if L["straps"]:
        g.rect(L["straps"], 11, y0, 2, 7); g.rect(L["straps"], 19, y0, 2, 7)
        g.rect("amberD", 11, y0 + 4, 2, 1); g.rect("amberD", 19, y0 + 4, 2, 1)  # 金具
    if L["shirt"] == "white":
        g.rect("grayL", 14, y0, 4, 1)                                # 白 T の襟ぐり
    # 腕
    g.rect(L["shirt"], 8, y0 + 1, 2, 4); g.rect("skin", 8, y0 + 5, 2, 2)
    g.rect(L["shirt"], 22, y0 + 1, 2, 4); g.rect("skin", 22, y0 + 5, 2, 2)
    # 頭（全員同じ形）
    hy = 3
    g.rect("skin", 9, hy + 2, 14, 12); g.rect("skin", 10, hy + 1, 12, 14)
    g.rect("skinS", 10, hy + 13, 12, 1)
    g.rect("skin", 8, hy + 7, 1, 3); g.rect("skin", 23, hy + 7, 1, 3)
    g.set(8, hy + 8, "skinS"); g.set(23, hy + 8, "skinS")
    h = L["head"]
    if h == "cap":
        g.rect("char", 10, hy - 2, 12, 2); g.rect("char", 9, hy, 14, 4)
        for yy in range(hy - 2, hy + 2):                              # 横・後ろのメッシュ
            for xx in (9, 10, 11, 20, 21, 22):
                if (xx + yy) % 2 == 0:
                    g.set(xx, yy, "black")
        g.rect("char", 12, hy - 2, 8, 4)                              # 正面パネル
        g.rect("white", 15, hy - 1, 2, 2)                             # 小さな白いロゴ
        g.rect("black", 8, hy + 3, 16, 2); g.rect("ink", 9, hy + 4, 14, 1)  # つば
        g.rect("black", 8, hy + 5, 2, 3); g.rect("black", 22, hy + 5, 2, 3)  # もみあげ
    elif h == "bald":
        g.rect("skin", 11, hy, 10, 1)
        g.rect("cream", 12, hy + 1, 3, 1); g.set(12, hy + 2, "cream")       # つや
    elif h == "hair":
        H, HL = "hairR", "hairL"
        g.rect(H, 10, hy - 2, 12, 2); g.rect(H, 8, hy, 16, 5)
        g.rect(H, 7, hy + 2, 3, 10); g.rect(H, 22, hy + 2, 3, 10)
        g.pts(H, [(6, hy + 11), (5, hy + 12), (25, hy + 11), (26, hy + 12), (8, hy - 1), (23, hy - 1), (7, hy + 1), (24, hy + 1)])  # 毛先の跳ね
        g.pts(HL, [(12, hy - 1), (13, hy - 1), (14, hy), (18, hy - 1), (19, hy), (9, hy + 3), (23, hy + 4), (8, hy + 7), (23, hy + 8)])
        # 前髪（ぎざぎざ）
        for x, d in ((10, 2), (11, 3), (12, 1), (13, 2), (14, 3), (15, 1), (16, 2), (17, 3), (18, 1), (19, 2), (20, 3), (21, 1)):
            g.rect(H, x, hy + 5, 1, d - 1 if d > 1 else 0)
        g.set(8, hy + 12, None); g.set(7, hy + 12, H)
        g.rect("skin", 10, hy + 13, 12, 1); g.rect("skinS", 10, hy + 13, 12, 1)
        g.set(8, hy + 10, "lemon"); g.set(23, hy + 10, "lemon")      # 小さなイヤリング
        g.set(8, hy + 9, "skin"); g.set(23, hy + 9, "skin")
    ey = hy + 7
    gl = L["glasses"]
    # 目（にこやか: 上が丸い弧の「^」ではなく、普通の黒目＋光）
    g.rect("ink", 12, ey, 2, 3); g.rect("ink", 18, ey, 2, 3)
    g.set(12, ey, "white"); g.set(18, ey, "white")
    if gl == "square":                   # 黒の太い四角い枠（ウェリントン）
        for ex in (10, 17):
            g.rect("ink", ex, ey - 1, 5, 1); g.rect("ink", ex, ey + 3, 5, 1)
            g.rect("ink", ex, ey, 1, 3); g.rect("ink", ex + 4, ey, 1, 3)
            g.rect("ink", ex + 1, ey - 1, 3, 1)
        g.rect("ink", 15, ey, 2, 1)
        g.set(9, ey, "ink"); g.set(22, ey, "ink")                    # つる
        g.set(13, ey + 2, "ice"); g.set(19, ey + 2, "ice")
    elif gl == "round":                  # 細い灰色の丸い枠
        for ex in (11, 17):
            g.rect("gray", ex, ey - 1, 4, 1); g.rect("gray", ex, ey + 3, 4, 1)
            g.rect("gray", ex - 1, ey, 1, 3); g.rect("gray", ex + 4, ey, 1, 3)
        g.rect("gray", 15, ey, 2, 1)
        g.set(9, ey, "gray"); g.set(22, ey, "gray")
    else:
        g.rect("pink", 10, ey + 3, 2, 1); g.rect("pink", 20, ey + 3, 2, 1)
        g.rect("hairR", 11, ey - 2, 3, 1); g.rect("hairR", 18, ey - 2, 3, 1)  # 眉（髪の色）
    bd = L["beard"]
    my = ey + 5
    if bd == "stubble":
        g.rect("black", 13, my - 1, 6, 1); g.set(12, my, "black"); g.set(19, my, "black")  # 口ひげ
        g.rect("redD", 14, my, 4, 1); g.rect("white", 15, my, 2, 1)                       # 笑った口
        g.pts("grayD", [(11, my + 1), (13, my + 2), (15, my + 2), (17, my + 2), (19, my + 2), (20, my + 1), (14, my + 3), (16, my + 3), (18, my + 3), (12, my + 2)])
    elif bd == "mustache":
        g.rect("black", 13, my - 1, 6, 1); g.set(12, my, "black"); g.set(19, my, "black")
        g.rect("redD", 14, my, 4, 1); g.rect("white", 15, my, 2, 1)
        g.rect("pink", 10, ey + 4, 1, 1); g.rect("pink", 21, ey + 4, 1, 1)
    else:
        g.rect("redD", 14, my, 4, 1); g.set(13, my - 1, "redD"); g.set(18, my - 1, "redD"); g.rect("white", 15, my, 2, 1)
        if gl:                                                       # ひげなしの眼鏡: 口の下側（開いた笑顔）とほお
            g.rect("redD", 15, my + 1, 2, 1)
            g.rect("pink", 10, ey + 4, 2, 1); g.rect("pink", 20, ey + 4, 2, 1)
    # 持ち物（右手）
    it = L["item"]; hx, hy2 = 22, y0 + 4
    if it == "camera":
        g.rect("ink", hx, hy2 - 1, 8, 5); g.rect("grayD", hx + 1, hy2, 6, 3); g.rect("ink", hx + 3, hy2, 3, 3)
        g.set(hx + 4, hy2 + 1, "sky"); g.set(hx + 1, hy2, "grayL"); g.set(hx + 6, hy2 - 2, "red")
        g.rect("grayD", hx + 1, hy2 - 2, 2, 1)
    elif it == "mic":                    # ハンドマイク
        g.rect("gray", hx + 1, hy2 - 6, 4, 4); g.rect("grayL", hx + 1, hy2 - 6, 2, 2); g.set(hx + 4, hy2 - 3, "grayD")
        g.rect("black", hx + 2, hy2 - 2, 2, 5); g.rect("grayD", hx + 2, hy2 + 3, 2, 1)
    elif it == "laptop":                 # 閉じた MacBook（銀、ロゴは描かない）
        g.rect("grayL", hx - 1, hy2 - 1, 8, 2); g.rect("gray", hx - 1, hy2 + 1, 8, 1); g.rect("white", hx, hy2 - 1, 6, 1)
        g.rect("skin", hx, hy2 + 2, 2, 1)
    elif it == "pad":                    # ゲームのコントローラー
        g.rect("grayL", hx, hy2 - 1, 9, 5); g.rect("grayL", hx - 1, hy2, 11, 3)
        g.rect("ink", hx + 1, hy2 + 1, 3, 1); g.rect("ink", hx + 2, hy2, 1, 3)
        g.set(hx + 6, hy2 + 1, "red"); g.set(hx + 7, hy2, "red"); g.rect("gray", hx + 4, hy2 + 3, 2, 1)
    return g.outline()


# ---------------- ビーグル（前の試作のまま＋座り） ----------------
def beagle16(pose):
    g = Img(16, 16)
    if pose == "sit":
        by = 7
        g.rect("tan", 4, by + 1, 6, 6); g.rect("tan", 3, by + 4, 3, 3)        # 腰を落とした胴
        g.rect("black", 4, by + 1, 3, 3)                                       # 鞍
        g.rect("white", 8, by + 3, 3, 4); g.rect("white", 3, by + 7, 4, 1); g.rect("white", 8, by + 7, 4, 1)  # 胸・足
        g.rect("tan", 2, by + 2, 1, 3); g.set(1, by + 1, "white")              # しっぽ
        g.rect("tan", 8, by - 4, 5, 5); g.rect("white", 11, by - 1, 3, 2); g.set(13, by - 1, "ink"); g.set(11, by - 3, "ink")
        g.set(10, by - 4, "white")
        g.rect("brownD", 8, by - 3, 2, 5)
        return g.outline()
    up = {"run1": -1}.get(pose, 0)
    by = 8 + up
    if pose == "run1":
        g.pts("white", [(3, by + 5), (2, by + 6), (11, by + 5), (12, by + 6)])
    else:
        g.rect("white", 4, by + 5, 1, 2); g.rect("white", 6, by + 5, 1, 2); g.rect("white", 9, by + 5, 1, 2); g.rect("white", 11, by + 5, 1, 2)
    g.rect("tan", 3, by, 9, 5); g.rect("black", 5, by, 6, 2); g.rect("white", 4, by + 4, 7, 1)
    g.rect("tan", 2, by - 2, 1, 3); g.set(1, by - 3, "white")
    g.rect("tan", 10, by - 4, 4, 5); g.rect("white", 12, by - 1, 3, 2); g.set(14, by - 1, "ink"); g.set(12, by - 3, "ink")
    g.rect("brownD", 10, by - 3, 2, 5 + (1 if pose == "run2" else 0))
    return g.outline()


def beagle32():
    g = Img(32, 32)
    by = 15
    g.rect("white", 7, by + 7, 3, 5); g.rect("white", 11, by + 7, 2, 5)
    g.rect("white", 18, by + 7, 3, 5); g.rect("white", 21, by + 7, 2, 5)
    g.rect("tan", 6, by, 18, 8); g.rect("tan", 5, by + 1, 20, 6)
    g.rect("black", 9, by - 1, 11, 4); g.rect("black", 8, by, 13, 3)
    g.rect("white", 18, by + 4, 6, 4); g.rect("white", 8, by + 6, 10, 2)
    ty = by - 6
    g.rect("tan", 4, by - 2, 2, 3); g.rect("tan", 3, ty + 2, 2, 3); g.rect("white", 2, ty, 2, 3)
    hx, hy = 19, by - 10
    g.rect("tan", hx, hy + 2, 10, 9); g.rect("tan", hx + 1, hy + 1, 8, 11)
    g.rect("white", hx + 4, hy + 1, 2, 5)
    g.rect("white", hx + 6, hy + 7, 6, 4); g.rect("white", hx + 5, hy + 8, 7, 3)
    g.rect("ink", hx + 10, hy + 7, 2, 2)
    g.rect("ink", hx + 7, hy + 4, 2, 2); g.set(hx + 7, hy + 4, "white")
    g.rect("redD", hx + 7, hy + 10, 3, 1); g.set(hx + 9, hy + 11, "pink")
    g.rect("brownD", hx + 1, hy + 3, 4, 8); g.rect("brownD", hx + 2, hy + 11, 2, 1)
    return g.outline()


# =====================================================================================
# 障害物・アイテム・背景
# =====================================================================================
def xlr():
    """32x16 床をうねる XLR ケーブル（低い。上の 9 段は空き）。"""
    g = Img(32, 16)
    ys = [13, 13, 12, 12, 11, 11, 11, 12, 12, 13, 13, 13, 12, 11, 11, 10, 10, 10, 11, 12, 13, 13, 13, 12, 12, 11, 11]
    for i, y in enumerate(ys):
        x = 3 + i
        g.rect("black", x, y, 1, 2); g.set(x, y, "grayD")
    # 両端のコネクタ（銀）
    g.rect("grayL", 0, 11, 3, 3); g.rect("gray", 0, 13, 3, 1); g.set(0, 12, "ink"); g.set(1, 12, "ink")
    g.rect("grayL", 29, 11, 3, 3); g.rect("gray", 29, 13, 3, 1); g.rect("ink", 31, 12, 1, 1)
    g.rect("grayD", 1, 12, 1, 1)
    o = g.outline()
    return o


def micstand():
    """16x32 高いマイクスタンド（ブーム付き）。"""
    g = Img(16, 32)
    g.rect("grayD", 7, 8, 2, 20)                                     # 支柱
    g.rect("gray", 7, 8, 1, 20)
    g.rect("grayD", 6, 17, 4, 1)                                     # ねじ
    g.pts("grayD", [(6, 28), (5, 29), (4, 30), (9, 28), (10, 29), (11, 30)]); g.rect("grayD", 7, 28, 2, 3)  # 三脚
    g.pts("gray", [(3, 30), (12, 30)])
    for i in range(6):                                               # ブーム
        g.set(8 + i, 8 - i // 2, "grayD")
    g.rect("gray", 11, 1, 4, 5); g.rect("grayL", 12, 1, 2, 4); g.pts("grayD", [(11, 3), (14, 3)])  # マイク
    g.rect("black", 12, 6, 2, 1)
    for y in range(7, 28, 3):                                        # 支柱に巻いたケーブル
        g.set(9, y, "black")
    return g.outline()


def box():
    """16x16 段ボール 1 箱（積み重ね用。上下は縁取りで区切れる）。"""
    g = Img(16, 16)
    g.rect("woodL", 1, 1, 14, 14); g.rect("tan", 1, 11, 14, 4)
    g.rect("wood", 1, 14, 14, 1)
    g.rect("lemon", 7, 1, 2, 6); g.rect("cream", 7, 1, 1, 6)        # ガムテープ
    g.rect("woodD", 1, 4, 14, 1)                                     # ふたの合わせ目
    g.pts("woodD", [(3, 8), (4, 8), (5, 8), (3, 9)])                 # 「天地」っぽい印（文字は描かない）
    g.rect("amberD", 10, 9, 3, 2); g.set(11, 9, "lemon")             # ラベル
    g = g.outline()
    return g


def bill():
    """16x16 落ちてくる請求書（少し傾いた紙）。"""
    g = Img(16, 16)
    rows = [(4, 10), (4, 10), (3, 10), (3, 10), (3, 10), (2, 10), (2, 10), (2, 10), (1, 10), (1, 10), (1, 10), (1, 10)]
    for i, (x, w) in enumerate(rows):
        g.rect("paper", x + 1, 2 + i, w, 1)
    g.pts("grayL", [(13, 3), (14, 4)])                               # 折れ
    for y, x0, w in ((4, 5, 5), (6, 4, 7), (8, 3, 4), (10, 3, 6)):
        g.rect("gray", x0 + 1, y, w, 1)
    g.rect("red", 8, 9, 4, 3); g.set(9, 10, "paper"); g.set(10, 10, "paper")  # 赤い判（請求）
    g.rect("redD", 8, 12, 4, 1)
    return g.outline()


def deadline():
    """16x16 タイル: 後ろから迫る締め切りの壁。赤と暗い赤の斜めじま＋点滅しそうな黄の点。縦横につながる。"""
    g = Img(16, 16)
    for y in range(16):
        for x in range(16):
            g.set(x, y, "red" if ((x + y) // 4) % 2 == 0 else "redD")
    for y in range(16):                                              # しまの境目に明るい線
        for x in range(16):
            if (x + y) % 8 == 0:
                g.set(x, y, "pink")
    g.pts("lemon", [(3, 3), (11, 11)])
    g.pts("ink", [(0, 0), (8, 8)])
    return g


def sdcard():
    g = Img(12, 12)
    g.rect("blue", 2, 1, 8, 10); g.set(9, 1, None); g.set(8, 1, None); g.set(9, 2, None)  # 右上の切り欠き
    g.rect("navy", 2, 9, 8, 2)
    g.pts("amber", [(3, 1), (5, 1), (7, 1)]); g.pts("amberD", [(3, 2), (5, 2), (7, 2)])  # 端子
    g.rect("white", 3, 5, 6, 3); g.rect("red", 3, 5, 6, 1)           # ラベル
    g.set(9, 7, "sky")
    return g.outline()


def coffee():
    g = Img(12, 12)
    g.pts("grayL", [(4, 0), (5, 1), (7, 0), (6, 1)])                 # 湯気
    g.rect("white", 2, 3, 7, 7); g.rect("woodD", 3, 3, 5, 1)         # カップとコーヒー
    g.rect("woodL", 2, 5, 7, 3); g.rect("wood", 2, 7, 7, 1)          # スリーブ
    g.rect("cream", 3, 9, 5, 1)
    g.pts("white", [(9, 4), (10, 5), (10, 6), (9, 7)])               # 取っ手
    return g.outline()


def reclamp():
    g = Img(12, 12)
    g.rect("red", 3, 1, 6, 8); g.rect("red", 2, 2, 8, 6)
    g.rect("pink", 4, 2, 2, 2); g.set(4, 2, "white")                 # 光
    g.rect("redD", 3, 7, 6, 1)
    g.rect("grayD", 2, 9, 8, 2); g.rect("gray", 3, 9, 6, 1)          # 台
    return g.outline()


def money():
    """お金袋（¥ は描くが文字ではなく記号）。"""
    g = Img(12, 12)
    g.rect("tan", 4, 1, 4, 1); g.rect("brownD", 4, 2, 4, 1)          # 口
    g.rect("woodL", 3, 3, 6, 1); g.rect("woodL", 2, 4, 8, 6); g.rect("woodL", 3, 10, 6, 1)
    g.rect("tan", 2, 8, 8, 2); g.rect("tan", 3, 10, 6, 1)
    g.set(3, 4, "lemon")
    yen = [(4, 4), (8, 4), (5, 5), (7, 5), (6, 6), (5, 7), (6, 7), (7, 7), (6, 8), (5, 9), (6, 9), (7, 9)]
    g.pts("amber", yen); g.pts("amberD", [(6, 8)])
    g.set(4, 4, "amberD"); g.set(8, 4, "amberD")
    return g.outline()


def floor():
    """16x16 木の床（部室の床と同じ色。横につながる）。"""
    g = Img(16, 16)
    g.rect("woodL", 0, 0, 16, 2); g.rect("amberD", 0, 0, 16, 1)
    g.rect("wood", 0, 2, 16, 14)
    for i in range(1, 4):
        g.rect("woodD", 0, 2 + i * 4, 16, 1)
    g.rect("woodD", 7, 2, 1, 4); g.rect("woodD", 15, 6, 1, 4); g.rect("woodD", 3, 10, 1, 4); g.rect("woodD", 11, 14, 1, 2)
    g.pts("woodL", [(2, 4), (10, 8), (13, 12), (5, 15)])
    return g


def city(seed, far):
    """64x48 夜のビル（上は透明。左右の端は空けず幅の合計を 64 にして横に繰り返せる）。"""
    import random
    rnd = random.Random(seed)
    W, H = 64, 48
    g = Img(W, H)
    widths = [12, 10, 14, 8, 12, 8] if far else [16, 12, 20, 16]
    rnd.shuffle(widths)
    assert sum(widths) == W
    body, edge = ("violet", "plum") if far else ("plum", "ink")
    x = 0
    for w in widths:
        h = rnd.randint(18, 40) if far else rnd.randint(16, 34)
        top = H - h
        g.rect(body, x, top, w - 1, h); g.rect(edge, x + w - 1, top, 1, h)
        if far:
            g.rect("lilac", x, top, w - 1, 1)
            for wy in range(top + 3, H - 2, 4):
                for wx in range(x + 2, x + w - 2, 3):
                    if rnd.random() < 0.3:
                        g.set(wx, wy, "lemon" if rnd.random() < .6 else "ice")
        else:
            g.rect("violet", x, top, w - 1, 1)
            for wy in range(top + 3, H - 3, 5):
                for wx in range(x + 2, x + w - 3, 4):
                    if rnd.random() < 0.45:
                        g.rect("amber" if rnd.random() < .7 else "sky", wx, wy, 2, 2)
            if rnd.random() < 0.6 and top > 6:
                ax = x + w // 2
                g.rect("grayD", ax, top - 5, 1, 5); g.set(ax, top - 6, "red")
        x += w
    return g


# =====================================================================================
POSES = ["run1", "run2", "jump", "hit"]


def build():
    S = {}
    for n, L in CAST.items():
        S[n] = {p: person16(L, p) for p in POSES}
        S[n + "_big"] = {"idle": person32(L)}
    S["beagle"] = {p: beagle16(p) for p in ("run1", "run2", "sit")}
    S["beagle_big"] = {"idle": beagle32()}
    S["xlr"] = {"idle": xlr()}
    S["micstand"] = {"idle": micstand()}
    S["box"] = {"idle": box()}
    S["bill"] = {"idle": bill()}
    S["deadline"] = {"idle": deadline()}
    S["sdcard"] = {"idle": sdcard()}
    S["coffee"] = {"idle": coffee()}
    S["reclamp"] = {"idle": reclamp()}
    S["money"] = {"idle": money()}
    S["floor"] = {"idle": floor()}
    S["city1"] = {"idle": city(11, True)}
    S["city2"] = {"idle": city(23, False)}
    return S


def write_ts(S):
    lines = [
        "// gen.py から生成（手で直さない）: scripts/minigame-sprites.py",
        "// 作り直し: python3 -I scripts/minigame-sprites.py",
        "// 1 文字 = 1 ドット。\".\" は透明、\"0\"〜\"9\" と \"a\"〜\"z\" は PALETTE の索引（\"a\" = 10）。",
        "",
        "export const PALETTE: string[] = [",
    ]
    for i, (n, h) in enumerate(PAL_LIST):
        lines.append('  "%s", // %s %s' % (h, DIGITS[i], n))
    lines.append("];")
    lines.append("")
    lines.append("export const SPRITES: Record<string, { w: number; h: number; frames: Record<string, string[]> }> = {")
    for name, frames in S.items():
        f0 = next(iter(frames.values()))
        lines.append("  %s: {" % name)
        lines.append("    w: %d," % f0.w)
        lines.append("    h: %d," % f0.h)
        lines.append("    frames: {")
        for fn, img in frames.items():
            assert (img.w, img.h) == (f0.w, f0.h)
            lines.append("      %s: [" % fn)
            for r in img.rows():
                lines.append('        "%s",' % r)
            lines.append("      ],")
        lines.append("    },")
        lines.append("  },")
    lines.append("};")
    os.makedirs(os.path.dirname(TS_OUT), exist_ok=True)
    with open(TS_OUT, "w") as f:
        f.write("\n".join(lines) + "\n")


# ---------------- 確認用 PNG ----------------
def sheet(S, out):
    K = 4
    W = 900
    blocks = []  # (label, [(framename, img)])
    for n in ("drikin", "matsuo", "zenji", "beagle"):
        fr = [("idle 32", S[n + "_big"]["idle"])] + [(k, v) for k, v in S[n].items()]
        blocks.append((n, fr))
    blocks.append(("obstacles", [(k, S[k]["idle"]) for k in ("xlr", "micstand", "box", "bill", "deadline")]))
    blocks.append(("items", [(k, S[k]["idle"]) for k in ("sdcard", "coffee", "reclamp", "money")]))
    blocks.append(("bg", [(k, S[k]["idle"]) for k in ("floor", "city1", "city2")]))
    # レイアウト計算
    y = 44
    places = []
    for label, frames in blocks:
        x = 20; rowh = 0; items = []
        for fn, img in frames:
            w, h = img.w * K, img.h * K
            if x + w > W - 20:
                x = 20; y += rowh + 28; rowh = 0
            items.append((fn, img, x, y + 22)); x += w + 24; rowh = max(rowh, h)
        places.append((label, y, items)); y += rowh + 22 + 34
    H = y + 70
    s = Img(W, H, "night")
    text(s, "SHIMEKIRI DASH  SPRITES X4", 16, 12, "amber", 3)
    for label, by, items in places:
        text(s, label, 20, by, SHEET_COLOR.get(label, "lilac"), 3)
        for fn, img, x, y2 in items:
            s.rect("plum", x - 2, y2 - 2, img.w * K + 4, img.h * K + 4)
            s.blit(img, x, y2, K)
            text(s, fn, x, y2 + img.h * K + 6, "gray", 2)
    # 床と遠景の並べ確認（横につながるか）: 実寸×2 で 2 回ずつ並べる
    k2 = 2; strip = Img(256, 48 + 16)
    for i in range(4):
        strip.blit(S["city1"]["idle"], i * 64, 0)
    for i in range(4):
        strip.blit(S["city2"]["idle"], i * 64 - 20, 4)
    for i in range(16):
        strip.blit(S["floor"]["idle"], i * 16, 48)
    strip.blit(S["drikin"]["run1"], 60, 32); strip.blit(S["matsuo"]["run2"], 90, 32)
    strip.blit(S["zenji"]["jump"], 120, 22); strip.blit(S["beagle"]["run1"], 30, 32)
    strip.blit(S["box"]["idle"], 170, 32); strip.blit(S["box"]["idle"], 170, 16); strip.blit(S["xlr"]["idle"], 200, 32)
    strip.blit(S["coffee"]["idle"], 150, 8)
    for yy in range(strip.h):
        for xx in range(16):
            strip.set(xx, yy, S["deadline"]["idle"].p[yy % 16][xx])
    bgs = Img(strip.w * k2, strip.h * k2, "navy")
    bgs.blit(strip, 0, 0, k2)
    H2 = H + bgs.h + 30
    s2 = Img(W, H2, "night"); s2.blit(s, 0, 0)
    text(s2, "SCENE TEST X2", 20, H - 40, "lilac", 3)
    s2.blit(bgs, 20, H - 14)
    s2.save(os.path.join(out, "dash_sheet.png"))


def compare(S, out):
    old_dir = out
    K = 4
    W, H = 3 * (32 * K + 16 * K + 60) + 40, 3 * (32 * K + 60) + 60
    s = Img(W, H, "night")
    text(s, "PROTOTYPE / PREV / NOW", 16, 12, "amber", 3)
    for i, n in enumerate(("drikin", "matsuo", "zenji")):
        x = 20 + i * (32 * K + 16 * K + 60)
        text(s, n, x, 40, SHEET_COLOR[n], 3)
        p32 = os.path.join(old_dir, "sprite_%s_32.png" % n); p16 = os.path.join(old_dir, "sprite_%s_16.png" % n)
        q32 = os.path.join(old_dir, "prev_%s_32.png" % n); q16 = os.path.join(old_dir, "prev_%s_16.png" % n)
        for row, (big, small) in enumerate([
            ((crop(load_png(p32), 0, 0, 32, 32), crop(load_png(p16), 16, 0, 16, 16)) if os.path.exists(p32) and os.path.exists(p16) else (None, None)),
            # 前回の版（scratchpad に prev_<name>_32/16.png があるときだけ）
            ((load_png(q32), crop(load_png(q16), 0, 0, 16, 16)) if os.path.exists(q32) and os.path.exists(q16) else (None, None)),
            (S[n + "_big"]["idle"], S[n]["run1"]),
        ]):
            y = 64 + row * (32 * K + 60)
            if big is None:
                text(s, "PREV: SAME AS NOW" if row == 1 else "", x, y, "gray", 2)
                continue
            text(s, ("PROTOTYPE", "PREV", "NOW")[row], x, y, "gray", 2)
            s.rect("plum", x - 2, y + 14, 32 * K + 4, 32 * K + 4)
            s.rect("plum", x + 32 * K + 14, y + 14 + 16 * K, 16 * K + 4, 16 * K + 4)
            if big is not None:
                s.blit(big, x, y + 16, K); s.blit(small, x + 32 * K + 16, y + 16 + 16 * K + 2, K)
    s.save(os.path.join(out, "dash_cast_compare.png"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "b-guru-minigame-art"), help="確認用 PNG の出力先（リポジトリの外）")
    a = ap.parse_args()
    S = build()
    write_ts(S)
    os.makedirs(a.out, exist_ok=True)
    sheet(S, a.out)
    compare(S, a.out)
    print("wrote", os.path.relpath(TS_OUT, ROOT))
    print("png  ", os.path.join(a.out, "dash_sheet.png"))
    print("png  ", os.path.join(a.out, "dash_cast_compare.png"))


if __name__ == "__main__":
    main()
