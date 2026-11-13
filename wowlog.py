#!/usr/bin/env python3
"""WoW combat log (WoWCombatLog.txt) analyzer -- out-of-game, read-only.

Field offsets follow combat-log format version 22 (see references/combat-log-format.md). The
important structural fact: when advanced logging is on, a 19-field unit block sits *in the
middle* of each spell/swing event (after the spell prefix, before the damage/heal suffix), with
an infoGUID at its start -- it is not a prefix before the source fields. Events without that
block (UNIT_DIED, SPELL_CAST_FAILED, SPELL_INTERRUPT, ENCOUNTER_*, ZONE_CHANGE) use fixed
offsets regardless.

  report   summary + worst sessions/pulls for one log file
  ingest   append rows into sqlite, tracking a byte offset so cron reads only what was appended
           (idempotent via UNIQUE(start))
"""
import argparse
import csv
import datetime as dt
import json
import os
import re
import sqlite3
from collections import Counter

# "11/12/2026 17:27:53.835-7" (offset may be absent, or unsigned for UTC+ clients)
LINE_RE = re.compile(
    r"^(\d{1,2}/\d{1,2}(?:/\d{2,4})? \d{2}:\d{2}:\d{2}\.\d{3})"
    r"(?:[-+]\d{1,2}(?::?\d{2})?|\d{1,2})?\s\s(.*)$")
# "0000000000000000", "Player-4385-0A1B2C3D", "Creature-0-4385-1234-1-1-1"
GUID_RE = re.compile(
    r"^(?:0{16}|(?:Player|Creature|Pet|Vehicle|GameObject|Vignette|Cast|Item|Unknown)"
    r"-[0-9A-Za-z\-:]+)$")
FALLBACK_YEAR = 2026

AFFILIATION_MINE = 0x00000001
TYPE_PLAYER = 0x00000400
ADV_BLOCK_LEN = 19

# Suffix offsets from format 22 WITH the advanced block present, in spec numbering (event name is
# field 0). params index = spec - 1, minus ADV_BLOCK_LEN when the block is absent.
DAMAGE_AMOUNT_SPEC = {
    "SPELL_DAMAGE": 31, "SPELL_BUILDING_DAMAGE": 31, "DAMAGE_SHIELD": 31,
    "SPELL_PERIODIC_DAMAGE": 31, "RANGE_DAMAGE": 31, "SWING_DAMAGE": 28,
}
HEAL_AMOUNT_SPEC = 32        # total healing including overheal
HEAL_OVERHEAL_SPEC = 33
# events that may carry the advanced block
HAS_ADV = set(DAMAGE_AMOUNT_SPEC) | {"SPELL_HEAL", "SPELL_PERIODIC_HEAL"}


def split_line(raw):
    """-> (datetime, event, [fields]) or None."""
    m = LINE_RE.match(raw.rstrip("\r\n"))
    if not m:
        return None
    ts_s, rest = m.groups()
    row = next(csv.reader([rest]), [])
    if len(row) < 2:
        return None
    try:
        if ts_s.count("/") == 2:
            ts = dt.datetime.strptime(ts_s, "%m/%d/%Y %H:%M:%S.%f")
        else:
            ts = dt.datetime.strptime(f"{FALLBACK_YEAR}/{ts_s}", "%Y/%m/%d %H:%M:%S.%f")
    except ValueError:
        return None
    return ts, row[0].strip(), [f.strip() for f in row[1:]]


def _get(params, i):
    return params[i] if 0 <= i < len(params) else ""


def _is_int(s):
    try:
        int(s)
        return True
    except (TypeError, ValueError):
        return False


def _int(params, i):
    """Ints and hex flags (0x511) both appear in this format."""
    v = (_get(params, i) or "").strip()
    try:
        return int(v, 16) if v.lower().startswith("0x") else int(v)
    except (TypeError, ValueError):
        return 0


