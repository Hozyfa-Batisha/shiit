import sys
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

SRC, OUT = sys.argv[1], sys.argv[2]
INK = np.array([0x15, 0x13, 0x0f], float)
YELLOW = np.array([255, 214, 10], float)
PAPER = (0xf1, 0xed, 0xe2)

lum = np.array(Image.open(SRC).convert('L'), float)
ink_a = np.clip((255 - lum) / (255.0 - 45.0), 0, 1)

# remove stray specks (the source has a tiny dot near the double-i)
binary = lum < 128
lab, n = ndi.label(binary)
sizes = ndi.sum(binary, lab, range(1, n + 1))
print('ink components:', sorted(int(s) for s in sizes))
for i, s in enumerate(sizes, 1):
    if s < 500:
        speck = ndi.binary_dilation(lab == i, iterations=4)
        ink_a[speck] = 0

# inside of the bulb = everything not reachable from the image border without crossing ink
nonink = ink_a < 0.5
lab2, _ = ndi.label(nonink)
inside = lab2 != lab2[0, 0]
inside |= (ink_a >= 0.5)  # ink itself, so the fill sits under the strokes
# but ink that belongs to the outside world (nothing here, thread rings etc.) keeps fill underneath: harmless, covered by ink

fill_a = inside.astype(float)
out_a = ink_a + fill_a * (1 - ink_a)
rgb = np.zeros(lum.shape + (3,))
num = INK * ink_a[..., None] + YELLOW * (fill_a * (1 - ink_a))[..., None]
mask = out_a > 0
rgb[mask] = num[mask] / out_a[mask][:, None]
rgba = np.dstack([rgb, out_a * 255]).clip(0, 255).astype(np.uint8)
img = Image.fromarray(rgba, 'RGBA')

# crop to content, square with a little breathing room
bbox = img.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
img = img.crop(bbox)
side = int(max(img.size) * 1.04)
sq = Image.new('RGBA', (side, side), (0, 0, 0, 0))
sq.paste(img, ((side - img.width) // 2, (side - img.height) // 2), img)
logo = sq.resize((512, 512), Image.LANCZOS)
logo.save(f'{OUT}/logo.png', optimize=True)

def icon(size, name, scale=0.74):
    tile = Image.new('RGBA', (size, size), PAPER + (255,))
    s = int(size * scale)
    l = sq.resize((s, s), Image.LANCZOS)
    tile.paste(l, ((size - s) // 2, (size - s) // 2), l)
    tile.convert('RGB').save(f'{OUT}/{name}', optimize=True)

icon(512, 'icon-512.png')
icon(192, 'icon-192.png')
icon(180, 'apple-touch-icon.png')
icon(64, 'favicon.png', 0.9)
print('done', logo.size)
