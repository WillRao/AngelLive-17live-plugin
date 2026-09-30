#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 AngelLive 插件所需的整套平台图标（写入 assets/）。

宿主并不读 manifest 里的图标字段，而是**按固定文件名去「已安装插件目录」里找 PNG**
（见各平台 PlatformIconProvider）。所以这些文件必须打进 zip 的 assets/ 下，
并且文件名一个字符都不能错：

    iOS    PlatformIconProvider      assets/live_card_<id>.png        平台 tab
                                     assets/tv_<id>_big[_dark].png    配置页卡片
                                     assets/pad_live_card_<id>.png    插件管理列表
    macOS  MacPlatformIconProvider   assets/mini_live_card_<id>.png   侧边栏 tab（读后设 16pt）
                                     管理页依次回退 pad_live_card_ / live_card_ / mini_live_card_
    tvOS   TVPlatformIconProvider    assets/live_card_<id>.png        账号列表
                                     assets/tv_<id>_big|small[_dark].png  平台页大图 / 焦点叠标

`<dark>` 变体缺失时会自动回退到亮色版，但两套都给能少一层猜测。

同时索引（index.json）里的 icon / iosIcon / macosIcon / tvosIcon 四个字段也指向
assets/live_card_<id>.png —— 与官方插件源（plugins.carsonn.works）的写法保持一致。

    python3 dev/make-icons.py            # 重新生成 assets/

源图 dev/icon-source.png 是平台官方 App 图标（1024×1024，取自 App Store 公开图标资源），
仅用于标识对应平台；相关商标归各平台所有。
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow：~/.workbuddy/binaries/python/envs/default/bin/pip install Pillow")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
ASSETS = ROOT / "assets"
SOURCE = HERE / "icon-source.png"

# ---------------------------------------------------------------- 本插件的品牌配置

PLUGIN_ID = "17live"
BRAND_NAME = "17LIVE"
# 主色直接取自官方 App 图标本身（红底白字「17」）
PRIMARY = (255, 0, 0)
DEEP = (138, 0, 10)
# 平台卡底色：刻意压到比图标本身深一档，否则「同色贴同色」在卡上看不出图标边界。
BANNER_DEEP = (56, 0, 6)
BANNER_LIGHT = (178, 0, 20)

# 圆角比例（占边长）。官方插件源里的图标是圆形/异形马克，我们用平台自己的
# 方形 App 图标——圆角方块在小尺寸下色块面积最大，最能看清，也最像 App 图标。
TILE_RADIUS = 0.225

ICON_PX = 128          # 官方插件源里 live_card_*.png 就是 128×128
BANNER_PX = (740, 444)  # tvOS 平台卡是 370×222pt，按 @2x 出图


# ---------------------------------------------------------------- 工具

def _tile(src: Image.Image, size: int) -> Image.Image:
    """方形源图 → 圆角方块（超采样画蒙版，边角才不会毛）。"""
    im = src.resize((size, size), Image.LANCZOS)
    ss = 8
    mask = Image.new("L", (size * ss, size * ss), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size * ss - 1, size * ss - 1],
        radius=int(size * ss * TILE_RADIUS),
        fill=255,
    )
    mask = mask.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out


def _mix(a, b, t: float):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _diagonal(size, c0, c1) -> Image.Image:
    """135° 线性渐变（沿 x+y 方向），用于平台卡底色。"""
    w, h = size
    g = Image.new("RGB", size, c0)
    d = ImageDraw.Draw(g)
    total = (w - 1) + (h - 1)
    for i in range(total + 1):
        t = i / total
        x0, x1 = max(0, i - h + 1), min(w - 1, i)
        d.line([(x0, i - x0), (x1, i - x1)], fill=_mix(c0, c1, t))
    return g


def _radial(size, strength: float, center=(0.78, 0.30), radius=1.15) -> Image.Image:
    """一张白色柔光蒙版，叠在渐变上做一点点聚光，免得整块平。"""
    w, h = size
    cx, cy = center[0] * w, center[1] * h
    r = radius * max(w, h)
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    steps = 48
    for i in range(steps, 0, -1):
        t = i / steps
        rr = r * t
        v = int(255 * strength * (1 - t) ** 1.6)
        d.ellipse([cx - rr, cy - rr * 0.75, cx + rr, cy + rr * 0.75], fill=v)
    return m