class Pull:
    """One encounter, or one activity session when the log has no encounter events."""

    def __init__(self, start, kind="session", boss="", difficulty="", size=0):
        self.start = start
        self.kind = kind
        self.end = None
        self.boss = boss
        self.difficulty = difficulty
        self.size = size
        self.success = None
        self.zone = ""
        self.dmg_out = 0
        self.dmg_by_ability = Counter()
        self.dmg_in = Counter()
        self.dmg_in_total = 0
        self.heal_out = 0
        self.heal_over = 0
        self.interrupts = 0
        self.casts = 0
        self.cast_failures = Counter()
        self.kills = Counter()
        self.spell_casts = Counter()
        self.misses = Counter()        # miss_type -> count (your attacks only)
        self.hits = 0                  # your damage events that landed
        self.engaged = 0.0             # seconds inside the session not spent idle (>5s gaps)
        self.my_deaths = 0
        self.deaths = []            # (ts, name, killing_ability, is_you)
        self.last_hit_on = {}       # guid -> ability hitting it
        self.last_hitter = {}       # guid -> who last hit it
        self._last_activity = start

    @property
    def duration(self):
        return max(((self.end or self._last_activity) - self.start).total_seconds(), 0.0)

    def to_dict(self):
        d = self.duration or 1
        return {
            "start": self.start.isoformat(sep=" "),
            "end": (self.end or self._last_activity).isoformat(sep=" "),
            "kind": self.kind, "boss": self.boss, "zone": self.zone,
            "difficulty": self.difficulty, "size": self.size, "success": self.success,
            "duration_s": round(d, 1),
            "dps": round(self.dmg_out / d, 1),
            "hps": round(self.heal_out / d, 1),
            "damage_done": self.dmg_out,
            "damage_taken": self.dmg_in_total,
            "healing_done": self.heal_out,
            "kills": sum(self.kills.values()),
            "my_deaths": self.my_deaths, "hits": self.hits,
            "misses": self.misses.most_common(6),
            "engaged_s": round(self.engaged, 1),
            "spell_casts": self.spell_casts.most_common(10),
            "interrupts": self.interrupts, "casts": self.casts,
            "cast_failures": self.cast_failures.most_common(6),
            "deaths": [{"t": round((ts - self.start).total_seconds(), 1), "who": n,
                        "ability": a, "you": y} for ts, n, a, y in self.deaths],
            "top_abilities": self.dmg_by_ability.most_common(8),
            "top_damage_taken": self.dmg_in.most_common(8),
            "top_kills": self.kills.most_common(5),
        }


