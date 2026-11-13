#!/usr/bin/env python3
"""Discovery probe for a WoW SavedVariables folder.

Read-only. Enumerates *.lua files, fingerprints top-level globals, and reports which
capabilities would light up, with a confidence/freshness score and the reason a provider is
degraded. This is the "what would unlock" view from the provider spec.

Usage:
    python3 probe_sv.py <SavedVariables dir> [--json]
"""
import argparse
import json
import os
import re
import sys
import time

TOP_GLOBAL = re.compile(r"^([A-Za-z_]\w*)\s*=\s*", re.M)
EPOCH = re.compile(r"\b(17\d{8}|18\d{8})\b")          # plausible unix seconds, 2023-2027

# global -> (provider id, capabilities, note)
GLOBALS = {
    "BrotherBags":     ("sv.bagbrother",  ["character.inventory", "character.money"], "Bagnon/BagBrother"),
    "BagSyncDB":       ("sv.bagsync",     ["character.inventory", "character.money"], "BagSync (multi-char gold)"),
    "TradeSkillMasterDB": ("sv.tsm",      ["auction.prices", "character.money", "profession.skills"], "TSM core"),
    "TradeSkillMaster_AuctionDB": ("sv.tsm.auction", ["auction.prices"], "TSM auction DB"),
    "AUCTIONATOR_PRICE_DATABASE": ("sv.auctionator", ["auction.prices"], "Auctionator prices"),
    "AuctionatorShoppingLists": ("sv.auctionator.lists", [], "Auctionator lists only"),
    "Attune_DB":       ("sv.attune",      ["progression.attunement", "roster.levels"], "Attune"),
    "RareScannerDB":   ("sv.rarescan",    ["rare.spawns"], "RareScanner spawn samples"),
    "QuestieConfig":   ("sv.questie",     ["quest.completion"], "Questie"),
    "QuestieTraceDumps": ("sv.questietrace", ["world.mapdata"], "QuestieTrace map dumps"),
    "AtlasLootDB":     ("sv.atlasloot",   ["world.loottables"], "AtlasLoot"),
    "DBM_AllSavedOptions": ("sv.dbm",     [], "DBM config only"),
}


def read_text(path, limit=8_000_000):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        return fh.read(limit)


def probe(path):
    name = os.path.basename(path)
    text = read_text(path)
    globals_found = sorted(set(TOP_GLOBAL.findall(text)))
    hits = []
    for g in globals_found:
        if g in GLOBALS:
            prov, caps, note = GLOBALS[g]
            hits.append({"global": g, "provider": prov, "capabilities": caps, "note": note})
    epochs = [int(e) for e in EPOCH.findall(text)]
    fresh_ts = max(epochs) if epochs else None
    return {
        "file": name,
        "bytes": os.path.getsize(path),
        "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(path))),
        "globals": globals_found[:6],
        "providers": hits,
        "newest_embedded_ts": (time.strftime("%Y-%m-%d %H:%M", time.localtime(fresh_ts))
                               if fresh_ts else None),
        "chars": sorted(set(re.findall(r'\["([A-Z][a-z]+ [A-Za-z\']+)"\]\s*=\s*\{', text)))[:12],
    }


def detail_bagbrother(text):
    out = {}
    for name in re.findall(r'\["([A-Z][a-z]+ [A-Za-z\']+)"\] = \{\s*\n\s*\{', text):
        i = text.find(f'["{name}"] = {{')
        blk = text[i:i + 9000]
        money = re.search(r'\["money"\] = (\d+)', blk)
        cls = re.search(r'\["class"\] = "(\w+)"', blk)
        lvl = re.search(r'\["level"\] = (\d+)', blk)
        stacks = len(re.findall(r'"\d+[;:][^"]*"', blk))
        if money or cls:
            out[name] = {
                "class": cls.group(1) if cls else None,
                "level": int(lvl.group(1)) if lvl else None,
                "money_g": round(int(money.group(1)) / 10000, 2) if money else None,
                "item_stacks": stacks,
            }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("svdir")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    files = []
    for root, _, names in os.walk(a.svdir):
        for n in names:
            if n.endswith(".lua"):
                files.append(os.path.join(root, n))
    files.sort(key=lambda p: -os.path.getsize(p))

    results = [probe(p) for p in files]
    caps = {}
    for r in results:
        for h in r["providers"]:
            for c in h["capabilities"]:
                caps.setdefault(c, []).append({"provider": h["provider"], "file": r["file"],
                                               "fresh": r["newest_embedded_ts"] or r["mtime"]})

    if a.json:
        print(json.dumps({"files": results, "capabilities": caps}, indent=2))
        return

    print(f"scanned {len(files)} .lua files in {a.svdir}\n")
    print("files:")
    for r in results:
        tag = ",".join(sorted({h["provider"] for h in r["providers"]})) or "-"
        print(f"  {r['bytes']:>9,}  {r['mtime']}  {r['file'][:34]:34}  {tag}")
        if r["globals"]:
            print(f"             globals: {', '.join(r['globals'][:4])}")

    print("\ncapabilities satisfied today:")
    if not caps:
        print("  none -- no known provider globals found")
    for c, provs in sorted(caps.items()):
        print(f"  {c:26} <- " + " | ".join(f"{p['provider']} ({p['fresh']})" for p in provs))

    bb = next((p for p in files if p.endswith("BagBrother.lua")), None)
    if bb:
        print("\ncharacter.inventory + character.money detail:")
        for name, d in detail_bagbrother(read_text(bb)).items():
            print(f"  {name:22} {d['class'] or '?':8} lvl {d['level'] or '?':>3}  "
                  f"{d['money_g'] if d['money_g'] is not None else '?':>7}g  "
                  f"{d['item_stacks']} stacks")


if __name__ == "__main__":
    main()
