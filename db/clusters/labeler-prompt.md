# Cluster labeling task

You are labeling 20 clusters of personal notes drawn from a 1,728-note corpus
(short fragments, idea dumps, links, opinions). Clusters were produced by
all-MiniLM-L6-v2 embeddings + KMeans. Your job is to give each cluster a
concrete name, a primary tag, and flag merges or noise.

## Input

Read `/Users/anishthite/workspace/board/db/clusters/cluster-summary.json`.

Each cluster has: `cluster_id`, `size`, `top_terms` (12 highest-TFIDF terms),
and `exemplars` (5 notes closest to centroid, each with text + uuid).

## Existing tag palette

The app already has these 10 hand-tuned tags (with colors). Prefer these names
where they fit, but invent new ones where they clearly don't:

```
todo, shop, idea, board, thought, infra, lesson, reminder, people, hot-take
```

## Output — write BOTH files

### 1. `/Users/anishthite/workspace/board/db/clusters/labels.json`

```json
{
  "clusters": [
    {
      "cluster_id": 7,
      "size": 109,
      "proposed_name": "ai-products",
      "description": "Product/startup ideas built around AI or LLMs.",
      "primary_tag": "idea",
      "alternative_tags": ["ai", "startup"],
      "confidence": "high",
      "flag": null,
      "merge_with": null
    },
    ...
  ]
}
```

### 2. `/Users/anishthite/workspace/board/db/clusters/proposal.md`

Markdown table, sorted by size desc:

```
| id | size | name | primary | alts | conf | flag | description |
|----|------|------|---------|------|------|------|-------------|
| 7  | 109  | ai-products | idea | ai, startup | high | — | Product/startup ideas built around AI or LLMs. |
| 11 | 78   | shopping-ideas | shop | commerce | high | — | Shopping/commerce product ideas. |
...
```

Then a "## Recommendations" section listing:
- **Merges** — pairs/triples of clusters that should collapse
- **Splits** — clusters with multiple themes worth separating
- **Noise** — clusters that are garbage (URL fragments, contact info, etc.)

## Guidelines

- Look at **top_terms AND all 5 exemplars** before deciding. Top terms alone
  can mislead (function words leak in). Exemplars reveal the actual theme.
- Names are **1–3 word kebab-case**: `ai-products`, `philosophy`, `url-dumps`.
- Prefer **specific** over generic. "ideas" is useless; "ai-products" is useful.
- If two clusters look like the same thing (e.g. 5 AI-flavored clusters in this
  corpus), flag them as merge candidates — propose which one absorbs which.
- `primary_tag` must be either from the existing palette OR a new tag name
  (lowercase kebab-case). Don't put more than one tag in `primary_tag`.
- Confidence: `high` = obvious theme; `medium` = readable but loose;
  `low` = mixed bag or noisy.
- Use `flag: "noise"` for clusters that are actual garbage (URL-only, gibberish,
  contact info). Use `flag: "split"` if it should split. Otherwise `null`.

## Validation contract

Before exiting:
- `labels.json` parses as JSON with exactly 20 entries (one per cluster_id 0..19).
- `proposal.md` has 20 table rows + a Recommendations section.
- Every cluster has either a primary_tag from the palette OR a new name (not blank).
- Print "DONE" on the last line of your response.

## Escalation

If a cluster's exemplars contradict each other so badly you can't pick a theme,
set `confidence: "low"` and `flag: "split"` with a `description` listing the
two themes you see. Do not invent a forced theme.
