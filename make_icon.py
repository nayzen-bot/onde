# Génère onde.ico (même dessin que public/icon.svg) pour l'exécutable
from PIL import Image, ImageDraw

S = 1024
k = S / 512
grad = Image.new('RGB', (S, S))
a, b = (0x7c, 0x5c, 0xff), (0xff, 0x4f, 0xa3)
px = grad.load()
for y in range(S):
    for x in range(S):
        t = (x + y) / (2 * S - 2)
        px[x, y] = tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(120 * k), fill=255)
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)
for x, y, h in [(100, 196, 120), (168, 146, 220), (236, 106, 300), (304, 156, 200), (372, 201, 110)]:
    d.rounded_rectangle((x * k, y * k, (x + 40) * k, (y + h) * k), radius=int(20 * k), fill='white')

img.save('onde.ico', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
img.resize((256, 256), Image.LANCZOS).save('public/icon.png')  # icône de la zone de notification
print('onde.ico + public/icon.png ok')
