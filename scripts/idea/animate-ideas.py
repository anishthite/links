#!/usr/bin/env python3
"""Time-lapse animation of monthly ideas — bar sweep with payoff moments.

Reads the same D1 JSON dump from stdin that graph-ideas.py expects.
Emits an MP4 (and optionally a GIF) to the script directory.

Design choices live in code comments below — search for `# DESIGN:`.
"""

from __future__ import annotations

import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.animation import FFMpegWriter, FuncAnimation, PillowWriter
from matplotlib.colors import LinearSegmentedColormap, to_rgba
from matplotlib.patches import FancyBboxPatch
from matplotlib.ticker import MaxNLocator

# ──────────────────────────────────────────────────────────────────────────
# Palette (matches graph-ideas.py — keeps still + motion visually identical)
# ──────────────────────────────────────────────────────────────────────────
PRIMARY = "#4f46e5"   # indigo-600
PRIMARY_DK = "#312e81"  # indigo-900
PRIMARY_LT = "#c7d2fe"  # indigo-200
GOLD = "#f59e0b"      # amber-500 — the star moment color
INK = "#0f172a"       # slate-900
MUTED = "#64748b"     # slate-500
BG = "#ffffff"

LA = ZoneInfo("America/Los_Angeles")
OUT_DIR = Path(__file__).resolve().parent

# ──────────────────────────────────────────────────────────────────────────
# Load + filter (mirror of graph-ideas.py's prep logic — kept inline so this
# script is standalone, no shared module yet)
# ──────────────────────────────────────────────────────────────────────────
def load_notes() -> pd.DataFrame:
    raw = json.load(sys.stdin)
    rows = raw[0]["results"] if isinstance(raw, list) else raw["results"]
    df = pd.DataFrame(rows)
    df["created_local"] = (
        pd.to_datetime(df["created_at"], unit="ms", utc=True)
        .dt.tz_convert(LA)
    )
    df["tags_parsed"] = df["tags"].apply(
        lambda s: json.loads(s) if isinstance(s, str) and s else []
    )
    text = df["text"].fillna("").astype(str)
    has_hashtag = text.str.contains(r"#idea\b", case=False, regex=True)
    has_tag = df["tags_parsed"].apply(lambda ts: "idea" in (t.lower() for t in ts))
    ideas = df[has_hashtag | has_tag].copy()
    print(
        f"[animate] {len(ideas):,} ideas of {len(df):,} notes "
        f"({ideas['created_local'].min():%Y-%m-%d} → "
        f"{ideas['created_local'].max():%Y-%m-%d})",
        file=sys.stderr,
    )
    return ideas


def monthly_counts(ideas: pd.DataFrame) -> pd.Series:
    # DESIGN: drop tz before period conversion to silence the pandas warning;
    # local-time is already baked in by tz_convert above.
    naive = ideas["created_local"].dt.tz_localize(None)
    per_month = (
        naive.dt.to_period("M")
        .value_counts()
        .sort_index()
    )
    # Reindex with a complete month range so the sweep advances uniformly
    # even across stretches with zero ideas.
    full = pd.period_range(per_month.index.min(), per_month.index.max(), freq="M")
    return per_month.reindex(full, fill_value=0)


