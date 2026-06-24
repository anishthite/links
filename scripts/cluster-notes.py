#!/usr/bin/env python3
"""
cluster-notes.py — quick TF-IDF + MiniBatchKMeans clustering of the untagged
notes corpus. Outputs:

  db/clusters/clusters.jsonl       — one row per note: {uuid, cluster_id, distance}
  db/clusters/cluster-summary.json — per-cluster: size, top terms, 5 exemplars
  db/clusters/untagged-notes.jsonl — flat list of all untagged notes (for chunking)

Why TF-IDF (not semantic embeddings):
  - Goal here is *taxonomy discovery*, not semantic search.
  - Cluster-labeling subagent (next step) gets exemplars + top terms and produces
    a real label per cluster — that's where semantic quality enters the pipeline.
  - Zero setup, runs in ~5s. Workers AI embeddings come later (Phase 7).
"""

from __future__ import annotations
import json
import re
import sys
from pathlib import Path

import numpy as np
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import normalize
from sentence_transformers import SentenceTransformer

# ---- config (override via env if needed) -----------------------------------
HERE      = Path(__file__).resolve().parent
REPO      = HERE.parent
SRC       = REPO / "newnotes.json"
OUT_DIR   = REPO / "db" / "clusters"
K         = int((sys.argv[1] if len(sys.argv) > 1 else "20"))
SEED      = 42
TOP_TERMS = 12
EXEMPLARS = 5

OUT_DIR.mkdir(parents=True, exist_ok=True)
EMBED_MODEL = "sentence-transformers/all-MiniLM-L6-v2"  # 384-dim, 90MB, fast

# ---- parse hashtags (mirrors src/lib/colors.ts:parseTags) -------------------
HASHTAG_RE = re.compile(r"(?:^|[\s\(])#([a-zA-Z][a-zA-Z0-9_-]*)")
def existing_tags(text: str) -> list[str]:
    return [m.lower() for m in HASHTAG_RE.findall(text or "")]

# ---- load + filter ----------------------------------------------------------
raw = json.loads(SRC.read_text())
notes = raw if isinstance(raw, list) else list(raw.values())

untagged = []
for n in notes:
    text = (n.get("text") or "").strip()
    if not text:                       continue
    if existing_tags(text):            continue
    if "tags" in n and n["tags"]:      continue
    untagged.append({"uuid": n.get("uuid") or n["_id"]["$oid"], "text": text})

print(f"[cluster] total={len(notes)} untagged={len(untagged)} k={K}", file=sys.stderr)

# Write the flat untagged file for downstream chunking.
(OUT_DIR / "untagged-notes.jsonl").write_text(
    "\n".join(json.dumps(u, ensure_ascii=False) for u in untagged) + "\n"
)

# ---- embed ------------------------------------------------------------------
# Semantic embeddings (not TF-IDF). First-run attempt with TF-IDF (word + char
# ngrams) failed catastrophically — 1,705/1,728 notes collapsed into one
# mega-cluster (silhouette -0.015). Root cause: notes average ~70 chars and
# semantically-related fragments share near-zero tokens. Lexical features can't
# bridge that gap. Embeddings can.
texts = [u["text"] for u in untagged]
print(f"[cluster] loading model {EMBED_MODEL} …", file=sys.stderr)
model = SentenceTransformer(EMBED_MODEL)
print(f"[cluster] embedding {len(texts)} notes …", file=sys.stderr)
E = model.encode(
    texts,
    batch_size=64,
    show_progress_bar=True,
    convert_to_numpy=True,
    normalize_embeddings=True,  # unit-length → cosine = dot product
)
X = E  # dense float32 array, shape (n, 384), L2-normalized
print(f"[cluster] embedded matrix: {X.shape[0]} docs × {X.shape[1]} dims", file=sys.stderr)

