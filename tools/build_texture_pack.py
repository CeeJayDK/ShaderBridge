"""Build ReShade-ready assets from an existing local Shadertoy media archive.

Requires Pillow. Reads only the allowlisted resources in texture_manifest.json;
never reads shader exports or conversions and never downloads or uploads files.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import struct
import zipfile

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def volume_dds(data, asset):
    if data[:4] != b"BIN\0":
        raise ValueError("Invalid source volume header")
    w, h, d, channels = struct.unpack_from("<4I", data, 4)
    if (w, h, d, channels) != (asset["width"], asset["height"], asset["depth"], asset["channels"]):
        raise ValueError("Unexpected source volume dimensions/channels")
    voxels = data[20:]
    if len(voxels) != w * h * d * channels:
        raise ValueError("Unexpected source volume payload size")
    # ReShade's DDS loader accepts uncompressed RGBA volumes. Replication keeps
    # the original scalar values when the effect loads the image into R8.
    rgba = b"".join(bytes((v, v, v, 255)) for v in voxels) if channels == 1 else voxels
    header = [124, 0x80100F, h, w, w * 4, d, 1] + [0] * 11
    header += [32, 0x41, 0, 32, 0xFF, 0xFF00, 0xFF0000, 0xFF000000]
    header += [0x1008, 0x200000, 0, 0, 0]
    return b"DDS " + struct.pack("<31I", *header) + rgba


def validate_prepared(path, asset):
    if asset["kind"] != "volume":
        with Image.open(path) as im:
            if im.size != (asset["width"], asset["height"]):
                raise ValueError(f"Unexpected image dimensions: {path}")
        return
    data = path.read_bytes()
    if len(data) < 148 or data[:4] != b"DDS " or data[84:88] != b"DX10":
        raise ValueError(f"Expected a DX10 DDS volume: {path}")
    height, width = struct.unpack_from("<2I", data, 12)
    depth = struct.unpack_from("<I", data, 24)[0]
    fmt, dimension, _, array_size, _ = struct.unpack_from("<5I", data, 128)
    if (width, height, depth, fmt, dimension, array_size) != (asset["width"], asset["height"], asset["depth"], 61 if asset["channels"] == 1 else 28, 4, 1):
        raise ValueError(f"Unexpected DDS volume layout: {path}")
    if len(data) != 148 + width * height * depth * asset["channels"]:
        raise ValueError(f"Unexpected DDS volume payload: {path}")


def build(media, output, archive, prepared=None):
    catalog = json.loads((ROOT / "tools/texture_manifest.json").read_text(encoding="utf-8"))
    # Accept either the archive root or its media/a directory.
    if media:
        media = media.resolve()
        if (media / "media/a").is_dir():
            media = media / "media/a"
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    records = []
    for asset in catalog["assets"]:
        if prepared:
            source = prepared.resolve() / asset["filename"]
            validate_prepared(source, asset)
            target = output / asset["filename"]
            if target != source:
                shutil.copyfile(source, target)
            data = target.read_bytes()
            records.append(dict(asset, source_files=[source.name], source_sha256=[digest(source.read_bytes())], output_sha256=digest(data), bytes=len(data), preparation="Copied unchanged from prepared texture set"))
            continue
        count = 6 if asset["kind"] == "cubemap" else 1
        sources = [media / (asset["hash"] + ("_" + str(i) if i else "") + "." + asset["source_extension"]) for i in range(count)]
        for source in sources:
            if not source.is_file():
                raise FileNotFoundError(source)
        target = output / asset["filename"]
        if asset["kind"] == "texture":
            with Image.open(sources[0]) as im:
                if im.size != (asset["width"], asset["height"]):
                    raise ValueError(f"Unexpected image dimensions: {sources[0]}")
            shutil.copyfile(sources[0], target)
        elif asset["kind"] == "cubemap":
            size = asset["face_size"]
            atlas = Image.new("RGBA", (size * 6, size))
            for face, source in enumerate(sources):
                with Image.open(source) as im:
                    if im.size != (size, size):
                        raise ValueError(f"Unexpected cubemap face dimensions: {source}")
                    atlas.paste(im.convert("RGBA"), (face * size, 0))
            atlas.save(target)
        else:
            target.write_bytes(volume_dds(sources[0].read_bytes(), asset))
        records.append(dict(asset, source_files=[p.name for p in sources], source_sha256=[digest(p.read_bytes()) for p in sources], output_sha256=digest(target.read_bytes()), bytes=target.stat().st_size))

    version = re.search(r"PORTER_VERSION = '([^']+)'", (ROOT / "ShaderBridge_transform.js").read_text(encoding="utf-8"))[1]
    report = dict(porter_version=version, source=catalog["source"], redistribution_status="unverified", assets=records)
    manifest = output / "ShaderBridge_Texture_Manifest.json"
    manifest.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    notice = output / "ShaderBridge_Texture_Notice.txt"
    notice.write_text(
        "ShaderBridge texture assets - LOCAL PACKAGE\n\n"
        "Source archive: " + catalog["source"] + "\n"
        "These third-party assets are not covered by ShaderBridge's MIT licence.\n"
        "The archive maintainer tentatively describes them as CC BY-NC-SA 3.0;\n"
        "per-asset redistribution rights and attribution still need confirmation.\n"
        "Keep this generated package local until those terms are confirmed.\n\n"
        "Prepared input files are copied without modification. For raw media\n"
        "input, images are copied, cubemap faces 0 through 5 are assembled\n"
        "left-to-right, and volume voxels are repackaged as DDS.\n"
        "See the manifest for checksums and dimensions.\n",
        encoding="utf-8")
    archive = archive or ROOT / "dist" / f"ShaderBridge_Textures_{version}.zip"
    archive = archive.resolve()
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as z:
        # Explicit allowlist: unrelated files in Textures cannot enter the ZIP.
        for filename in [a["filename"] for a in catalog["assets"]] + [manifest.name, notice.name]:
            z.write(output / filename, "reshade-shaders/Textures/" + filename)
        z.writestr("INSTALL.txt", "Extract into the game/application folder containing reshade-shaders.\n"
                   "The assets go in reshade-shaders/Textures. Ensure that folder is in\n"
                   "ReShade Settings > Texture search paths. Put converted .fx effects\n"
                   "in reshade-shaders/Shaders. Keep the texture filenames unchanged.\n"
                   "This pack contains standard textures only; custom shader assets\n"
                   "must be supplied separately. Read ShaderBridge_Texture_Notice.txt.\n")
        if prepared:
            supplied_report = prepared / "_Dokumentation/Kontrolrapport.txt"
            if supplied_report.is_file():
                z.write(supplied_report, "Documentation/Kontrolrapport.txt")
    print(f"Built {len(records)} assets in {output}")
    print(f"ZIP: {archive} ({archive.stat().st_size:,} bytes)")
    return archive


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--media-dir", type=Path)
    source.add_argument("--prepared-dir", type=Path, help="Already prepared, correctly named ReShade assets")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "Textures")
    parser.add_argument("--zip", type=Path, help="Output ZIP path")
    args = parser.parse_args()
    build(args.media_dir, args.output_dir, args.zip, args.prepared_dir)