# ──────────────────────────────────────────────────────────────────────────
# Build the animation
# ──────────────────────────────────────────────────────────────────────────
def build_animation(ideas: pd.DataFrame, fps: int = 30) -> tuple[FuncAnimation, plt.Figure]:
    series = monthly_counts(ideas)
    months = series.index.to_timestamp()       # DatetimeIndex (month start)
    counts = series.values.astype(int)
    n = len(series)
    cum = counts.cumsum()
    total = int(cum[-1])
    busiest_i = int(np.argmax(counts))
    busiest_count = int(counts[busiest_i])
    busiest_month = months[busiest_i]

    # ── Per-month dwell schedule ──────────────────────────────────────────
    # DESIGN: sparse months (zeros, ones) shouldn't get the same screen time
    # as 50-idea months. base 2 frames + log-scaled bonus → dead air gets
    # compressed, payoff months get to breathe. The star month gets +18 frames
    # (~0.6s at 30fps) of dedicated hang time.
    # Targeting ~12s total at 30fps = 360 frames. With 125 months that's an
    # average ~2.9 frames/month; sparse months collapse to 1, busy months to 6+.
    BASE = 1
    SCALE = 2.4  # bigger = more emphasis on busy months
    dwell = np.array(
        [BASE + int(round(SCALE * math.log1p(c))) for c in counts],
        dtype=int,
    )
    dwell[busiest_i] += 12                     # ~0.4s star pause
    final_hold = int(fps * 1.5)                # 1.5s freeze on last frame
    total_frames = int(dwell.sum() + final_hold)

    # frame_to_month[f] = index into series for the month visible at frame f.
    # This is the cheap-but-correct way to schedule variable dwell.
    frame_to_month = np.empty(total_frames, dtype=int)
    cursor = 0
    for m_i, d in enumerate(dwell):
        frame_to_month[cursor : cursor + d] = m_i
        cursor += d
    frame_to_month[cursor:] = n - 1            # final-hold frames

    # Sub-frame interpolation: each month's bar grows from 0→full over its
    # dwell window. We track (month_idx, progress 0..1) per frame.
    growth_progress = np.empty(total_frames, dtype=float)
    cursor = 0
    for m_i, d in enumerate(dwell):
        if d == 0:
            continue
        # ease-out: starts fast, settles smoothly (looks more confident than linear)
        t = np.linspace(0.0, 1.0, d, endpoint=False)
        growth_progress[cursor : cursor + d] = 1.0 - (1.0 - t) ** 2
        cursor += d
    growth_progress[cursor:] = 1.0             # final hold = fully grown

    # ── Figure setup ──────────────────────────────────────────────────────
    # DESIGN: bottom band widened (axes y 0.16->0.22) so the running-total
    # counter sits above any video-player chrome that crops the bottom 5-7%.
    fig = plt.figure(figsize=(12, 6.75), facecolor=BG)   # 16:9 → social-friendly
    ax = fig.add_axes([0.10, 0.22, 0.84, 0.60])
    ax.set_facecolor(BG)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    for s in ("left", "bottom"):
        ax.spines[s].set_color(MUTED)
        ax.spines[s].set_linewidth(0.8)
    ax.grid(axis="y", alpha=0.18, linewidth=0.8)
    ax.tick_params(axis="x", colors=INK, labelsize=10, pad=4)
    ax.tick_params(axis="y", colors=INK, labelsize=10, pad=4)
    ax.xaxis.set_major_locator(mdates.YearLocator())
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
    ax.set_xlim(months[0] - pd.Timedelta(days=20), months[-1] + pd.Timedelta(days=20))
    ax.set_ylim(0, busiest_count * 1.15)
    ax.yaxis.set_major_locator(MaxNLocator(integer=True, nbins=5))

    # ── Life milestones ──────────────────────────────────────────────────
    # DESIGN: dashed verticals that fade in as the sweep crosses them, so
    # the time-lapse story is preserved (no spoilers). Label is lowercase
    # + tiny to match the chart's quiet vibe.
    # DESIGN: each milestone gets a unique (y_frac, ha, x_offset_days) so
    # labels never collide with each other, the star annotation at Sep 2023,
    # or the tall 2023+ bars. "moved to sf" is the tightest case (Aug 2023
    # sits one month before the star), so we push it left of its line
    # (ha="right") with a small x-offset so the box edge clears the dashes.
    y_top = busiest_count * 1.15
    milestones = [
        # (timestamp, label, y_frac_of_y_top, ha, x_offset_days)
        # Heights are staggered downward in time-order so labels never
        # stack vertically; ha alternates so the 2022/2023 pair (only 15
        # months apart) doesn't horizontally collide.
        (pd.Timestamp("2018-08-01"), "college started",       0.97, "left",   6),
        (pd.Timestamp("2020-02-01"), "covid lockdowns start", 0.82, "left",   6),
        (pd.Timestamp("2022-05-01"), "finished college",      0.68, "right", -6),
        (pd.Timestamp("2023-08-01"), "moved to sf",           0.55, "right", -6),
    ]
    milestone_lines = []
    milestone_labels = []
    for ts, label, y_frac, ha, x_off_days in milestones:
        line = ax.axvline(
            ts, ymin=0.0, ymax=0.92,
            color=PRIMARY_DK, linestyle=(0, (4, 4)), linewidth=1.1,
            alpha=0.0, zorder=2,
        )
        txt = ax.text(
            ts + pd.Timedelta(days=x_off_days),
            y_top * y_frac,
            label,
            fontsize=10, color=PRIMARY_DK, ha=ha, va="top",
            alpha=0.0, zorder=4, fontweight="medium",
            bbox=dict(
                boxstyle="round,pad=0.4",
                fc=BG, ec=PRIMARY_LT, lw=0.9,
            ),
        )
        milestone_lines.append(line)
        milestone_labels.append(txt)

    # Pre-compute the month index at which each milestone activates.
    # `searchsorted` gives the insertion point in the sorted months index.
    milestone_month_idx = [
        int(np.searchsorted(months.values, np.datetime64(ts)))
        for ts, *_ in milestones
    ]
    MILESTONE_FADE_FRAMES = 10

    # Pre-create one bar per month at height 0 — animation just sets heights.
    # Width in days = ~25 to leave a small gap between bars.
    bar_width_days = 25
    bars = ax.bar(
        months,
        np.zeros(n),
        width=bar_width_days,
        color=PRIMARY_LT,
        edgecolor=PRIMARY,
        linewidth=0.8,
        align="center",
    )

    # ── Header ────────────────────────────────────────────────────────────
    fig.text(
        0.10, 0.93, "A decade of ideas",
        fontsize=22, fontweight="bold", color=INK, ha="left", va="bottom",
    )
    subtitle_text = fig.text(
        0.10, 0.885,
        "",  # filled in by update()
        fontsize=12, color=MUTED, ha="left", va="bottom",
    )

    # ── Year ticker (big, bottom-right) ───────────────────────────────────
    # DESIGN: watermark lives in the axes top-LEFT corner now — the
    # 2016-2017 bars are tiny (max ~18) so the ticker is never occluded
    # by data. Top-right would have buried it behind the 2024-2026 wall.
    year_text = ax.text(
        0.015, 0.94, "",
        transform=ax.transAxes,
        fontsize=42, fontweight="bold", color=PRIMARY_LT,
        ha="left", va="top", alpha=0.45, zorder=1,
    )

    # ── Running total (bottom-left) ───────────────────────────────────────
    # DESIGN: both rows lifted above fig.y=0.07 so a 5-7% bottom crop
    # (QuickTime controls, IG/Twitter player UI) doesn't eat the value.
    total_label = fig.text(
        0.10, 0.115, "ideas so far",
        fontsize=10, color=MUTED, ha="left", va="bottom",
    )
    total_value = fig.text(
        0.10, 0.065, "0",
        fontsize=20, fontweight="bold", color=INK, ha="left", va="bottom",
    )

    # ── Star annotation (busiest month) ───────────────────────────────────
    star_marker = ax.scatter(
        [busiest_month], [busiest_count + busiest_count * 0.04],
        marker="*", s=0,                       # grows from 0 to ~450
        color=GOLD, edgecolors="white", linewidth=1.5, zorder=5,
    )
    star_label = ax.annotate(
        "",                                    # filled when star fires
        xy=(busiest_month, busiest_count),
        xytext=(0, 28), textcoords="offset points",
        ha="center", va="bottom",
        fontsize=11, fontweight="bold", color=GOLD,
        alpha=0.0,
    )

    # We need a frame-level "how far past the milestone are we" signal —
    # build it once so update() stays O(milestones).
    # For each milestone, find the first frame where frame_to_month >= its
    # month index; that's the fade-in start frame.
    milestone_fade_start = []
    for mm in milestone_month_idx:
        starts = np.where(frame_to_month >= mm)[0]
        milestone_fade_start.append(int(starts[0]) if len(starts) else total_frames)

    # ── Update function ───────────────────────────────────────────────────
    def update(frame: int):
        m_i = int(frame_to_month[frame])
        prog = float(growth_progress[frame])

        # Milestone fade-in: each line/label goes 0→1 alpha over
        # MILESTONE_FADE_FRAMES once the sweep reaches its month.
        for line, txt, start_f in zip(milestone_lines, milestone_labels, milestone_fade_start):
            if frame < start_f:
                a = 0.0
            else:
                a = min(1.0, (frame - start_f) / max(1, MILESTONE_FADE_FRAMES))
            line.set_alpha(a * 0.55)   # dashed line stays subtle
            txt.set_alpha(a * 0.85)    # label glyphs slightly stronger
            # FIX: bbox is a separate Patch — set_alpha on the Text only
            # tints the glyphs, leaving the rounded border at full opacity.
            # Sync the patch alpha so the box fades in with the text.
            patch = txt.get_bbox_patch()
            if patch is not None:
                patch.set_alpha(a)

        # Bars: every fully-passed month is at full height; the cursor month
        # grows from 0 → full via the ease-out curve.
        heights = np.zeros(n)
        heights[:m_i] = counts[:m_i]
        heights[m_i] = counts[m_i] * prog

        # Per-bar color: highlight star month in gold once revealed
        for i, bar in enumerate(bars):
            bar.set_height(heights[i])
            if i == busiest_i and m_i >= busiest_i:
                bar.set_color(GOLD)
                bar.set_edgecolor(PRIMARY_DK)
            elif i <= m_i:
                bar.set_color(PRIMARY_LT)
                bar.set_edgecolor(PRIMARY)

        # Running total: integer-floor count for the visible bars
        visible_total = int(cum[m_i - 1] if m_i > 0 else 0) + int(round(counts[m_i] * prog))
        total_value.set_text(f"{visible_total:,}")

        # Year ticker
        year_text.set_text(f"{months[m_i].year}")

        # Subtitle: live month label
        subtitle_text.set_text(f"{months[m_i]:%B %Y}")

        # Star reveal: animates in over the dwell on the busiest month
        if m_i == busiest_i:
            star_marker.set_sizes([450 * prog])
            star_label.set_text(f"Sep 2023 · {busiest_count} ideas")
            star_label.set_alpha(prog)
        elif m_i > busiest_i:
            star_marker.set_sizes([450])
            star_label.set_text(f"Sep 2023 · {busiest_count} ideas")
            star_label.set_alpha(1.0)
        else:
            star_marker.set_sizes([0])
            star_label.set_alpha(0.0)

        return (*bars, year_text, subtitle_text, total_value, star_marker, star_label)

    print(
        f"[animate] {n} months · {total_frames} frames @ {fps}fps "
        f"≈ {total_frames / fps:.1f}s · star at month {busiest_i} ({busiest_month:%Y-%m})",
        file=sys.stderr,
    )

    anim = FuncAnimation(
        fig, update,
        frames=total_frames,
        interval=1000 / fps,
        blit=False,                            # blit=True breaks fig.text updates
        repeat=False,
    )
    return anim, fig


