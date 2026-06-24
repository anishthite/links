#!/usr/bin/env python3
"""
stitch-suggestions-r3.py — round-3 variant of stitch-suggestions.py.

Concatenates db/round3/round3-NN-tagged-v2.jsonl into
db/round3/tag-suggestions-raw-r3.jsonl with the same validations + alias
normalization as the round-2 stitcher. Kept as a separate file (instead of
adding flags to the original) to avoid clobbering db/tag-suggestions-raw-v2.jsonl
during the incremental pass. The round-2 final.jsonl is the historical record;
round-3 lives in db/round3/ until merged at load time.

Defaults to 4 chunks (round-3 fanout shape).
"""
import argparse
import json
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CHUNKS = REPO / "db" / "round3"

# Canonical 32-tag taxonomy (mirrors stitch-suggestions.py + db/eval/taxonomy.md).
CANONICAL = {
    "idea","ai","thought","quote","link","llm","article","mental-model",
    "humor","robotics","question","unclassifiable","health","tweet","hot-take",
    "lesson","infra","hardware","philosophy","todo","reading-list","physics",
    "commerce","social","ml","design","writing","finance","to-learn",
    "people","transportation","watch-list",
}

ALIASES = {
    "gpt": "ai",
    "questions": "question",
    "mental": "mental-model",
    "hot take": "hot-take",
    "contact": "people",
    "watchlist": "watch-list",
}


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("-n", "--num-chunks", type=int, default=4,
                   help="Number of chunks to stitch (default: 4)")
    return p.parse_args()


def main():
    args = parse_args()
    suffix = "-tagged-v2.jsonl"
    OUT = REPO / "db" / "round3" / "tag-suggestions-raw-r3.jsonl"

    input_lines = 0
    output_lines = 0
    missing = []
    parse_errors = []
    all_records = []
    tag_counts = Counter()
    conf_counts = Counter()
    proposed_counts = Counter()
    unclassifiable = 0
    out_of_vocab_in_suggested = []
    primary_not_in_suggested = []
    aliased = 0

    for i in range(args.num_chunks):
        cin = CHUNKS / f"round3-{i:02d}.jsonl"
        cout = CHUNKS / f"round3-{i:02d}{suffix}"
        if not cin.exists():
            print(f"[stitch-r3] WARN: input chunk {cin.name} missing", file=sys.stderr)
            continue
        in_count = sum(1 for line in cin.read_text().splitlines() if line.strip())
        input_lines += in_count
        if not cout.exists():
            missing.append(cout.name)
            continue

        for lineno, line in enumerate(cout.read_text().splitlines(), 1):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError as e:
                parse_errors.append(f"{cout.name}:{lineno} {e}")
                continue

            # Alias normalize suggested_tags + primary
            tags = r.get("suggested_tags", [])
            new_tags = []
            for t in tags:
                t2 = ALIASES.get(t, t)
                if t2 != t:
                    aliased += 1
                new_tags.append(t2)
            r["suggested_tags"] = new_tags
            if r.get("primary") in ALIASES:
                r["primary"] = ALIASES[r["primary"]]

            # Validate closed-set
            bad = [t for t in r["suggested_tags"] if t not in CANONICAL]
            if bad:
                out_of_vocab_in_suggested.append((r.get("uuid", "?"), bad))
            # Drop a proposed_tag that accidentally landed in-vocab
            if r.get("proposed_tag") in CANONICAL:
                r["proposed_tag"] = None
            # primary ∈ suggested_tags
            if r.get("primary") not in r["suggested_tags"]:
                primary_not_in_suggested.append(
                    (r.get("uuid", "?"), r.get("primary"), r["suggested_tags"])
                )

            for t in r["suggested_tags"]:
                tag_counts[t] += 1
            conf_counts[r.get("confidence", "?")] += 1
            if r.get("primary") == "unclassifiable":
                unclassifiable += 1
            if r.get("proposed_tag"):
                proposed_counts[r["proposed_tag"]] += 1

            all_records.append(r)
            output_lines += 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w") as f:
        for r in all_records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    print(f"[stitch-r3] wrote {OUT}")
    print(f"[stitch-r3] input lines : {input_lines}")
    print(f"[stitch-r3] output lines: {output_lines}")
    print(f"[stitch-r3] missing chunks: {missing or 'none'}")
    print(f"[stitch-r3] parse errors: {len(parse_errors)}")
    for e in parse_errors[:5]:
        print(f"  {e}")
    print(f"[stitch-r3] aliased tags (normalized at stitch): {aliased}")
    print(f"[stitch-r3] unclassifiable: {unclassifiable}")
    print(f"[stitch-r3] confidence: {dict(conf_counts)}")
    print(f"[stitch-r3] out-of-vocab in suggested_tags: {len(out_of_vocab_in_suggested)}")
    for uuid, bad in out_of_vocab_in_suggested[:5]:
        print(f"  {uuid}: {bad}")
    print(f"[stitch-r3] primary∉suggested_tags violations: {len(primary_not_in_suggested)}")
    for uuid, pri, sug in primary_not_in_suggested[:5]:
        print(f"  {uuid}: primary={pri} suggested={sug}")

    print(f"[stitch-r3] top 25 suggested tags:")
    for t, n in tag_counts.most_common(25):
        print(f"  {n:5d}  {t}")
    print(f"[stitch-r3] total distinct tags: {len(tag_counts)}")

    print()
    print(f"[stitch-r3] notes with proposed_tag: {sum(proposed_counts.values())}")
    print(f"[stitch-r3] distinct proposals: {len(proposed_counts)}")
    print(f"[stitch-r3] top 25 proposed_tag (review threshold: \u22655):")
    for t, n in proposed_counts.most_common(25):
        marker = " \u2605" if n >= 5 else ""
        print(f"  {n:5d}  {t}{marker}")


if __name__ == "__main__":
    main()
