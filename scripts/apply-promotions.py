#!/usr/bin/env python3
"""
apply-promotions.py — second-pass over db/tag-suggestions-raw-v2.jsonl that
bakes in the user's round-2 promotion decisions:

  ACCEPTED  : proposed_tag values that became canonical (people, transportation, watch-list)
  REMAPPED  : proposed_tag values folded into an existing canonical tag (contact → people)
  REJECTED  : everything else — note keeps its existing suggested_tags

Writes db/tag-suggestions-final.jsonl plus a stats report.

For each note where proposed_tag is in ACCEPTED or REMAPPED:
  - The (possibly remapped) tag is inserted at the front of suggested_tags
    (deduped, max 3 entries).
  - If the original primary was `unclassifiable`, the promoted tag takes
    over as primary. Otherwise primary is preserved.
  - `proposed_tag` is cleared (set to null) to signal the proposal was consumed.

REJECTED proposals are simply nulled out; suggested_tags is left untouched.
"""
import json
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
IN   = REPO / "db" / "tag-suggestions-raw-v2.jsonl"
OUT  = REPO / "db" / "tag-suggestions-final.jsonl"

# proposed_tag → action
# "accept" means the proposal name itself is now canonical.
# Any other string is a remap into an existing canonical tag.
PROMOTIONS = {
    "people":          "accept",
    "transportation":  "accept",
    "watch-list":      "accept",
    "watchlist":       "watch-list",   # kebab-case dedup
    "contact":         "people",       # user-approved fold
}

# Sanity-check: the 32-tag canonical taxonomy (post round-2).
CANONICAL = {
    "idea","ai","thought","quote","link","llm","article","mental-model",
    "humor","robotics","question","unclassifiable","health","tweet","hot-take",
    "lesson","infra","hardware","philosophy","todo","reading-list","physics",
    "commerce","social","ml","design","writing","finance","to-learn",
    "people","transportation","watch-list",
}

def main():
    if not IN.exists():
        raise SystemExit(f"missing {IN} — run stitch-suggestions.py first")

    records = []
    promoted = Counter()  # by final canonical tag
    folded   = Counter()  # by original proposed_tag → canonical
    rejected = Counter()  # proposed_tags that didn't promote
    primary_reassigned = 0
    untouched = 0

    for line in IN.read_text().splitlines():
        line = line.strip()
        if not line: continue
        r = json.loads(line)
        pt = r.get("proposed_tag")

        if pt is None:
            untouched += 1
            records.append(r)
            continue

        action = PROMOTIONS.get(pt)
        if action is None:
            # rejected — strip the proposal, suggested_tags stand
            rejected[pt] += 1
            r["proposed_tag"] = None
            records.append(r)
            continue

        # Determine the canonical tag this proposal becomes.
        canonical_tag = pt if action == "accept" else action
        assert canonical_tag in CANONICAL, f"promotion target {canonical_tag} not in canonical set"

        # Promote: prepend the canonical tag, dedupe, cap at 3.
        old_tags = r.get("suggested_tags", [])
        new_tags = [canonical_tag] + [t for t in old_tags if t != canonical_tag]
        new_tags = new_tags[:3]

        # If original primary was 'unclassifiable' OR original primary is no
        # longer in the trimmed list, the promoted tag takes primary.
        old_primary = r.get("primary")
        if old_primary == "unclassifiable" or old_primary not in new_tags:
            r["primary"] = canonical_tag
            primary_reassigned += 1

        r["suggested_tags"] = new_tags
        r["proposed_tag"] = None

        promoted[canonical_tag] += 1
        if action != "accept":
            folded[f"{pt}→{canonical_tag}"] += 1

        records.append(r)

    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n")

    print(f"[promote] read  : {IN}")
    print(f"[promote] wrote : {OUT}")
    print(f"[promote] total notes: {len(records)}")
    print(f"[promote] untouched (no proposal): {untouched}")
    print(f"[promote] promoted (became canonical): {sum(promoted.values())}")
    for t, n in promoted.most_common():
        print(f"  {n:4d}  → {t}")
    print(f"[promote] folded remaps:")
    for k, n in folded.most_common():
        print(f"  {n:4d}  {k}")
    print(f"[promote] primary reassigned (was unclassifiable or dropped): {primary_reassigned}")
    print(f"[promote] rejected proposals stripped (suggested_tags unchanged): {sum(rejected.values())}")
    print(f"[promote] top rejected proposals:")
    for t, n in rejected.most_common(15):
        print(f"  {n:4d}  {t}")

    # Final tag distribution after promotions
    final_counts = Counter()
    final_primaries = Counter()
    for r in records:
        for t in r.get("suggested_tags", []):
            final_counts[t] += 1
        final_primaries[r.get("primary", "?")] += 1

    print()
    print(f"[promote] final tag distribution ({len(final_counts)} distinct):")
    for t, n in final_counts.most_common():
        print(f"  {n:5d}  {t}")
    print()
    print(f"[promote] final PRIMARY distribution:")
    for t, n in final_primaries.most_common():
        print(f"  {n:5d}  {t}")

if __name__ == "__main__":
    main()
