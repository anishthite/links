# Canonical tag taxonomy — derived from golden-50

> Source of truth for the closed-set classifier re-run on the 1,758 untagged notes.
> Anchored in the user's hand-tagged sample (`golden-50.jsonl`) + the existing palette anchors in `src/lib/colors.ts`.

## How this was built

1. Counted every tag used in `golden-50.jsonl` (50 notes, 31 from suggestion, 19 manual).
2. Reversed the CLI tokenization noise — the hand-tag CLI splits on `[,\s]+`, so multi-word tags came out fragmented:
   - `["things","to","learn"]`  → `to-learn`
   - `["hot","take","lesson","quote"]`  → `hot-take, lesson, quote`
   - `["physics","to","learn"]`  → `physics, to-learn`
   - `["questions","thought"]`  → `question, thought` (singular)
3. Dropped pure noise (`"1"` from `["1","quote"]`).
4. Folded one alias (`gpt` → `ai`; it's a model, not a category).
5. ~~Merged in the 4 anchors already wired into `TAG_COLORS`/`TAG_BG`~~ — **dropped per user decision** (see Decisions Resolved below). The canonical set is strictly user-derived from golden-50.

## Decisions resolved

| # | Decision | Choice |
|---|---|---|
| 1 | AI-family granularity | Keep `ai`, `llm`, `ml` as 3 distinct tags |
| 2 | Palette-only anchors (`shop`, `board`, `reminder`, `people`) | **Drop** from classifier set — strict user-derived taxonomy. (Palette entries stay in `colors.ts` so they still render if a `#hashtag` adds them manually.) |
| 3 | Open-vocab escape hatch | **Gated proposals** — classifier emits a separate `proposed_tag` field outside the closed set when it has high confidence a missing tag fits. We review and either accept-into-taxonomy or remap. `unclassifiable` only when truly nothing applies. |

## Canonical list (32 tags as of round-2 promotion)

> Round-1 closed-set: 29 tags. After `proposed_tag` review on the 1,728-note corpus, 3 tags promoted from worker proposals: `people` (7), `transportation` (6), `watch-list` (6). `contact` (3) folds into `people`.

| Tag | Source | Count in golden-50 | Notes |
|---|---|---:|---|
| `idea` | golden + palette | 27 | Workhorse — anything generative / hypothetical / "what if". |
| `ai` | golden + palette? | 15 | General AI/ML/agents. Subsumes `gpt`. |
| `thought` | golden + palette | 7 | Reflection without an action or proposal. |
| `quote` | golden | 5 | Direct citation of someone else's words. |
| `link` | golden | 5 | Note is primarily a URL with little/no commentary. |
| `llm` | golden | 3 | Language-model specific (vs broader `ai`). |
| `article` | golden | 2 | Longer-form writing / something to read. |
| `mental-model` | golden ("mental") | 2 | Framework for thinking about a domain. |
| `humor` | golden | 2 | Joke, observation-for-laughs. |
| `robotics` | golden | 2 | Embodied / physical-systems AI. |
| `question` | golden ("question" + "questions") | 2 | Open question, not a thought. |
| `unclassifiable` | golden | 2 | Last-resort escape. Classifier MUST use this rather than invent. |
| `health` | golden | 1 | Diet/sleep/medicine/body. |
| `tweet` | golden | 1 | Twitter/X link or excerpt. |
| `hot-take` | golden ("hot"+"take") + palette | 1 | Provocative / contrarian opinion. |
| `lesson` | golden + palette | 1 | Distilled rule from past experience. |
| `infra` | golden + palette | 1 | Cloud/devops/systems plumbing. |
| `hardware` | golden | 1 | Physical compute, chips, devices. |
| `philosophy` | golden | 1 | Ethics, epistemology, meaning. |
| `todo` | golden + palette | 1 | Action item with implied verb. |
| `reading-list` | golden | 1 | Specifically queued to read. |
| `physics` | golden | 1 | Physics-of-the-world (not metaphor). |
| `commerce` | golden | 1 | Buying/selling/marketplaces (broader than `shop`). |
| `social` | golden | 1 | Interpersonal / social-dynamics observation. |
| `ml` | golden | 1 | Classic ML (not LLM/generative). |
| `design` | golden | 1 | UI/visual/product design. |
| `writing` | golden | 1 | Craft of writing. |
| `finance` | golden | 1 | Money, markets, investing. |
| `to-learn` | golden ("things to learn","physics to learn") | 1+ | Open-ended learning goal. |
| `people` | promoted round-2 (7 proposals) + dropped palette anchor | — | Named human, relationship note, contact info. Absorbs `contact`. |
| `transportation` | promoted round-2 (6 proposals) | — | Cars, trains, flights, road/transit infrastructure. |
| `watch-list` | promoted round-2 (6 proposals) | — | Movies/shows/videos queued to watch (sibling of `reading-list`). |

## Aliases / normalizations (classifier post-processing)

```
"questions"   → question
"mental"      → mental-model
"gpt"         → ai
"things"      → to-learn        (when adjacent to "to" / "learn")
"learn"       → to-learn
"hot" + "take" → hot-take       (when adjacent)
"1"           → (drop)
"contact"     → people          (round-2 promotion fold)
"watchlist"   → watch-list      (kebab-case dedup of round-2 proposals)
```

## Classifier contract (closed set + gated proposals)

- Choose 1–3 `suggested_tags` **only** from the canonical 29 above.
- One MUST be designated `primary` (drives note background color).
- If you have **high** confidence that a missing tag would fit AND none of the 29 do, emit a single string in `proposed_tag` (kebab-case, lowercase, one word or hyphenated). Otherwise `proposed_tag: null`.
- If nothing fits and you have no defensible proposal, emit `suggested_tags: ["unclassifiable"]`. **Never put an out-of-vocab tag into `suggested_tags`.**
- `confidence`: `high` / `medium` / `low` based on textual evidence, not vibes.
- Output schema (per-line JSONL):
  ```json
  {
    "uuid": "...",
    "suggested_tags": ["ai","idea"],
    "primary": "idea",
    "proposed_tag": null,
    "confidence": "high",
    "rationale": "short string"
  }
  ```

## Review flow for `proposed_tag`

After the fanout, the parent will:
1. Aggregate all `proposed_tag` values across the 1,728 notes.
2. Rank by frequency. Threshold: a proposal must appear ≥5 times to be considered.
3. Surface the ranked list to the user. Each candidate gets one of three fates:
   - **Accept** → added to canonical list + palette color assigned.
   - **Remap** → rewritten to an existing canonical tag (e.g. `contact` → `people`).
   - **Reject** → affected notes fall back to their non-proposed `suggested_tags`.
4. A second light pass re-stitches with the user's decisions baked in.

### Round-2 promotion outcome (resolved)

| Proposal | Count | Decision |
|---|---:|---|
| `people` | 7 | **Accept** as canonical |
| `transportation` | 6 | **Accept** as canonical |
| `watch-list` | 6 | **Accept** as canonical |
| `work-log` | 5 | **Reject** — overlaps with `thought` / `lesson` |
| `contact` | 3 | **Remap** → `people` |
| `journal` | 2 | **Reject** — falls back to suggested_tags |
| `education` | 4 | **Reject** — below threshold |
| `security` | 4 | **Reject** — below threshold |
| all others | 1–2 | **Reject** — below threshold |

Final output: `db/tag-suggestions-final.jsonl` (produced by `scripts/apply-promotions.py`).
