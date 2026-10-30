# fill-mouth-holes.py —— 把嘴巴帧里被包围的透明空洞填上（颜色取洞周围的实体像素平均，偏灰白）
#   做法：
#     1) 从画面四边泛洪：能连到边的透明 = 背景，保留
#     2) 连不到边的透明 = 洞，逐个连通块处理
#     3) 每个洞取周围 3px 环内"实体像素"的平均色来填（所以是偏灰的白，不是死白）
#   用法: python fill-mouth-holes.py [帧目录] [--dry] [--clean-white] [--radius N]
import sys, os
import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith('--')]
DRY = '--dry' in sys.argv
CLEAN_WHITE = '--clean-white' in sys.argv
PCT = 75
GRAY = None          # --gray N：直接填指定的偏白灰
for i, a in enumerate(sys.argv):
    if a == '--pct' and i + 1 < len(sys.argv):
        PCT = float(sys.argv[i + 1])
    if a == '--gray' and i + 1 < len(sys.argv):
        GRAY = int(sys.argv[i + 1])
RADIUS = 3
for i, a in enumerate(sys.argv):
    if a == '--radius' and i + 1 < len(sys.argv):
        RADIUS = int(sys.argv[i + 1])

DIR = args[0] if args else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mouth-frames')
BACKUP = DIR.rstrip('\\/') + '-backup'
SRC = BACKUP if os.path.isdir(BACKUP) else DIR      # 从备份取原图，保证可重复执行


def reachable_from_border(transparent):
    h, w = transparent.shape
    reach = np.zeros_like(transparent)
    reach[0, :] = transparent[0, :]
    reach[-1, :] = transparent[-1, :]
    reach[:, 0] |= transparent[:, 0]
    reach[:, -1] |= transparent[:, -1]
    for _ in range(h + w):
        prev = int(reach.sum())
        grow = reach.copy()
        grow[1:, :] |= reach[:-1, :]
        grow[:-1, :] |= reach[1:, :]
        grow[:, 1:] |= reach[:, :-1]
        grow[:, :-1] |= reach[:, 1:]
        reach = grow & transparent
        if int(reach.sum()) == prev:
            break
    return reach


def components(mask):
    """返回每个连通块的像素坐标列表（4 邻接）"""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    out = []
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys, xs):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        comp = []
        while stack:
            y, x = stack.pop()
            comp.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        out.append(comp)
    return out


def ring_mean(rgba, comp, radius):
    """洞周围 radius 环内实体像素的平均色"""
    h, w, _ = rgba.shape
    mask = np.zeros((h, w), dtype=bool)
    for y, x in comp:
        mask[y, x] = True
    ring = np.zeros_like(mask)
    cur = mask.copy()
    for _ in range(radius):
        grow = cur.copy()
        grow[1:, :] |= cur[:-1, :]
        grow[:-1, :] |= cur[1:, :]
        grow[:, 1:] |= cur[:, :-1]
        grow[:, :-1] |= cur[:, 1:]
        ring |= grow
        cur = grow
    ring &= ~mask
    solid = rgba[..., 3] >= 200
    sel = ring & solid
    if not sel.any():
        return None
    px = rgba[sel][:, :3].reshape(-1, 3).astype(float)
    lum = px @ np.array([0.299, 0.587, 0.114])
    thr = np.percentile(lum, PCT)
    keep = px[lum >= thr]
    return (keep if len(keep) else px).mean(axis=0)


def main():
    files = sorted(f for f in os.listdir(SRC) if f.lower().endswith('.webp'))
    if not files:
        print('没有帧:', SRC)
        return
    print('源:', SRC)

    filled_total, comp_total, colors = 0, 0, []
    for f in files:
        rgba = np.asarray(Image.open(os.path.join(SRC, f)).convert('RGBA')).copy()
        t = rgba[..., 3] < 128
        if not t.any():
            continue
        holes = t & ~reachable_from_border(t)
        if not holes.any():
            if not DRY:
                Image.fromarray(rgba, 'RGBA').save(os.path.join(DIR, f), 'WEBP', quality=93, method=4)
            continue
        for comp in components(holes):
            if GRAY is not None:
                col = np.array([float(GRAY), float(GRAY), min(255.0, GRAY + 3.0)])
            elif CLEAN_WHITE:
                col = np.array([255.0, 255.0, 255.0])
            else:
                m = ring_mean(rgba, comp, RADIUS)
                col = m if m is not None else np.array([246.0, 246.0, 246.0])
            col = np.clip(np.round(col), 0, 255).astype(np.uint8)
            colors.append(col.astype(float))
            for y, x in comp:
                rgba[y, x] = [col[0], col[1], col[2], 255]
            filled_total += len(comp)
            comp_total += 1
        if not DRY:
            Image.fromarray(rgba, 'RGBA').save(os.path.join(DIR, f), 'WEBP', quality=93, method=4)

    avg = np.mean(colors, axis=0).round(0) if colors else None
    print(f'处理 {len(files)} 帧，补洞 {comp_total} 处 / {filled_total} px' + ('（预演）' if DRY else ''))
    if avg is not None:
        print(f'  填充色平均 RGB = ({int(avg[0])}, {int(avg[1])}, {int(avg[2])})')


main()
