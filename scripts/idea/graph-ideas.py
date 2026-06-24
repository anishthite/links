#!/usr/bin/env python3
"""
graph-ideas.py — read board-db notes from stdin (D1 JSON), plot ideas over time.

Input: the JSON document produced by
       `wrangler d1 execute board-db --remote --json --command "SELECT ..."`
       piped on stdin.

Outputs (written next to this script):
       ideas-over-time.png   — 5-panel static chart
       ideas-over-time.html  — same data, interactive (Plotly) IF plotly is installed,
                               else a small HTML wrapper around the PNG.
       ideas-summary.json    — headline numbers (total, per-year, top tags, streaks)

The script is opinionated about what "an idea" is:
  - Any note whose `tags` JSON array contains "idea", OR
  - Any note whose text contains the literal "#idea" hashtag.
That captures both the curated and the raw-from-Apple-Notes flow.
"""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HERE = Path(__file__).resolve().parent
OUT_PNG = HERE / "ideas-over-time.png"
OUT_HTML = HERE / "ideas-over-time.html"
OUT_JSON = HERE / "ideas-summary.json"

# Tags that count as ideas. Everything else is "context".
IDEA_TAG = "idea"
HASHTAG_RX = re.compile(r"#([a-zA-Z][\w-]*)")

# How many sub-topics to show in stacked-area / bar charts.
TOP_N_TOPICS = 10


# ---------------------------------------------------------------------------
# Load
# ---------------------------------------------------------------------------
def load_notes_from_stdin() -> pd.DataFrame:
    raw = sys.stdin.read()
    if not raw.strip():
        sys.exit("graph-ideas.py: no input on stdin — pipe wrangler JSON in.")

    doc = json.loads(raw)
    # wrangler d1 --json returns: [ { results: [...], success: true, meta: {...} } ]
    if isinstance(doc, list):
        rows = []
        for stmt in doc:
            rows.extend(stmt.get("results", []))
    elif isinstance(doc, dict) and "results" in doc:
        rows = doc["results"]
    else:
        sys.exit("graph-ideas.py: unrecognized JSON shape from wrangler.")

    if not rows:
        sys.exit("graph-ideas.py: query returned 0 rows.")

    df = pd.DataFrame(rows)

    # Normalize types
    df["tags_list"] = df["tags"].fillna("[]").apply(_safe_json_list)
    df["created_at"] = pd.to_datetime(df["created_at"], unit="ms", utc=True)
    df["created_local"] = df["created_at"].dt.tz_convert("America/Los_Angeles")
    df["year"] = df["created_local"].dt.year
    df["month"] = df["created_local"].dt.to_period("M").dt.to_timestamp()
    df["weekday"] = df["created_local"].dt.day_name()
    df["hour"] = df["created_local"].dt.hour

    df["hashtags"] = df["text"].fillna("").apply(lambda s: [m.lower() for m in HASHTAG_RX.findall(s)])
    df["all_tags"] = df.apply(lambda r: list({*r["tags_list"], *r["hashtags"]}), axis=1)
    df["is_idea"] = df["all_tags"].apply(lambda ts: IDEA_TAG in ts)

    return df


