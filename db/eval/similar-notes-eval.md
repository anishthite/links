# Similar-notes retrieval eval

- Corpus: **2402** notes (local)
- Golden notes available: **50**
- Current live deterministic method: **chargram**
- Strict winner: **embedding_hybrid**
- Proxy winner: **overlap**
- Recommended live method: **chargram** (strict gold-peer benchmark)

## Strict benchmark
gold queries vs gold candidate pool; relevance = shared accepted golden tags

Queries: **49**

| Rank | Method | recall@10 | MRR@10 | hit@1 | hit@3 | mean relevant |
|---:|---|---:|---:|---:|---:|---:|
| 1 | embedding_hybrid | 0.4198 | 0.8010 | 0.6939 | 0.9184 | 16.78 |
| 2 | embedding_cosine | 0.3535 | 0.7515 | 0.6531 | 0.8571 | 16.78 |
| 3 | chargram | 0.3990 | 0.7445 | 0.6327 | 0.8367 | 16.78 |
| 4 | hybrid_rrf | 0.4348 | 0.7425 | 0.5918 | 0.8776 | 16.78 |
| 5 | hybrid_weighted | 0.4340 | 0.7306 | 0.5714 | 0.8776 | 16.78 |
| 6 | overlap | 0.2665 | 0.5655 | 0.4898 | 0.6122 | 16.78 |
| 7 | bm25 | 0.2686 | 0.5330 | 0.4082 | 0.6531 | 16.78 |

## Proxy benchmark
gold queries vs full corpus; relevance = overlap between golden query tags and stored note.tags

Queries: **50**

| Rank | Method | recall@10 | MRR@10 | hit@1 | hit@3 | mean relevant |
|---:|---|---:|---:|---:|---:|---:|
| 1 | overlap | 0.0407 | 1.0000 | 1.0000 | 1.0000 | 541.20 |
| 2 | hybrid_weighted | 0.0382 | 0.9800 | 0.9600 | 1.0000 | 541.20 |
| 3 | hybrid_rrf | 0.0391 | 0.9500 | 0.9000 | 1.0000 | 541.20 |
| 4 | chargram | 0.0386 | 0.9500 | 0.9000 | 1.0000 | 541.20 |
| 5 | bm25 | 0.0290 | 0.9300 | 0.8800 | 1.0000 | 541.20 |
