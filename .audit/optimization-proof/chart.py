"""Draw observed counts from results.txt. Requires Pillow; no timing data."""
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

folder = Path(__file__).resolve().parent
lines = (folder / 'results.txt').read_text().splitlines()
counts = [json.loads(next(line for line in lines if line.startswith(prefix)).split(': ', 1)[1])
          for prefix in ['Expiration reads (', 'Locale calls (']]
image = Image.new('RGB', (1100, 640), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.load_default(size=21)
small = ImageFont.load_default(size=17)
draw.text((35, 25), 'Instrumented work, not elapsed time', fill='black', font=ImageFont.load_default(size=30))
draw.text((35, 80), 'Observed calls / getter reads; linear scale, 0 to 1000', fill='black', font=font)
for group, (label, values) in enumerate(zip(['Expiration reads', 'Locale calls'], counts)):
    y = 145 + group * 185
    draw.text((35, y), label, fill='black', font=font)
    for index, (version, color) in enumerate([('Baseline', '#53677d'), ('Optimized', '#087f70')]):
        row = y + 38 + index * 48
        draw.text((35, row), version, fill='black', font=small)
        width = values[index] / 1000 * 750
        if width:
            draw.rectangle((180, row, 180 + max(width, 1), row + 28), fill=color)
        draw.text((195 + width, row), str(values[index]), fill='black', font=small)
draw.text((35, 545), 'Expiration: 1000 dimensions; first matches 5h; resetAt undefined for all.', fill='black', font=small)
draw.text((35, 575), 'Locale: 1000 formatProviderMetric calls; USD value 12.5.', fill='black', font=small)
draw.text((35, 605), 'Source: results.txt. Counts do not measure runtime speed or ICU work.', fill='black', font=small)
image.save(folder / 'operations.png')
