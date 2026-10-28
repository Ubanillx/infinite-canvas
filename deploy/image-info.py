#!/usr/bin/env python3
"""Inspect original image bytes without rewriting the file."""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image


def image_info(filename):
    with Image.open(filename) as image:
        image.load()
        alpha = image.convert("RGBA").getchannel("A")
        histogram = alpha.histogram()
        low, high = alpha.getextrema()
        return {
            "path": str(Path(filename).resolve()),
            "format": image.format,
            "width": image.width,
            "height": image.height,
            "mode": image.mode,
            "has_alpha_data": "A" in image.getbands() or "transparency" in image.info,
            "has_transparent_pixels": low < 255,
            "alpha_min": low,
            "alpha_max": high,
            "transparent_pixels": histogram[0],
            "partial_alpha_pixels": sum(histogram[1:255]),
            "opaque_pixels": histogram[255],
        }


def main():
    parser = argparse.ArgumentParser(description="Inspect image dimensions and actual alpha transparency.")
    parser.add_argument("images", nargs="+")
    failed = False
    for filename in parser.parse_args().images:
        try:
            print(json.dumps(image_info(filename), ensure_ascii=False))
        except (OSError, ValueError, Image.DecompressionBombError) as error:
            failed = True
            print(json.dumps({"path": filename, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
