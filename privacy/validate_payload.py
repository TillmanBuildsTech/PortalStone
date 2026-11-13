#!/usr/bin/env python3
"""Privacy validator for contribution payloads.

Two jobs:
  1. Structural check against payload.schema.json (required keys, enums, types, bounds).
  2. Privacy invariants that a schema cannot express -- no names, no identifiers, no free
     text, day-bucketed dates, bucketed magnitudes.

Run client-side before sending and server-side on receipt. Exit code 1 = do not send.

Usage:
    python3 validate_payload.py payload.json
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = json.load(open(os.path.join(HERE, "payload.schema.json"), encoding="utf-8"))

# keys that must never appear anywhere in a payload
DENY_KEYS = {
    "name", "character", "character_name", "charname", "player", "playername", "guid",
    "player_guid", "guild", "guild_name", "realm", "surname", "firstname", "lastname",
    "note", "notes", "comment", "chat", "email", "ip", "address", "hardware", "serial",
    "account", "account_id", "battletag", "email_hash", "raw", "lua",
}
# "Slouch Mage", "Dead Sadfatkid" -- first+last style display names
NAME_LIKE = re.compile(r"^[A-Z][a-zA-Z']+ [A-Z][a-zA-Z']+$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
UUID4_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
BUCKET_KEYS = ("money_bucket", "unit_price_bucket", "quantity_bucket", "dps_bucket",
               "duration_bucket", "spawn_gap_bucket", "item_stacks_bucket",
               "profession_time_bucket")
DATE_KEYS = ("date", "observed_date")


def walk(node, path=""):
    """Yield (path, key, value) for every leaf and every dict key."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield path, k, v
            yield from walk(v, f"{path}.{k}" if path else k)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk(v, f"{path}[{i}]")


def check(node):
    errors, warnings = [], []

    if not isinstance(node, dict):
        return ["payload must be a JSON object"], []

    for req in SCHEMA["required"]:
        if req not in node:
            errors.append(f"missing required key: {req}")

    for prop in node:
        if prop not in SCHEMA["properties"]:
            errors.append(f"unknown top-level key: {prop} (allowlist is closed)")

    if not UUID4_RE.match(str(node.get("install_id", ""))):
        errors.append("install_id must be a random UUIDv4")
    consent = node.get("consent") or {}
    if consent.get("scope") != "aggregate_stats":
        errors.append("consent.scope must be 'aggregate_stats'")

    for path, key, value in walk(node):
        kl = str(key).lower()
        if kl in DENY_KEYS:
            errors.append(f"{path}: forbidden key '{key}'")
        if isinstance(value, str):
            if len(value) > 40:
                errors.append(f"{path}.{key}: string too long ({len(value)}) -- free text is not allowed")
            if NAME_LIKE.match(value):
                errors.append(f"{path}.{key}: value looks like a character name: {value!r}")
            if kl in BUCKET_KEYS and not re.match(r"^[<>0-9]", value):
                errors.append(f"{path}.{key}: expected a bucket label, got {value!r}")
            if kl in DATE_KEYS and not DATE_RE.match(value):
                errors.append(f"{path}.{key}: expected YYYY-MM-DD day bucket, got {value!r}")
            if "T" in value and ("date" in kl) and kl not in ("sent_at", "granted_at"):
                errors.append(f"{path}.{key}: timestamp precision not allowed ({value!r})")
        if kl in BUCKET_KEYS and isinstance(value, (int, float)):
            errors.append(f"{path}.{key}: magnitude must be a bucket label, not a number ({value})")

    for arr, cap in (("sessions", 200), ("wealth", 500), ("economy", 5000),
                     ("progression", 200), ("rares", 1000)):
        if arr in node:
            if not isinstance(node[arr], list):
                errors.append(f"{arr} must be an array")
            elif len(node[arr]) > cap:
                errors.append(f"{arr} exceeds {cap} rows")

    for s in node.get("sessions", []):
        if "level" in s and isinstance(s["level"], int) and s["level"] > 60:
            errors.append("sessions[].level above 60 -- coarsen with level_range for high levels")
        for k in ("damage_done", "damage_taken"):
            if isinstance(s.get(k), int) and s[k] > 10_000 and s[k] % 1000:
                warnings.append(f"sessions[].{k} not rounded to 1000 -- coarsen before send")
    return errors, warnings


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    payload = json.load(open(sys.argv[1], encoding="utf-8"))
    errors, warnings = check(payload)
    print(f"{os.path.basename(sys.argv[1])}: {'FAIL' if errors else 'PASS'} "
          f"({len(errors)} errors, {len(warnings)} warnings)")
    for e in errors:
        print(f"  ERROR   {e}")
    for w in warnings:
        print(f"  WARN    {w}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