class LogReader:
    """Streams a combat log and yields finished Pull objects."""

    def __init__(self, path, start_offset=0, idle_gap_s=60):
        self.path = path
        self.start_offset = start_offset
        self.idle_gap_s = idle_gap_s
        self.me = self.me_name = None
        self.pull = None
        self.pulls = []
        self.first_ts = self.last_ts = None
        self.end_offset = start_offset
        self.dropped_lines = 0
        self.line_count = 0
        self.advanced = None          # None = not yet determined, then True/False
        self.build = self.project = ""
        self._zone = ""
        self._in_encounter = False

    # -- lifecycle ---------------------------------------------------------
    def _start_pull(self, ts, **kw):
        if self.pull:
            self._close_pull()
        self.pull = Pull(ts, **kw)
        self.pull.zone = self._zone
        return self.pull

    def _close_pull(self):
        p = self.pull
        if p and (p.dmg_out or p.dmg_in_total or p.deaths or p.casts):
            self.pulls.append(p)
        self.pull = None
        self._in_encounter = False

    def _mark_activity(self, p, ts):
        gap = (ts - p._last_activity).total_seconds()
        if 0 <= gap <= 5:
            p.engaged += gap
        p._last_activity = ts

    def _ensure_pull(self, ts):
        if self.pull is None:
            return self._start_pull(ts)
        if self._in_encounter:
            return self.pull
        if (ts - self.pull._last_activity).total_seconds() > self.idle_gap_s:
            self._close_pull()
            return self._start_pull(ts)
        return self.pull

    def run(self):
        with open(self.path, "r", encoding="utf-8", errors="replace") as fh:
            fh.seek(self.start_offset)
            # readline, not `for line in fh`: iteration disables fh.tell()
            while True:
                raw = fh.readline()
                if not raw:
                    break
                if not raw.endswith("\n"):
                    break          # partially flushed write: leave it for the next run
                self.end_offset = fh.tell()
                self.line_count += 1
                parsed = split_line(raw)
                if not parsed:
                    self.dropped_lines += 1
                    continue
                ts, event, params = parsed
                if self.first_ts is None:
                    self.first_ts = ts
                self.last_ts = ts
                self._handle(ts, event, params)
        self._close_pull()
        return self.pulls

    # -- events ------------------------------------------------------------
    def _handle(self, ts, event, params):
        if event == "COMBAT_LOG_VERSION":
            for i, v in enumerate(params):
                nxt = _get(params, i + 1)
                if v == "ADVANCED_LOG_ENABLED":
                    self.advanced = nxt == "1"
                elif v == "BUILD_VERSION":
                    self.build = nxt
                elif v == "PROJECT_ID":
                    self.project = nxt
            return
        if event == "ZONE_CHANGE":
            self._zone = _get(params, 1)
            return
        if event == "ENCOUNTER_START":
            p = self._start_pull(ts, kind="encounter", boss=_get(params, 1),
                                 difficulty=_get(params, 2), size=_int(params, 3))
            self._in_encounter = True
            return
        if event == "ENCOUNTER_END":
            if self.pull and self.pull.kind == "encounter":
                self.pull.end = ts
                self.pull.success = _int(params, 4) == 1
                self._close_pull()
            return

        if event in HAS_ADV:
            self._handle_adv(ts, event, params)
            return
        if event == "UNIT_DIED":
            # no spell prefix, no advanced block: dest fields sit in the common header
            victim, vname, vflags = _get(params, 4), _get(params, 5), _int(params, 6)
            p = self._ensure_pull(ts)
            if vflags & TYPE_PLAYER:
                killer = p.last_hit_on.get(victim, "unknown")
                mine = victim == self.me
                p.deaths.append((ts, vname, killer, mine))
                if mine:
                    p.my_deaths += 1
            elif vflags & (0x800 | 0x1000):
                if p.last_hitter.get(victim) == self.me:
                    p.kills[vname] += 1
            return
        if event == "SPELL_INTERRUPT":
            if _get(params, 0) == self.me:
                self._ensure_pull(ts).interrupts += 1
            return
        if event == "SPELL_CAST_SUCCESS":
            if _get(params, 0) == self.me:
                p = self._ensure_pull(ts)
                p.casts += 1
                p.spell_casts[_get(params, 9) or "?"] += 1
            return
        if event in ("SWING_MISSED", "SPELL_MISSED", "RANGE_MISSED"):
            if _get(params, 0) == self.me:
                mt = _get(params, 8) if event == "SWING_MISSED" else (_get(params, 11) or "?")
                self._ensure_pull(ts).misses[mt] += 1
            return
        if event == "SPELL_CAST_FAILED":
            if _get(params, 0) == self.me:
                self._ensure_pull(ts).cast_failures[_get(params, 11) or "?"] += 1
            return

    def _handle_adv(self, ts, event, params):
        """Damage/heal/swing events: common header + spell prefix + optional advanced block."""
        src, dst = _get(params, 0), _get(params, 4)
        src_flags = _int(params, 2)
        if self.me is None and src_flags & AFFILIATION_MINE:
            self.me, self.me_name = src, _get(params, 1)
        if self.advanced is None:
            # advanced-block presence: ~22 fields off, 40+ on for a SPELL_ event
            self.advanced = len(params) >= 38
        ability = _get(params, 9) if event != "SWING_DAMAGE" else "Melee"
        shift = 0 if self.advanced else -ADV_BLOCK_LEN

        if event in ("SPELL_HEAL", "SPELL_PERIODIC_HEAL"):
            total = _int(params, HEAL_AMOUNT_SPEC - 1 + shift)
            over = _int(params, HEAL_OVERHEAL_SPEC - 1 + shift)
            p = self._ensure_pull(ts)
            self._mark_activity(p, ts)
            if dst == self.me:
                p.heal_out += max(total - over, 0)
                p.heal_over += over
            return

        amount = _int(params, DAMAGE_AMOUNT_SPEC[event] - 1 + shift)
        p = self._ensure_pull(ts)
        if amount <= 0:
            return
        self._mark_activity(p, ts)
        if src == self.me and (not event.endswith("_SUPPORT")):
            p.hits += 1
            p.dmg_out += amount
            p.dmg_by_ability[ability or "unknown"] += amount
            p.last_hitter[dst] = self.me
        if dst == self.me:
            p.dmg_in_total += amount
            p.dmg_in[ability or "unknown"] += amount
        p.last_hit_on[dst] = ability or "unknown"


