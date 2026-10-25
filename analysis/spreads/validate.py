"""
Three checks on the measured spreads.

1. Held-out season: fit on 2021-2024, then ask whether the curves predict how much
   2025 players actually varied, a season the fit never saw. Ratio near 1.00 = right.
2. Mean versus median: a PrizePicks line sits at the player's median outcome, not his
   average. For skewed stats, see how much that changes the spread.
3. The group's own 36 graded legs: if lines are fair and spreads are right, the average
   squared distance from the line in swings should land near 1.
"""
import json, math, sys
import numpy as np
import pandas as pd
import os
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import measure as M

fit = json.load(open(os.path.join(HERE, "fit_2021_2022_2023_2024.json")))
box = M.load_box([2025])
lon = M.load_longest([2025])
box = box.merge(lon, on=["season", "game_id", "player_id"], how="left")

print("1. HELD-OUT 2025 SEASON  (actual spread / predicted spread, 1.00 is perfect)")
for key, (col, pos, floor, label) in M.STATS.items():
    if key not in fit: continue
    f = fit[key]
    s = M.player_seasons(box, col, pos, floor)
    if not len(s): continue
    pred = f["a"] * s["mean"].clip(f["lo"], f["hi"]) ** f["b"]
    ratio = math.sqrt(s["ss"].sum() / (pred ** 2 * s["df"]).sum())
    # share of games within one predicted spread of the player's own average
    use = box.merge(s.reset_index()[["season", "player_id", "mean", "avg"]], on=["season", "player_id"])
    if col in M.QB_COLS:
        top = use.groupby(["season", "game_id", "team"]).pass_att.transform("max")
        use = use[(use.pass_att == top) & (use.pass_att > 0)]
    use = use[use[col].notna()]
    sp = f["a"] * use["mean"].clip(f["lo"], f["hi"]) ** f["b"]
    within = float(((use[col] - use["avg"]).abs() <= sp).mean())
    flag = "" if 0.9 <= ratio <= 1.1 else "   <-- check"
    print(f"   {label:28s} {ratio:5.2f}   {within*100:4.0f}% of games within one swing   ({len(s)} players){flag}")

