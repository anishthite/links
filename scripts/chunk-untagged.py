#!/usr/bin/env python3
"""
chunk-untagged.py — split db/clusters/untagged-notes.jsonl into N chunks for
parallel subagent fanout. Each chunk also carries the note's cluster_id so the
per-note tagger can use cluster context as a hint.

Usage:  python3 scripts/chunk-untagged.py [N=20]
"""
import json
import sys
from pathlib import Path

REPO   = Path(__file__).resolve().parent.parent
SRC    = REPO / "db" / "clusters" / "untagged-notes.jsonl"
CLUS   = REPO / "db" / "clusters" / "clusters.jsonl"
OUT    = REPO / "db" / "chunks"
N      = int(sys.argv[1] if len(sys.argv) > 1 else "20")

OUT.mkdir(parents=True, exist_ok=True)

# Load cluster assignment.
cluster_of = {}
for line in CLUS.read_text().splitlines():
    if not line.strip(): continue
    r = json.loads(line)
    cluster_of[r["uuid"]] = r["cluster_id"]

# Load notes.
notes = []
for line in SRC.read_text().splitlines():
    if not line.strip(): continue
    n = json.loads(line)
    n["cluster_id"] = cluster_of.get(n["uuid"], -1)
    notes.append(n)

# Round-robin into N chunks (balances cluster mix across chunks).
chunks = [[] for _ in range(N)]
for i, n in enumerate(notes):
    chunks[i % N].append(n)

for i, chunk in enumerate(chunks):
    p = OUT / f"chunk-{i:02d}.jsonl"
    p.write_text("\n".join(json.dumps(n, ensure_ascii=False) for n in chunk) + "\n")

print(f"[chunk] wrote {N} chunks to {OUT} (sizes: {[len(c) for c in chunks]})", file=sys.stderr)
