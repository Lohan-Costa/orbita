"""Gzip compress/write helpers for PRPROJ files."""

from __future__ import annotations
import gzip
from pathlib import Path


def write_prproj(xml_str: str, output_path: Path) -> None:
    """Write UTF-8 encoded XML string as a gzip-compressed .prproj file."""
    data = xml_str.encode("utf-8")
    with gzip.open(output_path, "wb", compresslevel=6) as f:
        f.write(data)


def read_prproj(path: Path) -> str:
    """Read a gzip-compressed .prproj file and return the XML string."""
    with gzip.open(path, "rb") as f:
        return f.read().decode("utf-8")