# ──────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────
def main():
    fps = 30
    ideas = load_notes()
    anim, fig = build_animation(ideas, fps=fps)

    mp4_path = OUT_DIR / "ideas-over-time.mp4"
    gif_path = OUT_DIR / "ideas-over-time.gif"

    # MP4 — high-quality H.264, browser-friendly
    print(f"[animate] writing {mp4_path} …", file=sys.stderr)
    writer = FFMpegWriter(
        fps=fps,
        codec="libx264",
        bitrate=4000,
        extra_args=["-pix_fmt", "yuv420p", "-movflags", "+faststart"],
    )
    anim.save(str(mp4_path), writer=writer, dpi=120)

    # GIF — universal autoplay. DESIGN: half the fps + smaller dpi to keep
    # the file under ~15MB; matplotlib's PillowWriter is the path of least
    # resistance even though ffmpeg→palette would be marginally crisper.
    print(f"[animate] writing {gif_path} …", file=sys.stderr)
    gif_writer = PillowWriter(fps=15)
    anim.save(str(gif_path), writer=gif_writer, dpi=80)

    plt.close(fig)
    print(f"[animate] done.", file=sys.stderr)
    print(f"  MP4 → {mp4_path}")
    print(f"  GIF → {gif_path}")


if __name__ == "__main__":
    main()
