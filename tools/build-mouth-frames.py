# build-mouth-frames.py —— 把抽好的 PNG 帧抠成透明底、缩到 320、存 WebP
#
# 背景是剪辑软件留下的「透明棋盘格」：两种中性灰（约 193 和 215）。
# 抠法：中性灰（三通道最大差<=12）且在 [185,228] 亮度区间 → 候选背景；
#       再从画框边缘洪水填充，只吃掉和边界连通的部分（鲸鱼身上的灰不会误伤）。
import glob
import os
import sys

import numpy as np
from PIL import Image

SRC = r"C:\Users\35023\.dsh\whale-overlay\mouth-raw"
DST = r"C:\Users\35023\.dsh\whale-overlay\mouth-frames"
SIZE = 320

LUMA_MIN, LUMA_MAX = 185, 235
NEUTRAL_TOL = 12


def flood_from_border(candidate: np.ndarray) -> np.ndarray:
    """从画框一圈出发，吃掉所有连通的候选背景像素。"""
    h, w = candidate.shape
    reach = np.zeros_like(candidate)
    reach[0, :] = candidate[0, :]
    reach[-1, :] = candidate[-1, :]
    reach[:, 0] |= candidate[:, 0]
    reach[:, -1] |= candidate[:, -1]
    while True:
        grow = np.zeros_like(reach)
        grow[1:, :] |= reach[:-1, :]
        grow[:-1, :] |= reach[1:, :]
        grow[:, 1:] |= reach[:, :-1]
        grow[:, :-1] |= reach[:, 1:]
        nxt = reach | (grow & candidate)
        if nxt.sum() == reach.sum():
            return reach
        reach = nxt


def main() -> int:
    files = sorted(glob.glob(os.path.join(SRC, "frame-*.png")))
    if not files:
        print("没有找到帧，先跑 extract-frames.js")
        return 1
    os.makedirs(DST, exist_ok=True)
    # 清掉旧帧，避免帧数变化后残留
    for old in glob.glob(os.path.join(DST, "*.webp")):
        os.remove(old)

    total_bg = 0.0
    for i, fp in enumerate(files):
        im = Image.open(fp).convert("RGB")
        a = np.asarray(im).astype(np.int16)
        luma = a @ np.array([0.299, 0.587, 0.114])
        neutral = (a.max(axis=2) - a.min(axis=2)) <= NEUTRAL_TOL
        candidate = neutral & (luma >= LUMA_MIN) & (luma <= LUMA_MAX)
        # 第一道：从边框连通的部分（整块背景）
        bg = flood_from_border(candidate)
        # 第二道：被鲸鱼包住、没连到边框的残余灰（用户看到的那一小块）
        #   仅清掉候选灰，鲸鱼是蓝/白（白 >228 不入选），不会被误伤
        bg = bg | candidate
        total_bg += bg.mean()

        rgba = np.dstack([a.astype(np.uint8), np.full(a.shape[:2], 255, dtype=np.uint8)])
        rgba[bg, 3] = 0
        out = Image.fromarray(rgba, "RGBA").resize((SIZE, SIZE), Image.LANCZOS)
        out.save(os.path.join(DST, "f%02d.webp" % i), "WEBP", quality=88, method=4)
        if i % 8 == 0:
            print("帧 %02d: 抠掉 %.1f%%" % (i, bg.mean() * 100))

    print("完成: %d 帧 -> %s（平均抠掉 %.1f%%）" % (len(files), DST, total_bg / len(files) * 100))
    return 0


if __name__ == "__main__":
    sys.exit(main())
