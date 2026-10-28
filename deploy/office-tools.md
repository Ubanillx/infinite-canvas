# Container Office Tools

This is a headless Linux environment, not a desktop or an interactive Office session.
The normal `python` and `python3` commands use `/opt/office`, a read-only virtual
environment for the non-root application user. Do not install packages on demand.

## Images

- Pillow (`from PIL import Image`): inspect, crop, mask, composite and preserve PNG alpha.
- `canvas-image-info /absolute/path/image.png`: emits JSON with dimensions, actual
  transparent/partial/opaque pixel counts, and a nonzero exit code for invalid images.
  It handles palette transparency as well as RGBA. Having an alpha channel alone does
  not prove that any pixel is transparent. A checkerboard painted into an image is not alpha.
- Read existing canvas images using `canvas_export_image` first. Use the returned
  `file.path`; do not guess `/api/media` URLs, extract cookies, or download frontend bundles.
- Exporting an image copies its bytes to the current workspace file center. It does
  not replace the source image, create canvas nodes or change chat history.

## Documents And Data

- `python-docx`, `openpyxl`, `python-pptx`: create/read/edit DOCX, XLSX and PPTX.
- `pandas`: CSV, tabular analysis and spreadsheet data; `requests`: HTTP clients.
- `pypdf`, `reportlab`: read/merge/write PDFs; Poppler supplies `pdftotext`, `pdfinfo`
  and `pdftoppm` for extraction and rendering.
- `libreoffice --headless --convert-to pdf --outdir artifacts input.docx`: Office to PDF.
  Use a distinct temporary LibreOffice user profile for concurrent conversions; never
  overwrite the source document. `pandoc` supports document format conversion.
- `tesseract input.png stdout -l eng+chi_sim`: English and simplified Chinese OCR.
- `ffmpeg`, `ffprobe`: media conversion and inspection; `curl`, `jq`, `rg`, `file`,
  `zip`, `unzip` and Git: routine shell work. Noto CJK and DejaVu fonts are installed.

Write derived files under the current workspace (normally `artifacts/`) and preserve
the originals. Inspect document layout after conversion. Do not claim exact text/logo
extraction or transparency based only on a generation prompt or a successful HTTP call.
When doing your own HTTP requests, check status and content type before saving bytes;
an authentication error JSON is not an image even if named `.png`.
