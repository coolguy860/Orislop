from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageEnhance, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
ICON_ROOT = ROOT / "apps" / "extension" / "src" / "icons"
MASTER = ROOT / "assets" / "brand" / "icon_512.png"
SIZES = (16, 32, 48, 128, 256)


def prepare_master() -> Image.Image:
    if not MASTER.is_file():
        raise FileNotFoundError(f"Missing Orislop shield master: {MASTER}")
    image = Image.open(MASTER).convert("RGBA")
    side = min(image.size)
    left = (image.width - side) // 2
    top = (image.height - side) // 2
    return image.crop((left, top, left + side, top + side))


def generate_icon(master: Image.Image, size: int) -> None:
    sampling_size = max(size * 4, 256)
    icon = master.resize((sampling_size, sampling_size), Image.Resampling.LANCZOS)
    if size <= 48:
        icon = ImageEnhance.Contrast(icon).enhance(1.1)
        icon = ImageEnhance.Color(icon).enhance(1.08)
        icon = icon.filter(ImageFilter.UnsharpMask(radius=1.1, percent=145, threshold=3))
    icon = icon.resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
    icon.save(ICON_ROOT / f"icon{size}.png", optimize=True)


def main() -> None:
    ICON_ROOT.mkdir(parents=True, exist_ok=True)
    master = prepare_master()
    for size in SIZES:
        generate_icon(master, size)
    print(f"Generated {len(SIZES)} Feed Cut Chrome icons from {MASTER}")


if __name__ == "__main__":
    main()
