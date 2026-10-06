"""Validate and pack only the shipping build, with no external dependencies."""
import json
import os
from pathlib import Path
import zipfile

root = Path(__file__).resolve().parent.parent
dist = root / "extension/dist"
manifest = json.loads((dist / "manifest.json").read_text())
source = json.loads((root / "extension/public/manifest.json").read_text())
if manifest != source:
    raise SystemExit("Shipping manifest differs from source; refusing to package a test build")
if os.environ.get("RELEASE_TAG") != "v" + manifest["version"]:
    raise SystemExit("Release tag does not match shipping manifest")

# The build has a deliberately small output surface. Fail closed on extra files.
expected = {
    "manifest.json", "background.js", "content.js", "mainworld.js",
    "options.html", "options.js",
    *(f"icons/icon-{size}.png" for size in [16, 32, 48, 128]),
}
files = sorted(p for p in dist.rglob("*") if p.is_file())
if any(p.is_symlink() for p in dist.rglob("*")):
    raise SystemExit("Symlinks are not allowed in the extension package")
if {p.relative_to(dist).as_posix() for p in files} != expected:
    raise SystemExit("Unexpected or missing build files; refusing to package")
for p in files:
    if p.suffix == ".js" and any(marker in p.read_text() for marker in ["localhost:4173", "127.0.0.1:7799", "127.0.0.1:7798"]):
        raise SystemExit(f"Test endpoint found in {p.name}")

out = root / "dist/send-to-paseo-extension.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    for p in files:
        info = zipfile.ZipInfo(p.relative_to(dist).as_posix(), (2020, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, p.read_bytes())
with zipfile.ZipFile(out) as archive:
    if archive.testzip() is not None:
        raise SystemExit("ZIP integrity check failed")
print(f"Packed {manifest['version']}: {out} ({out.stat().st_size} bytes)")
