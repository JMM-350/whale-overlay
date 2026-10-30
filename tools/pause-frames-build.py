# pause-frames-build.py —— 暂停视频 → 48 帧 WebP（320x320，透明背景）
#   视频是绿幕：鱼（蓝）几乎占满画面，左边/左上角是渐变绿背景。
#   判定用「绿度 = G - max(R,B)」：>0 偏绿 → 抠成透明；0~9 之间做软边。
#   用法: python pause-frames-build.py <视频路径> [输出目录]
import sys, os
import numpy as np
from PIL import Image
import av

COUNT = 48
SIZE = 320
args = [a for a in sys.argv[1:] if not a.startswith('--')]
SRC = args[0]
OUT = args[1] if len(args) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pause-frames')

SOFT = 9.0


def make_alpha(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    green = g - np.maximum(r, b)
    return np.clip(255.0 * (1.0 - green / SOFT), 0, 255).astype(np.uint8)


def main():
    os.makedirs(OUT, exist_ok=True)
    c = av.open(SRC)
    s = c.streams.video[0]
    dur = float(s.duration * s.time_base) if s.duration else float(c.duration / av.time_base)
    targets = [dur * i / (COUNT - 1) * 0.995 for i in range(COUNT)]

    picked = {}
    for frame in c.decode(s):
        t = float(frame.pts * s.time_base) if frame.pts is not None else 0.0
        if t > targets[-1] + 0.1:
            break
        k = round(min(targets, key=lambda w: abs(w - t)), 2)
        if k in picked or abs(k - t) > 0.06:
            continue
        picked[k] = np.asarray(frame.to_image().convert('RGB'), dtype=np.uint8)
        if len(picked) >= COUNT:
            break

    keys = sorted(picked.keys())
    h, w, _ = picked[keys[0]].shape
    print(f'解出 {len(keys)} 帧，源 {w}x{h}，{dur:.2f}s')

    alphas, x0, y0, x1, y1 = {}, 10 ** 9, 10 ** 9, -1, -1
    for k in keys:
        a = make_alpha(picked[k].astype(np.float32))
        alphas[k] = a
        ys, xs = np.where(a > 24)
        if len(xs):
            x0, x1 = min(x0, xs.min()), max(x1, xs.max())
            y0, y1 = min(y0, ys.min()), max(y1, ys.max())
    if x1 < 0:
        print('全被抠掉了，阈值反了')
        return

    side = max(x1 - x0 + 1, y1 - y0 + 1)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    sx, sy = int(round(cx - side / 2)), int(round(cy - side / 2))
    print(f'主体框 x{x0}-{x1} y{y0}-{y1} → 正方形 {side}px @({sx},{sy})，不透明占比 {(alphas[keys[0]]>128).mean()*100:.1f}%')

    for i, k in enumerate(keys[:COUNT]):
        rgba = np.dstack([picked[k], alphas[k]]).astype(np.uint8)
        im = Image.fromarray(rgba, 'RGBA').crop((sx, sy, sx + side, sy + side)).resize((SIZE, SIZE), Image.LANCZOS)
        im.save(os.path.join(OUT, f'f{i:02d}.webp'), 'WEBP', quality=93, method=4)

    print(f'已写 {min(len(keys), COUNT)} 帧 → {OUT}')


main()
