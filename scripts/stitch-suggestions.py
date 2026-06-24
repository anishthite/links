#!/usr/bin/env python3
"""
stitch-suggestions.py — concatenate chunk-NN-tagged[-v2].jsonl files into a
single db/tag-suggestions-raw[-v2].jsonl, validate, normalize aliases, and
report stats including proposed_tag aggregation for taxonomy review.

Defaults to v2 (closed-taxonomy round-2). Pass --v1 to stitch the legacy
open-vocab outputs (chunk-NN-tagged.jsonl → tag-suggestions-raw.jsonl).
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

REPO   = Path(__file__).resolve().parent.parent
CHUNKS = REPO / "db" / "chunks"

# Canonical 32-tag taxonomy (closed set, post round-2 promotion).
# Mirrors db/eval/taxonomy.md.
CANONICAL = {
    # Round-1 (29):
    "idea","ai","thought","quote","link","llm","article","mental-model",
    "humor","robotics","question","unclassifiable","health","tweet","hot-take",
    "lesson","infra","hardware","philosophy","todo","reading-list","physics",
    "commerce","social","ml","design","writing","finance","to-learn",
    # Round-2 promotions:
    "people","transportation","watch-list",
}

# Belt-and-suspenders aliasing — workers are told to map these textually,
# but we normalize at stitch-time too in case any slip through.
# Also includes round-2 promotion folds.
ALIASES = {
    "gpt": "ai",
    "questions": "question",
    "mental": "mental-model",
    "hot take": "hot-take",
    "contact": "people",       # round-2 fold
    "watchlist": "watch-list", # kebab-case dedup
}

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--v1", action="store_true",
                   help="Stitch legacy open-vocab outputs (chunk-NN-tagged.jsonl)")
    p.add_argument("-n", "--num-chunks", type=int, default=7,
                   help="Number of chunks to stitch (default: 7)")
    return p.parse_args()

def main():
    args = parse_args()
    suffix = "-tagged.jsonl" if args.v1 else "-tagged-v2.jsonl"
    out_name = "tag-suggestions-raw.jsonl" if args.v1 else "tag-suggestions-raw-v2.jsonl"
    OUT = REPO / "db" / out_name

    input_lines = 0
    output_lines = 0
    missing = []
    parse_errors = []
    all_records = []
    tag_counts = Counter()
    conf_counts = Counter()
    proposed_counts = Counter()
    unclassifiable = 0
    out_of_vocab_in_suggested = []    # records where a suggested_tag wasn't canonical
    primary_not_in_suggested = []     # records where primary ∉ suggested_tags
    aliased = 0

    for i in range(args.num_chunks):
        cin  = CHUNKS / f"chunk-{i:02d}.jsonl"
        cout = CHUNKS / f"chunk-{i:02d}{suffix}"
        if not cin.exists():
            print(f"[stitch] WARN: input chunk {cin.name} missing", file=sys.stderr)
            continue
        in_count = sum(1 for line in cin.read_text().splitlines() if line.strip())
        input_lines += in_count
        if not cout.exists():
            missing.append(cout.name)
            continue
        chunk_records = []
        for j, line in enumerate(cout.read_text().splitlines()):
            line = line.strip()
            if not line: continue
            try:
                r = json.loads(line)
            except Exception as e:
                parse_errors.append((cout.name, j, str(e)[:80]))
                continue

            # Normalize aliases on suggested_tags (R9 from scout: belt+suspenders)
            tags = r.get("suggested_tags", [])
            new_tags = []
            for t in tags:
                t2 = ALIASES.get(t, t)
                if t2 != t:
                    aliased += 1
                new_tags.append(t2)
            r["suggested_tags"] = new_tags

            # Also alias primary if it slipped
            if r.get("primary") in ALIASES:
                r["primary"] = ALIASES[r["primary"]]

            # Validate closed-set membership for v2
            if not args.v1:
                bad = [t for t in r["suggested_tags"] if t not in CANONICAL]
                if bad:
                    out_of_vocab_in_suggested.append((r.get("uuid","?"), bad))

                # If proposed_tag accidentally landed inside canonical, null it.
                pt = r.get("proposed_tag")
                if pt and pt in CANONICAL:
                    r["proposed_tag"] = None

            # primary ∈ suggested_tags assertion (R5 from scout)
            if r.get("primary") and r["primary"] not in r["suggested_tags"]:
                primary_not_in_suggested.append((r.get("uuid","?"), r.get("primary"), r["suggested_tags"]))

            for t in r["suggested_tags"]:
                tag_counts[t] += 1
            conf_counts[r.get("confidence", "?")] += 1
            if "unclassifiable" in r["suggested_tags"]:
                unclassifiable += 1
            pt = r.get("proposed_tag")
            if pt:
                proposed_counts[pt] += 1

            chunk_records.append(r)

        if len(chunk_records) != in_count:
            print(f"[stitch] WARN: {cout.name} has {len(chunk_records)} rows, expected {in_count}", file=sys.stderr)
        all_records.extend(chunk_records)
        output_lines += len(chunk_records)

    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in all_records) + "\n")

    print(f"[stitch] wrote {OUT}")
    print(f"[stitch] mode: {'v1 (open-vocab legacy)' if args.v1 else 'v2 (closed taxonomy)'}")
    print(f"[stitch] input lines : {input_lines}")
    print(f"[stitch] output lines: {output_lines}")
    print(f"[stitch] missing chunks: {missing or 'none'}")
    print(f"[stitch] parse errors: {len(parse_errors)}")
    for e in parse_errors[:5]: print(f"  {e}")
    print(f"[stitch] aliased tags (normalized at stitch): {aliased}")
    print(f"[stitch] unclassifiable: {unclassifiable}")
    print(f"[stitch] confidence: {dict(conf_counts)}")

    if not args.v1:
        print(f"[stitch] out-of-vocab in suggested_tags: {len(out_of_vocab_in_suggested)}")
        for uuid, bad in out_of_vocab_in_suggested[:5]:
            print(f"  {uuid}: {bad}")
        print(f"[stitch] primary∉suggested_tags violations: {len(primary_not_in_suggested)}")
        for uuid, pri, sug in primary_not_in_suggested[:5]:
            print(f"  {uuid}: primary={pri} suggested={sug}")

    print(f"[stitch] top 25 suggested tags:")
    for t, n in tag_counts.most_common(25):
        print(f"  {n:5d}  {t}")
    print(f"[stitch] total distinct tags: {len(tag_counts)}")

    if not args.v1:
        print()
        print(f"[stitch] notes with proposed_tag: {sum(proposed_counts.values())}")
        print(f"[stitch] distinct proposals: {len(proposed_counts)}")
        print(f"[stitch] top 25 proposed_tag (review threshold: ≥5):")
        for t, n in proposed_counts.most_common(25):
            marker = " ★" if n >= 5 else ""
            print(f"  {n:5d}  {t}{marker}")

if __name__ == "__main__":
    main()