def summarize(pulls, reader):
    total_dur = sum(p.duration for p in pulls)
    dmg_out = sum(p.dmg_out for p in pulls)
    dmg_in = sum(p.dmg_in_total for p in pulls)
    deaths = [d for p in pulls for d in p.deaths]
    taken, abilities, fails, kills, zones = Counter(), Counter(), Counter(), Counter(), Counter()
    for p in pulls:
        taken.update(p.dmg_in)
        abilities.update(p.dmg_by_ability)
        fails.update(p.cast_failures)
        kills.update(p.kills)
        if p.zone:
            zones[p.zone] += round(p.duration)
    span = (reader.last_ts - reader.first_ts).total_seconds() if reader.first_ts else 0
    return {
        "you": reader.me_name, "guid": reader.me,
        "build": reader.build, "project": reader.project, "advanced": reader.advanced,
        "span_s": span, "sessions": len(pulls), "active_s": total_dur,
        "active_pct": round(100 * total_dur / span, 1) if span else 0,
        "damage_done": dmg_out, "damage_taken": dmg_in,
        "healing_done": sum(p.heal_out for p in pulls),
        "overheal": sum(p.heal_over for p in pulls),
        "dps_active": round(dmg_out / total_dur, 1) if total_dur else 0,
        "casts": sum(p.casts for p in pulls),
        "spell_casts": sum((p.spell_casts for p in pulls), Counter()).most_common(10),
        "engaged_s": sum(p.engaged for p in pulls),
        "hits": sum(p.hits for p in pulls),
        "misses": dict(sum((p.misses for p in pulls), Counter()).most_common(6)),
        "miss_rate_pct": round(100 * sum(sum(p.misses.values()) for p in pulls)
                               / max(sum(p.hits for p in pulls)
                                     + sum(sum(p.misses.values()) for p in pulls), 1), 1),
        "interrupts": sum(p.interrupts for p in pulls),
        "kills": sum(kills.values()),
        "kills_per_hour": round(sum(kills.values()) / (total_dur / 3600), 1) if total_dur else 0,
        "deaths_total": len(deaths),
        "your_deaths": len([d for d in deaths if d[3]]),
        "top_damage_taken": taken.most_common(8),
        "top_abilities": abilities.most_common(8),
        "cast_failures": fails.most_common(6),
        "top_kills": kills.most_common(8),
        "zones": zones.most_common(8),
        "worst_sessions": sorted(
            ({"start": p.start.isoformat(sep=" "), "zone": p.zone,
              "deaths": p.my_deaths, "dps": round(p.dmg_out / (p.duration or 1)),
              "taken": p.dmg_in_total, "dur_s": round(p.duration)}
             for p in pulls if p.my_deaths), key=lambda s: (-s["deaths"], -s["taken"]))[:5],
    }


def report(pulls, reader, top=6):
    s = summarize(pulls, reader)
    hm = lambda x: f"{x/3600:.1f}h" if x >= 3600 else f"{x/60:.0f}m"
    out = [f"log: {reader.line_count:,} lines, {reader.dropped_lines} unparsed | build "
           f"{s['build'] or '?'} project {s['project'] or '?'} advanced={s['advanced']} | "
           f"you={s['you']} ({s['guid']})",
           f"span {hm(s['span_s'])} | active combat {hm(s['active_s'])} ({s['active_pct']}%) | "
           f"{s['sessions']} sessions",
           f"damage {s['damage_done']:,} | dps-while-active {s['dps_active']:,.0f} | "
           f"taken {s['damage_taken']:,} | healed {s['healing_done']:,} "
           f"(overheal {s['overheal']:,})",
           f"kills {s['kills']:,} ({s['kills_per_hour']}/h) | your deaths {s['your_deaths']} | "
           f"casts {s['casts']:,} | interrupts {s['interrupts']}"]
    if s["engaged_s"]:
        out.append(f"engaged {hm(s['engaged_s'])} of it ({round(100*s['engaged_s']/max(s['active_s'],1))}"
                   f"%) | dps engaged {s['damage_done']/s['engaged_s']:,.1f}")
    if s["hits"] or s["misses"]:
        out.append(f"your hit rate {100-s['miss_rate_pct']:.1f}% | misses: "
                   + ", ".join(f"{k} {v}" for k, v in s["misses"].items()))
    if s["spell_casts"]:
        out.append("casts: " + ", ".join(f"{a} {v}" for a, v in s["spell_casts"][:8]))
    if s["top_damage_taken"]:
        out.append("hit by: " + ", ".join(f"{a} {v:,}" for a, v in s["top_damage_taken"][:6]))
    if s["top_abilities"]:
        out.append("your damage: " + ", ".join(f"{a} {v:,}" for a, v in s["top_abilities"][:6]))
    if s["cast_failures"]:
        out.append("cast failures: " + ", ".join(f"{a} x{v}" for a, v in s["cast_failures"][:6]))
    if s["zones"]:
        out.append("zones: " + ", ".join(f"{z} {v//60}m" for z, v in s["zones"][:6]))
    if s["worst_sessions"]:
        out.append("worst sessions:")
        for w in s["worst_sessions"][:top]:
            out.append(f"   {w['start'][5:16]} {w['zone'] or '?'} {w['dur_s']}s "
                       f"{w['dps']:,} dps, {w['deaths']} deaths, {w['taken']:,} taken")
    if s["advanced"] is False:
        out.append("NOTE: advanced logging off -- no HP/position/stat data in this log")
    return "\n".join(out)


