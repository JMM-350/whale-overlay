# fill-mouth-from-pause.py —— 嘴巴帧的洞，用【暂停帧同位置】的颜色来填
#   暂停帧和嘴巴帧都是 320x320，坐标一一对应；暂停的大肥鱼身上正好有想要的灰。
#   每个洞（连通块）取暂停帧同一区域里不透明像素的平均色；取不到就退到邻域灰白。
#   用法: python fill-mouth-from-pause.py [--dry]
import sys, os
import numpy as np
from PIL import Image

DRY = '--dry' in sys.argv
BASE = os.path.dirname(os.path.abspath(__file__))
MOUTH_DIR = os.path.join(BASE, 'mouth-frames')
MOUTH_SRC = os.path.join(BASE, 'mouth-frames-backup')     # 原图（带洞）
PAUSE_DIR = os.path.join(BASE, 'pause-frames')
FALLBACK = np.array([235.0, 235.0, 238.0])
LUM = np.array([0.299, 0.587, 0.114])
# 暂停帧亮部那个灰：太暗的洞统一用它，避免填出深色斑
BRIGHT = np.array([232.0, 231.0, 239.0])
MIN_LUM = 218.0


def reachable_from_border(t):
    h, w = t.shape
    r = np.zeros_like(t)
    r[0, :] = t[0, :]
    r[-1, :] = t[-1, :]
    r[:, 0] |= t[:, 0]
    r[:, -1] |= t[:, -1]
    for _ in range(h + w):
        p = int(r.sum())
        g = r.copy()
        g[1:, :] |= r[:-1, :]
        g[:-1, :] |= r[1:, :]
        g[:, 1:] |= r[:, :-1]
        g[:, :-1] |= r[:, 1:]
        r = g & t
        if int(r.sum()) == p:
            break
    return r


def components(mask):
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


def dilate(mask, n):
    cur = mask.copy()
    for _ in range(n):
        g = cur.copy()
        g[1:, :] |= cur[:-1, :]
        g[:-1, :] |= cur[1:, :]
        g[:, 1:] |= cur[:, :-1]
        g[:, :-1] |= cur[:, 1:]
        cur = g
    return cur


def main():
    files = sorted(f for f in os.listdir(MOUTH_SRC) if f.endswith('.webp'))
    if not files:
        print('没找到原图:', MOUTH_SRC)
        return
    pause_files = {}
    if os.path.isdir(PAUSE_DIR):
        for f in os.listdir(PAUSE_DIR):
            if f.endswith('.webp'):
                pause_files[f] = f
    print(f'原图 {len(files)} 帧，暂停帧 {len(pause_files)} 帧')

    total_px, total_holes, used = 0, 0, []

    for f in files:
        src = np.asarray(Image.open(os.path.join(MOUTH_SRC, f)).convert('RGBA')).copy()
        t = src[..., 3] < 128
        if not t.any():
            continue
        holes = t & ~reachable_from_border(t)
        if not holes.any():
            if not DRY:
                Image.fromarray(src, 'RGBA').save(os.path.join(MOUTH_DIR, f), 'WEBP', quality=93, method=4)
            continue

        pf = os.path.join(PAUSE_DIR, f)
        pause = None
        if os.path.exists(pf):
            pa = np.asarray(Image.open(pf).convert('RGBA'))
            if pa.shape[:2] == src.shape[:2]:
                pause = pa
        # 暂停帧整体平均色（兜底）
        pause_global = FALLBACK
        if pause is not None:
            body = pause[pause[..., 3] >= 200]
            if len(body):
                pause_global = body[:, :3].reshape(-1, 3).mean(axis=0)

        for comp in components(holes):
            col = None
            if pause is not None:
                ys = np.array([p[0] for p in comp])
                xs = np.array([p[1] for p in comp])
                vals = pause[ys, xs]
                pick = vals[vals[:, 3] >= 200]
                if len(pick) >= 2:
                    # 用中位数：不被洞边的深色描边拉低，取到的是鱼身上的灰
                    col = np.median(pick[:, :3].astype(float), axis=0)
                else:
                    # 洞的位置在暂停帧上是空的：往外扩几圈找实体像素
                    m = np.zeros(holes.shape, dtype=bool)
                    m[ys, xs] = True
                    ring = dilate(m, 4) & ~m & (pause[..., 3] >= 200)
                    if ring.any():
                        col = np.median(pause[ring][:, :3].astype(float), axis=0)
            if col is None:
                col = pause_global
            if float(np.dot(np.asarray(col, dtype=float), LUM)) < MIN_LUM:
                col = BRIGHT
            col = np.clip(np.round(col), 0, 255).astype(np.uint8)
            used.append(col.astype(float))
            for y, x in comp:
                src[y, x] = [col[0], col[1], col[2], 255]
            total_px += len(comp)
            total_holes += 1

        if not DRY:
            Image.fromarray(src, 'RGBA').save(os.path.join(MOUTH_DIR, f), 'WEBP', quality=93, method=4)

    avg = np.median(np.array(used), axis=0).round(0) if used else None
    print(f'补洞 {total_holes} 处 / {total_px} px' + ('（预演）' if DRY else ''))
    if avg is not None:
        print(f'  取自暂停帧的颜色平均 RGB = ({int(avg[0])}, {int(avg[1])}, {int(avg[2])})')


main()
