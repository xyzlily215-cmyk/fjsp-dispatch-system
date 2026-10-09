"""Shared conflict-record factory.

Conflict dicts are part of the cross-service response contract:
{"rule", "objects", "severity", "suggestion"}.
"""

from typing import Iterable


def make_conflict(rule: str, objects: Iterable, severity: str, suggestion: str) -> dict:
    return {"rule": rule, "objects": list(objects),
            "severity": severity, "suggestion": suggestion}
