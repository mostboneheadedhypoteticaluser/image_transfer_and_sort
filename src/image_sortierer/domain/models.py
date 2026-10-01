from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class MediaSource:
    id: int
    path: Path
    enabled: bool


@dataclass(frozen=True, slots=True)
class ScanResult:
    discovered: int
    new: int
    changed: int
    unchanged: int
    missing: int
    errors: int
