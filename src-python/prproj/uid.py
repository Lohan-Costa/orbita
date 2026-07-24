"""UUID and ObjectID helpers for PRPROJ generation."""

from __future__ import annotations
import uuid


def new_uid() -> str:
    """UUID v4 in 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX' (lowercase) format."""
    return str(uuid.uuid4())


class OIDCounter:
    """Monotonically increasing integer OID counter."""

    def __init__(self, start: int = 1):
        self._n = start - 1

    def next(self) -> str:
        self._n += 1
        return str(self._n)

    @property
    def current(self) -> int:
        return self._n
