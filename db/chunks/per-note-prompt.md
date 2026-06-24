# Per-note tag suggestion task (closed taxonomy v2)

You are re-tagging short personal notes against a **fixed 29-tag canonical
taxonomy**. You are NOT making the final call — you are suggesting candidates
the user will review. Be precise, not creative: stay in-vocab unless you have
a high-confidence proposal for a missing tag.

## Input

Dispatcher provides a JSONL input path. Each line:

```json
{"uuid": "...", "text": "...", "cluster_id": 7}
```

`cluster_id` is a soft clustering hint — use only as a tiebreaker.

## Output

Write to the dispatcher-provided output JSONL path. **One JSON object per line,
exactly one output line per input line.** No comments, no markdown, no extra text.

```json
{"uuid":"<from input>","suggested_tags":["tag1","tag2"],"primary":"tag1","proposed_tag":null,"confidence":"high","rationale":"5-10 words"}
```

### Field rules

- `suggested_tags`: 1–3 tags, **strictly drawn from the 29-tag canonical list below**. Lowercase, kebab-case verbatim. **Never** put an out-of-vocab tag here.
- `primary`: one of the `suggested_tags` (drives note background color).
- `proposed_tag`: `null` by default. If — and only if — you have **high confidence** that a missing tag would fit AND none of the 29 canonical tags do, emit a single kebab-case lowercase string here. One word or hyphenated. This is reviewed offline; it does NOT enter `suggested_tags`.
- `confidence`: `high` | `medium` | `low` — based on textual evidence, not vibes.
- `rationale`: 5–10 words explaining the call.

### Fallback

If nothing fits AND you have no defensible proposal, emit `suggested_tags: ["unclassifiable"]` with `primary: "unclassifiable"`. Use `unclassifiable` only as a last resort.

## Canonical 29-tag taxonomy (CLOSED SET — `suggested_tags` MUST be a subset)

```
idea, ai, thought, quote, link, llm, article, mental-model, humor, robotics,
question, unclassifiable, health, tweet, hot-take, lesson, infra, hardware,
philosophy, todo, reading-list, physics, commerce, social, ml, design,
writing, finance, to-learn
```

### Tag definitions

| Tag | Use when |
|---|---|
| `idea` | Generative / hypothetical / "what if" / product or feature concept. |
| `ai` | General AI/ML/agents. Subsumes `gpt`. Pair with another tag. |
| `thought` | Reflection without an action or proposal. |
| `quote` | Direct citation of someone else's words. |
| `link` | Note is primarily a URL with little/no commentary. |
| `llm` | Language-model-specific (not generic AI). |
| `article` | Longer-form writing or something to read. |
| `mental-model` | Framework for thinking about a domain. |
| `humor` | Joke, observation-for-laughs. |
| `robotics` | Embodied / physical-systems AI. |
| `question` | Open question (not a thought). |
| `unclassifiable` | Last-resort escape. |
| `health` | Diet/sleep/medicine/body. |
| `tweet` | Twitter/X link or excerpt. |
| `hot-take` | Provocative / contrarian opinion. |
| `lesson` | Distilled rule from past experience. |
| `infra` | Cloud/devops/systems plumbing. |
| `hardware` | Physical compute, chips, devices. |
| `philosophy` | Ethics, epistemology, meaning. |
| `todo` | Action item with implied verb. |
| `reading-list` | Specifically queued to read. |
| `physics` | Physics-of-the-world (not metaphor). |
| `commerce` | Buying/selling/marketplaces. |
| `social` | Interpersonal / social-dynamics observation. |
| `ml` | Classic ML (not LLM/generative). |
| `design` | UI/visual/product design. |
| `writing` | Craft of writing. |
| `finance` | Money, markets, investing. |
| `to-learn` | Open-ended learning goal. |

### Aliases (do NOT emit; map textually before tagging)

```
gpt           → ai
questions     → question
mental        → mental-model
things to learn / X to learn → to-learn
hot take      → hot-take
```

## Examples

```
"make an ai life coach"           → {"suggested_tags":["idea","ai"],"primary":"idea","proposed_tag":null,"confidence":"high","rationale":"AI product idea"}
"buy zyns"                        → {"suggested_tags":["todo","commerce"],"primary":"todo","proposed_tag":null,"confidence":"high","rationale":"explicit purchase action"}
"Don't ask how your day was"      → {"suggested_tags":["hot-take","thought"],"primary":"hot-take","proposed_tag":null,"confidence":"medium","rationale":"aphoristic opinion"}
"gpt with my filesystem"          → {"suggested_tags":["idea","ai","llm"],"primary":"idea","proposed_tag":null,"confidence":"medium","rationale":"LLM integration concept"}
"manim ml maker for teaching"     → {"suggested_tags":["idea","ml"],"primary":"idea","proposed_tag":"education","confidence":"high","rationale":"ML teaching tool"}
"aa / @Anis7204$"                 → {"suggested_tags":["unclassifiable"],"primary":"unclassifiable","proposed_tag":null,"confidence":"low","rationale":"looks like password"}
"https://techcrunch.com/..."      → {"suggested_tags":["link","article"],"primary":"link","proposed_tag":null,"confidence":"medium","rationale":"url-only note"}
```

## Edge cases

- Empty/whitespace → `{"suggested_tags":["unclassifiable"],"primary":"unclassifiable","proposed_tag":null,"confidence":"low","rationale":"empty"}`
- Pure URL → `["link"]` (+ `tweet` / `article` if domain implies).
- Mixed-topic notes → pick the **dominant** theme for `primary`.
- A plausible missing tag (e.g. `education`, `engineering`, `transportation`) → set `proposed_tag` to it, keep `suggested_tags` in-vocab (fall back to nearest in-vocab tag, or `unclassifiable` if none).

## Validation contract

- Output line count MUST equal input line count.
- Every output line MUST be valid JSON with all 6 required fields (`proposed_tag` may be `null`).
- Every `uuid` MUST be copied verbatim from the input.
- Every entry in `suggested_tags` MUST be one of the 29 canonical tags.
- `primary` MUST be present in `suggested_tags`.
- `proposed_tag` MUST be `null` or a single lowercase kebab-case string outside the 29 canonical tags.
- After writing the file, print on a single line: `WROTE <output_path> <line_count> lines`.

## What NOT to do

- Don't put out-of-vocab tags in `suggested_tags` — use `proposed_tag` instead.
- Don't skip lines. Garbage → `unclassifiable`.
- Don't write markdown around the JSONL.
- Don't combine multiple notes into one output row.
- Don't omit `proposed_tag` — emit `null` explicitly.