SCHEMA = """
CREATE TABLE IF NOT EXISTS pulls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start TEXT NOT NULL UNIQUE,
  end TEXT, kind TEXT, boss TEXT, zone TEXT, difficulty TEXT, size INTEGER, success INTEGER,
  duration_s REAL, dps REAL, hps REAL, damage_done INTEGER, damage_taken INTEGER,
  healing_done INTEGER, kills INTEGER, interrupts INTEGER, casts INTEGER, deaths TEXT,
  top_abilities TEXT, top_damage_taken TEXT, cast_failures TEXT, top_kills TEXT, ingested_at TEXT
);
CREATE TABLE IF NOT EXISTS ingest_state (
  path TEXT PRIMARY KEY, offset INTEGER, last_ts TEXT
);
"""


def ingest(path, db, force_full=False):
    con = sqlite3.connect(db)
    con.executescript(SCHEMA)
    row = con.execute("SELECT offset FROM ingest_state WHERE path=?", (path,)).fetchone()
    offset = 0 if force_full or not row else row[0]
    if offset > os.path.getsize(path):      # rotated or truncated log
        offset = 0
    reader = LogReader(path, start_offset=offset)
    pulls = reader.run()
    added = 0
    for p in pulls:
        d = p.to_dict()
        try:
            con.execute(
                """INSERT INTO pulls (start,end,kind,boss,zone,difficulty,size,success,
                     duration_s,dps,hps,damage_done,damage_taken,healing_done,kills,interrupts,
                     casts,deaths,top_abilities,top_damage_taken,cast_failures,top_kills,
                     ingested_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (d["start"], d["end"], d["kind"], d["boss"], d["zone"], d["difficulty"],
                 d["size"], d["success"], d["duration_s"], d["dps"], d["hps"],
                 d["damage_done"], d["damage_taken"], d["healing_done"], d["kills"],
                 d["interrupts"], d["casts"], json.dumps(d["deaths"]),
                 json.dumps(d["top_abilities"]), json.dumps(d["top_damage_taken"]),
                 json.dumps(d["cast_failures"]), json.dumps(d["top_kills"]),
                 dt.datetime.now().isoformat(timespec="seconds")))
            added += 1
        except sqlite3.IntegrityError:
            continue
    con.execute("INSERT INTO ingest_state(path,offset,last_ts) VALUES(?,?,?) "
                "ON CONFLICT(path) DO UPDATE SET offset=excluded.offset, last_ts=excluded.last_ts",
                (path, reader.end_offset, reader.last_ts.isoformat() if reader.last_ts else None))
    con.commit()
    total = con.execute("SELECT COUNT(*) FROM pulls").fetchone()[0]
    con.close()
    return {"lines": reader.line_count, "unparsed": reader.dropped_lines, "new_rows": added,
            "total_rows": total, "offset": reader.end_offset, "me": reader.me_name,
            "advanced": reader.advanced, "build": reader.build, "project": reader.project,
            "span": [reader.first_ts, reader.last_ts]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["report", "ingest", "summary"])
    ap.add_argument("logfile")
    ap.add_argument("--db", default=os.path.expanduser("~/wow-coach/coach.sqlite"))
    ap.add_argument("--last", type=int, default=6)
    ap.add_argument("--full", action="store_true", help="re-ingest from byte 0")
    a = ap.parse_args()
    if a.mode == "ingest":
        print(json.dumps(ingest(a.logfile, a.db, force_full=a.full), default=str, indent=2))
        return
    reader = LogReader(a.logfile)
    pulls = reader.run()
    if a.mode == "summary":
        print(json.dumps(summarize(pulls, reader), default=str, indent=2))
    else:
        print(report(pulls, reader, top=a.last))


if __name__ == "__main__":
    main()
