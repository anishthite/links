#!/usr/bin/env python3
"""
apply-promotions-r3.py — round-3 variant of apply-promotions.py.

Operates on db/round3/tag-suggestions-raw-r3.jsonl and writes
db/round3/tag-suggestions-final-r3.jsonl. Reuses the round-2 promotion table
verbatim (`people`, `transportation`, `watch-list` accepted; `contact→people`,
`watchlist→watch-list` remapped; everything else rejected).

In round-3 the round-2 promotions are already canonical and the prompt
instructs the worker not to propose them. So we mostly expect `proposed_tag`
to be null or rejected. Still, the script runs idempotently and clears
`proposed_tag` to null on the way out so the downstream loader sees a
fully-baked final.
"""
import json
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
IN = REPO / "db" / "round3" / "tag-suggestions-raw-r3.jsonl"
OUT = REPO / "db" / "round3" / "tag-suggestions-final-r3.jsonl"

# proposed_tag → action
#
# "accept" means the proposal name itself is now canonical.
# Any other string is a remap into an existing canonical tag.
PROMOTIONS = {
    "people":          "accept",
    "transportation":  "accept",
    "watch-list":      "accept",
    "watchlist":       "watch-list",
    "contact":         "people",
}

# Sanity-check: the 32-tag canonical taxonomy (post round-2).
CANONICAL = {
    "idea","ai","thought","quote","link","llm","article","mental-model",
    "humor","robotics","question","unclassifiable","health","tweet","hot-take",
    "lesson","infra","hardware","philosophy","todo","reading-list","physics",
    "commerce","social","ml","design","writing","finance","to-learn",
    "people","transportation","watch-list",
}


def apply(r):
    """Apply promotion (if any) to a single record. Returns the new record."""
    proposed = r.get("proposed_tag")
    if not proposed:
        return r

    action = PROMOTIONS.get(proposed)
    if action is None:
        # Rejected — clear proposed_tag, leave suggested_tags alone.
        r["proposed_tag"] = None
        return r

    target = proposed if action == "accept" else action
    if target not in CANONICAL:
        # Defensive: should never happen given PROMOTIONS targets are all canonical.
        r["proposed_tag"] = None
        return r

    suggested = list(r.get("suggested_tags", []))
    if target in suggested:
        suggested.remove(target)
    suggested = [target] + suggested
    suggested = suggested[:3]
    r["suggested_tags"] = suggested

    if r.get("primary") == "unclassifiable" or r.get("primary") not in suggested:
        r["primary"] = target

    r["proposed_tag"] = None
    return r


def main():
    if not IN.exists():
        raise SystemExit(f"[apply-promotions-r3] input not found: {IN}")

    records = []
    actions = Counter()
    for line in IN.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        r = json.loads(line)
        proposed = r.get("proposed_tag")
        if proposed:
            if proposed in PROMOTIONS:
                actions[PROMOTIONS[proposed]] += 1
            else:
                actions["reject"] += 1
        records.append(apply(r))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"[apply-promotions-r3] wrote {OUT}")
    print(f"[apply-promotions-r3] records: {len(records)}")
    print(f"[apply-promotions-r3] proposal actions: {dict(actions)}")


if __name__ == "__main__":
    main()
