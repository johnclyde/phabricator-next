#!/usr/bin/env python3
"""Prepare a digest-checked compiler image context. Never runs TeX on the host."""
import argparse
import hashlib
from pathlib import Path
import platform
import shutil
import tarfile
import urllib.request
import zipfile
import zlib

BUNDLE_URL = "https://data1.fullyjustified.net/tlextras-2022.0r0.tar"
BUNDLE_TAR_SHA256 = "425685e124746c15ba9bb8e0596bdaad98fce886afa347fbcf9ec0e9acd7fe79"
BUNDLE_ZIP_SHA256 = "b99f6292ac4ac5ef74566f7ba044491adbf67096f4b020855a6de0ad192d32f8"
COMPILERS = {
    "aarch64": "b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8",
    "x86_64": "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7",
}


def sha256(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def download(url, destination, expected):
    if not destination.exists():
        temporary = destination.with_suffix(destination.suffix + ".partial")
        with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        temporary.replace(destination)
    if sha256(destination) != expected:
        raise ValueError(f"SHA-256 verification failed: {destination}")


def prepare(directory, architecture, discard_downloads):
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / "bundle.tar"
    context = directory / "image"
    context.mkdir(exist_ok=True)
    bundle = context / "bundle.zip"
    if not bundle.exists():
        download(BUNDLE_URL, archive, BUNDLE_TAR_SHA256)
        temporary_bundle = bundle.with_suffix(".partial")
        # A different compressor must produce the same pinned bytes or fail closed.
        with tarfile.open(archive, "r|") as source, zipfile.ZipFile(temporary_bundle, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as output:
            names = set()
            for member in source:
                if not member.isfile() or "/" in member.name or member.name in names:
                    raise ValueError("Unexpected support bundle member")
                names.add(member.name)
                info = zipfile.ZipInfo(member.name, (2000, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100444 << 16
                info.create_system = 3
                with source.extractfile(member) as content:
                    output.writestr(info, content.read(), compresslevel=1)
        if sha256(temporary_bundle) != BUNDLE_ZIP_SHA256:
            raise ValueError(f"Prepared bundle differs from the pinned bytes (zlib {zlib.ZLIB_RUNTIME_VERSION}); verified compressor: zlib 1.2.12")
        temporary_bundle.replace(bundle)
    if sha256(bundle) != BUNDLE_ZIP_SHA256:
        raise ValueError("Prepared support bundle does not match the pinned digest")
    if discard_downloads and archive.exists():
        if sha256(archive) != BUNDLE_TAR_SHA256:
            raise ValueError("Refusing to discard an unrecognized source archive")
        archive.unlink()
    compiler = directory / f"tectonic-{architecture}.tar.gz"
    url = f"https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-{architecture}-unknown-linux-musl.tar.gz"
    download(url, compiler, COMPILERS[architecture])
    with tarfile.open(compiler, "r:gz") as source:
        members = source.getmembers()
        if len(members) != 1 or members[0].name != "tectonic" or not members[0].isfile():
            raise ValueError("Unexpected compiler release member")
        with source.extractfile(members[0]) as content, (context / "tectonic").open("wb") as output:
            shutil.copyfileobj(content, output)
    for filename in ("Dockerfile", "compile.sh", "warm.tex", "fonts.conf", ".dockerignore"):
        shutil.copyfile(Path(__file__).parent / filename, context / filename)
    print(f"Prepared verified image context: {context}")
    print(f"BUNDLE_SHA256={BUNDLE_ZIP_SHA256}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(".data/tex-toolchain"))
    parser.add_argument("--architecture", choices=COMPILERS, default="aarch64" if platform.machine() in ("arm64", "aarch64") else "x86_64")
    parser.add_argument("--discard-downloads", action="store_true", help="Remove the verified support tar only after the prepared ZIP is verified")
    arguments = parser.parse_args()
    prepare(arguments.directory, arguments.architecture, arguments.discard_downloads)