def _safe_json_list(s: str) -> list[str]:
    try:
        v = json.loads(s)
        return [t.lower() for t in v] if isinstance(v, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


# ---------------------------------------------------------------------------
# Analysis helpers
# ---------------------------------------------------------------------------
def top_subtopics(ideas: pd.DataFrame, n: int = TOP_N_TOPICS) -> list[str]:
    """Most common companion tags on idea-notes, excluding 'idea' itself."""
    c: Counter[str] = Counter()
    for tags in ideas["all_tags"]:
        for t in tags:
            if t == IDEA_TAG:
                continue
            c[t] += 1
    return [t for t, _ in c.most_common(n)]


def monthly_counts(ideas: pd.DataFrame) -> pd.Series:
    return ideas.groupby("month").size().rename("ideas").sort_index()


def monthly_by_topic(ideas: pd.DataFrame, topics: list[str]) -> pd.DataFrame:
    """One column per topic, plus 'other'."""
    rows = []
    for _, r in ideas.iterrows():
        bucket = "other"
        for t in topics:  # priority = popularity order
            if t in r["all_tags"]:
                bucket = t
                break
        rows.append({"month": r["month"], "bucket": bucket})
    if not rows:
        return pd.DataFrame()
    by = pd.DataFrame(rows)
    pivot = by.groupby(["month", "bucket"]).size().unstack(fill_value=0)
    # Stable column order: topics first, 'other' last
    cols = [c for c in topics if c in pivot.columns]
    if "other" in pivot.columns:
        cols.append("other")
    return pivot[cols].sort_index()


def weekday_hour_heatmap(ideas: pd.DataFrame) -> pd.DataFrame:
    order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
    grid = (
        ideas.groupby(["weekday", "hour"])
        .size()
        .unstack(fill_value=0)
        .reindex(order)
        .reindex(columns=range(24), fill_value=0)
    )
    return grid


def streaks(ideas: pd.DataFrame) -> dict:
    """Longest streak of consecutive days with ≥1 idea."""
    days = pd.Index(sorted({d.date() for d in ideas["created_local"]}))
    if len(days) == 0:
        return {"longest_streak_days": 0, "streak_start": None, "streak_end": None}
    best = cur = 1
    best_end = cur_end = days[0]
    for prev, today in zip(days[:-1], days[1:]):
        if (today - prev).days == 1:
            cur += 1
            cur_end = today
        else:
            cur, cur_end = 1, today
        if cur > best:
            best, best_end = cur, cur_end
    best_start = best_end - pd.Timedelta(days=best - 1)
    return {
        "longest_streak_days": int(best),
        "streak_start": str(best_start),
        "streak_end": str(best_end),
        "active_days": int(len(days)),
    }


# ---------------------------------------------------------------------------
# Plot
# ---------------------------------------------------------------------------
def make_plot(df: pd.DataFrame) -> dict:
    ideas = df[df["is_idea"]].copy()
    if ideas.empty:
        sys.exit("graph-ideas.py: no notes tagged 'idea' found.")

    topics = top_subtopics(ideas, TOP_N_TOPICS)
    monthly = monthly_counts(ideas)
    by_topic = monthly_by_topic(ideas, topics)
    heat = weekday_hour_heatmap(ideas)
    stk = streaks(ideas)

    # ---- figure ----
    # Cohesive palette: one indigo/violet family across every panel.
    # Keeps the eye moving through panels as one composition, not a rainbow.
    PRIMARY     = "#4f46e5"   # indigo-600 — the headline color
    PRIMARY_DK  = "#312e81"   # indigo-900 — outlines, cumulative line
    PRIMARY_LT  = "#c7d2fe"   # indigo-200 — soft fill
    INK         = "#1f2937"   # slate-800 — body text
    MUTED       = "#6b7280"   # slate-500 — secondary text

    plt.rcParams.update({
        "font.family":           "sans-serif",
        "font.size":             11,
        "axes.spines.top":       False,
        "axes.spines.right":     False,
        "axes.edgecolor":        "#d1d5db",
        "axes.labelcolor":       MUTED,
        "axes.titlecolor":       INK,
        "xtick.color":           MUTED,
        "ytick.color":           MUTED,
        "figure.facecolor":      "white",
        "axes.facecolor":        "white",
        "savefig.facecolor":     "white",
    })

    # Taller figure + explicit gridspec spacing → more breathing room between
    # panels so each can be screenshotted cleanly on its own.
    # top=0.88 leaves a roomy header band so the suptitle never collides with
    # the first panel's title/subtitle (a previous version overlapped).
    fig = plt.figure(figsize=(16, 24))
    gs = fig.add_gridspec(
        4, 2,
        hspace=1.05,   # vertical gap between rows — generous so each panel
                       # crops cleanly when screenshotted individually
        wspace=0.28,   # horizontal gap between columns
        left=0.26, right=0.74, top=0.88, bottom=0.05,
        height_ratios=[1.0, 1.0, 1.0, 1.0],
    )

    # Header band — one bold line + a quiet date range, both left-aligned.
    fig.text(
        0.26, 0.945, "A decade of ideas",
        fontsize=26, fontweight="bold", color=INK, ha="left", va="bottom",
    )
    fig.text(
        0.26, 0.925,
        f"{ideas['created_local'].min():%B %Y} — {ideas['created_local'].max():%B %Y}",
        fontsize=13, color=MUTED, ha="left", va="top",
    )

    def _style_time_axis(ax):
        ax.xaxis.set_major_locator(mdates.YearLocator())
        ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
        ax.grid(axis="y", alpha=0.18, linestyle="-", linewidth=0.8)
        ax.tick_params(axis="x", pad=6)
        ax.tick_params(axis="y", pad=4)

    def _panel_title(ax, title, subtitle=None):
        # Stack title + subtitle ABOVE the axes using figure-relative text,
        # not ax.set_title (which collides with subtitle text in the same band).
        # title sits ~ax-top+34px, subtitle ~ax-top+14px — always in order.
        ax.text(0.0, 1.0, title, transform=ax.transAxes,
                fontsize=15, fontweight="bold", color=INK,
                ha="left", va="bottom",
                bbox=dict(facecolor="white", edgecolor="none", pad=2),
                # nudge title up ~30px so it never touches the axis spine
                ).set_position((0.0, 1.10))
        if subtitle:
            ax.text(0.0, 1.03, subtitle, transform=ax.transAxes,
                    fontsize=10.5, color=MUTED, ha="left", va="bottom")

    # 1. Ideas per month (no rolling average)
    ax1 = fig.add_subplot(gs[0, :])
    ax1.bar(monthly.index, monthly.values, width=25, color=PRIMARY, alpha=0.9,
            edgecolor="none")
    _panel_title(ax1, "Ideas per month")
    ax1.set_ylabel("ideas")
    _style_time_axis(ax1)

    # 2. Cumulative
    ax2 = fig.add_subplot(gs[1, 0])
    cum = monthly.cumsum()
    ax2.fill_between(cum.index, cum.values, color=PRIMARY_LT, alpha=0.7)
    ax2.plot(cum.index, cum.values, color=PRIMARY_DK, lw=2.2)
    _panel_title(ax2, "Cumulative ideas", "running total since the first entry")
    ax2.set_ylabel("total")
    _style_time_axis(ax2)

    # 3. Weekday × hour heatmap — use a perceptually-uniform sequential ramp
    #    in the same indigo family so it stays cohesive with the rest.
    ax3 = fig.add_subplot(gs[1, 1])
    from matplotlib.colors import LinearSegmentedColormap
    indigo_cmap = LinearSegmentedColormap.from_list(
        "indigo", ["#f5f3ff", "#c7d2fe", "#818cf8", "#4f46e5", "#312e81"]
    )
    im = ax3.imshow(heat.values, aspect="auto", cmap=indigo_cmap)
    ax3.set_yticks(range(7), heat.index)
    ax3.set_xticks(range(0, 24, 2), [f"{h:02d}" for h in range(0, 24, 2)])
    ax3.set_xlabel("hour of day (local)")
    _panel_title(ax3, "When ideas strike", "weekday × hour of day")
    cbar = fig.colorbar(im, ax=ax3, shrink=0.85, pad=0.02)
    cbar.outline.set_visible(False)
    cbar.ax.tick_params(colors=MUTED)

    # 4. Stacked area by topic — single-hue progression so it reads as one
    #    composition rather than 10 competing colors.
    ax4 = fig.add_subplot(gs[2, :])
    if not by_topic.empty:
        n_cols = len(by_topic.columns)
        # Sample our indigo ramp across however many bands we need.
        band_colors = [indigo_cmap(0.15 + 0.75 * i / max(1, n_cols - 1)) for i in range(n_cols)]
        ax4.stackplot(
            by_topic.index,
            by_topic.values.T,
            labels=by_topic.columns,
            colors=band_colors,
            alpha=0.92,
            edgecolor="white",
            linewidth=0.4,
        )
        leg = ax4.legend(
            loc="upper left", frameon=False,
            ncol=min(5, n_cols), fontsize=10,
            handlelength=1.4, handletextpad=0.6, columnspacing=1.4,
        )
        for txt in leg.get_texts():
            txt.set_color(INK)
    _panel_title(ax4, "Ideas by topic", f"top {TOP_N_TOPICS} companion tags, stacked monthly")
    ax4.set_ylabel("ideas / month")
    _style_time_axis(ax4)

    # 5. Top topics bar
    ax5 = fig.add_subplot(gs[3, 0])
    topic_counts = Counter()
    for tags in ideas["all_tags"]:
        for t in tags:
            if t == IDEA_TAG:
                continue
            topic_counts[t] += 1
    top15 = topic_counts.most_common(15)
    if top15:
        names, vals = zip(*top15)
        ax5.barh(list(names)[::-1], list(vals)[::-1], color=PRIMARY, alpha=0.9, edgecolor="none")
        _panel_title(ax5, "Top tags on ideas", "companion tags ranked by frequency")
        for i, v in enumerate(list(vals)[::-1]):
            ax5.text(v + max(vals) * 0.012, i, str(v), va="center",
                     fontsize=10, color=INK)
        ax5.set_xlim(0, max(vals) * 1.12)
        ax5.tick_params(axis="y", pad=4)
        for spine in ("bottom", "left"):
            ax5.spines[spine].set_color("#d1d5db")
        ax5.grid(axis="x", alpha=0.18, linestyle="-", linewidth=0.8)

    # 6. Per-year summary
    ax6 = fig.add_subplot(gs[3, 1])
    per_year = ideas.groupby("year").size()
    ax6.bar(per_year.index.astype(str), per_year.values, color=PRIMARY_DK, alpha=0.9,
            edgecolor="none")
    _panel_title(ax6, "Ideas per year", "calendar-year totals")
    ymax = per_year.max()
    for i, (yr, v) in enumerate(per_year.items()):
        ax6.text(i, v + ymax * 0.015, str(v), ha="center", va="bottom",
                 fontsize=10, color=INK)
    ax6.set_ylim(0, ymax * 1.15)
    ax6.grid(axis="y", alpha=0.18, linestyle="-", linewidth=0.8)
    ax6.tick_params(axis="x", pad=4)

    fig.savefig(OUT_PNG, dpi=150, bbox_inches="tight", pad_inches=0.4)
    plt.close(fig)

    # Summary JSON
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_notes": int(len(df)),
        "total_ideas": int(len(ideas)),
        "first_idea": str(ideas["created_local"].min()),
        "latest_idea": str(ideas["created_local"].max()),
        "ideas_per_year": {int(y): int(n) for y, n in per_year.items()},
        "top_topics": [{"tag": t, "count": n} for t, n in top15],
        "busiest_month": {
            "month": str(monthly.idxmax().date()),
            "count": int(monthly.max()),
        },
        "streaks": stk,
        "outputs": {
            "png": str(OUT_PNG),
            "html": str(OUT_HTML),
        },
    }
    OUT_JSON.write_text(json.dumps(summary, indent=2))

    # Minimal HTML wrapper (the PNG is the source of truth; HTML is for easy viewing)
    OUT_HTML.write_text(
        f"""<!doctype html>
<meta charset=utf-8>
<title>Ideas over time</title>
<style>
  body {{ font-family: ui-sans-serif, system-ui, sans-serif; max-width: 1200px; margin: 2rem auto; padding: 0 1rem; color: #111; }}
  h1   {{ font-size: 1.4rem; margin: 0 0 .25rem; }}
  .meta{{ color:#666; font-size:.9rem; margin-bottom: 1.5rem; }}
  img  {{ width: 100%; height: auto; border: 1px solid #e5e5e5; border-radius: 8px; }}
  pre  {{ background:#f6f6f6; padding:1rem; border-radius:8px; overflow:auto; font-size:.85rem; }}
</style>
<h1>Ideas over time</h1>
<div class=meta>{summary['total_ideas']:,} ideas · {summary['first_idea'][:10]} → {summary['latest_idea'][:10]} · generated {summary['generated_at']}</div>
<img src="ideas-over-time.png" alt="ideas over time">
<h2>Summary</h2>
<pre>{json.dumps(summary, indent=2)}</pre>
"""
    )

    return summary


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    df = load_notes_from_stdin()
    summary = make_plot(df)
    print(f"✓ {summary['total_ideas']:,} ideas plotted ({summary['first_idea'][:10]} → {summary['latest_idea'][:10]})")
    print(f"  PNG  → {OUT_PNG}")
    print(f"  HTML → {OUT_HTML}")
    print(f"  JSON → {OUT_JSON}")
    print(f"  Busiest month: {summary['busiest_month']['month']} ({summary['busiest_month']['count']} ideas)")
    print(f"  Longest streak: {summary['streaks']['longest_streak_days']} days "
          f"({summary['streaks']['streak_start']} → {summary['streaks']['streak_end']})")