# Keep tfidf vectorizer around just for top-terms-per-cluster labeling (read on).
# It runs on the same texts but its job is descriptive, not for clustering.
vec = TfidfVectorizer(
    lowercase=True, stop_words="english",
    ngram_range=(1, 2), min_df=2, max_df=0.6,
    max_features=15_000, norm="l2", sublinear_tf=True,
)
X_tfidf = vec.fit_transform(texts)

# ---- cluster ----------------------------------------------------------------
# Full KMeans on dense 384-d vectors is cheap (n=1.7k). n_init=20 for stability.
km = KMeans(
    n_clusters=K,
    random_state=SEED,
    n_init=20,
    max_iter=500,
)
labels = km.fit_predict(X)

# Quick silhouette on a sample (full silhouette on 1.7k×20k is slow).
sample_idx = np.random.default_rng(SEED).choice(X.shape[0], size=min(500, X.shape[0]), replace=False)
sil = silhouette_score(X[sample_idx], labels[sample_idx], metric="cosine")
print(f"[cluster] silhouette (cosine, n=500 sample) = {sil:.3f}", file=sys.stderr)

# Distance-to-centroid (Euclidean in unit-sphere ≈ √(2 - 2·cos_sim)).
centroids = km.cluster_centers_
dists = np.linalg.norm(X - centroids[labels], axis=1)

# ---- write per-note cluster file --------------------------------------------
clusters_jsonl = OUT_DIR / "clusters.jsonl"
with clusters_jsonl.open("w") as f:
    for u, c, d in zip(untagged, labels, dists):
        f.write(json.dumps({
            "uuid": u["uuid"],
            "cluster_id": int(c),
            "distance": float(d),
        }) + "\n")

# ---- per-cluster summary ----------------------------------------------------
feat_names = np.array(vec.get_feature_names_out())
summary = []
for c in range(K):
    member_idx = np.where(labels == c)[0]
    if len(member_idx) == 0:
        summary.append({"cluster_id": c, "size": 0, "top_terms": [], "exemplars": []})
        continue

    # Top terms come from the *tfidf* projection of cluster members (not the
    # embedding centroid — embedding dims aren't human-readable). Sum tfidf
    # weights across members, pick highest.
    cluster_tfidf = X_tfidf[member_idx].sum(axis=0)
    cluster_tfidf = np.asarray(cluster_tfidf).ravel()
    top_term_idx = np.argsort(cluster_tfidf)[::-1][:TOP_TERMS]
    top_terms = [feat_names[int(i)] for i in top_term_idx if cluster_tfidf[int(i)] > 0]

    # Exemplars = members closest to centroid.
    member_dists = dists[member_idx]
    exemplar_member_idx = member_idx[np.argsort(member_dists)[:EXEMPLARS]]
    exemplars = [
        {
            "uuid": untagged[int(i)]["uuid"],
            "text": untagged[int(i)]["text"][:400],
            "distance": float(dists[int(i)]),
        }
        for i in exemplar_member_idx
    ]

    summary.append({
        "cluster_id": c,
        "size": int(len(member_idx)),
        "top_terms": top_terms,
        "exemplars": exemplars,
    })

# Sort clusters by size desc so the labeler sees big ones first.
summary.sort(key=lambda s: -s["size"])

(OUT_DIR / "cluster-summary.json").write_text(json.dumps({
    "k": K,
    "n_docs": int(X.shape[0]),
    "silhouette_sample": float(sil),
    "tfidf_features": int(X.shape[1]),
    "clusters": summary,
}, ensure_ascii=False, indent=2))

# ---- METRIC lines for autoresearch parsing (harmless if not used) ----------
print(f"METRIC silhouette={sil:.4f}")
print(f"METRIC n_clusters={K}")
print(f"METRIC n_docs={X.shape[0]}")
print(f"METRIC empty_clusters={sum(1 for s in summary if s['size']==0)}")
print(f"[cluster] wrote {clusters_jsonl} + cluster-summary.json + untagged-notes.jsonl", file=sys.stderr)