def _soft_shadow(shape: Image.Image, blur: int, offset=(0, 10), alpha=110) -> Image.Image:
    """按图形的 alpha 轮廓做一张柔光投影，四周留出 blur 的余量。"""
    pad = blur * 2
    silhouette = Image.new("RGBA", shape.size, (0, 0, 0, 255))
    silhouette.putalpha(shape.getchannel("A").point(lambda v: v * alpha // 255))
    canvas = Image.new("RGBA", (shape.width + pad * 2, shape.height + pad * 2), (0, 0, 0, 0))
    canvas.paste(silhouette, (pad + offset[0], pad + offset[1]), silhouette)
    return canvas.filter(ImageFilter.GaussianBlur(blur))


def _fit_mark(mark: Image.Image, box_w: int, box_h: int) -> Image.Image:
    side = min(box_w, box_h)
    return mark.resize((side, side), Image.LANCZOS)


def _banner(mark: Image.Image, dark: bool, variant: str) -> Image.Image:
    """tvOS 平台页大图 / 焦点叠标。

    big   焦点之外显示：整块品牌色 + 右侧大 logo，够醒目。
    small 焦点之内叠在 big（已模糊）之上、且会被描述文字压住：
          做成压暗的品牌色渐层 + 右侧极淡水印，保证文字读得清。
    """
    w, h = BANNER_PX
    if variant == "big":
        c0 = _mix(BANNER_DEEP, (0, 0, 0), 0.26 if dark else 0.0)
        c1 = _mix(BANNER_LIGHT, (0, 0, 0), 0.20 if dark else 0.0)
        img = _diagonal((w, h), c0, c1).convert("RGBA")
        img.alpha_composite(Image.merge("RGBA", (
            Image.new("L", (w, h), 255),
            Image.new("L", (w, h), 255),
            Image.new("L", (w, h), 255),
            _radial((w, h), 0.30 if dark else 0.42),
        )))
        side = int(h * 0.50)
        m = _fit_mark(mark, side, side)
        pos = (int(w * 0.70) - m.width // 2, (h - m.height) // 2)
        shadow = _soft_shadow(m, blur=18, offset=(0, 12), alpha=120)
        img.alpha_composite(shadow, (pos[0] - 36, pos[1] - 36))
        img.alpha_composite(m, pos)
        return img

    # small：整块压暗，logo 放大后出血到右边缘，只当纹理用 —— 上面还要压一行描述文字。
    base = _mix(BANNER_DEEP, (0, 0, 0), 0.42 if dark else 0.18)
    top = _mix(base, (255, 255, 255), 0.05)
    img = Image.new("RGBA", (w, h))
    pen = ImageDraw.Draw(img)
    for y in range(h):
        pen.line([(0, y), (w, y)], fill=_mix(top, base, y / (h - 1)) + (255,))
    img.alpha_composite(Image.merge("RGBA", (
        Image.new("L", (w, h), 255),
        Image.new("L", (w, h), 255),
        Image.new("L", (w, h), 255),
        _radial((w, h), 0.20 if dark else 0.26, center=(0.12, 0.10), radius=1.30),
    )))
    side = int(h * 1.45)
    m = _fit_mark(mark, side, side)
    watermark = Image.new("RGBA", m.size, (255, 255, 255, 0))
    watermark.paste(Image.new("RGBA", m.size, (255, 255, 255, 255)), (0, 0),
                    m.getchannel("A").point(lambda v: v * 9 // 100))
    img.alpha_composite(watermark, (int(w * 0.93) - m.width // 2, (h - m.height) // 2))
    return img


# ---------------------------------------------------------------- 主流程

def main() -> int:
    if not SOURCE.exists():
        print(f"缺少源图：{SOURCE.relative_to(ROOT)}", file=sys.stderr)
        return 1

    src = Image.open(SOURCE).convert("RGBA")
    if src.width != src.height:
        print(f"源图必须是正方形，当前 {src.width}×{src.height}", file=sys.stderr)
        return 1
    if src.width < ICON_PX * 2:
        print(f"源图太小（{src.width}px），至少要 {ICON_PX * 2}px", file=sys.stderr)
        return 1

    if not ASSETS.exists():
        ASSETS.mkdir(parents=True)
    tile = _tile(src, ICON_PX)

    outputs: list[tuple[str, Image.Image]] = [
        # 主图标：iOS tab / tvOS 账号列表 / macOS 管理页回退 / 索引四字段
        (f"live_card_{PLUGIN_ID}.png", tile),
        # macOS 侧边栏（读入后强制 16pt，所以给同样的 128 就够用）
        (f"mini_live_card_{PLUGIN_ID}.png", tile),
        # iOS / macOS 插件管理列表
        (f"pad_live_card_{PLUGIN_ID}.png", tile),
        # tvOS 平台页
        (f"tv_{PLUGIN_ID}_big.png", _banner(tile, dark=False, variant="big")),
        (f"tv_{PLUGIN_ID}_big_dark.png", _banner(tile, dark=True, variant="big")),
        (f"tv_{PLUGIN_ID}_small.png", _banner(tile, dark=False, variant="small")),
        (f"tv_{PLUGIN_ID}_small_dark.png", _banner(tile, dark=True, variant="small")),
    ]

    print(f"\n{BRAND_NAME}（pluginId={PLUGIN_ID}）图标生成：\n")
    for name, image in outputs:
        path = ASSETS / name
        image.save(path, "PNG", optimize=True)
        raw = path.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()[:12]
        print(f"  {name:34s} {image.width:>4}×{image.height:<4} "
              f"{len(raw) / 1024:>6.1f} KB  {digest}")

    total = sum((ASSETS / n).stat().st_size for n, _ in outputs)
    print(f"\n  {len(outputs)} 个文件，合计 {total / 1024:.1f} KB → "
          f"{ASSETS.relative_to(ROOT)}/\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
