"""
Measure how much each PrizePicks stat actually moves from game to game, using five
regular seasons of real NFL box scores (nflverse, 2021 to 2025).

For every stat:
  1. Take each player-season with at least 6 games played.
  2. Measure that player's own game-to-game standard deviation around his season mean.
     That is the variation a fair line cannot remove.
  3. Higher-volume players swing more in raw numbers, so group player-seasons by their
     average, pool the variation inside each group, and fit  spread = a * average^b.
     The app knows the line, and a PrizePicks line sits near the player's expected
     number, so the line stands in for the average.

Run:  python3 -I measure.py [fit_seasons] [holdout_season]
"""
import sys, json, math
import numpy as np
import pandas as pd

import os
DATA = os.environ.get("NFL_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))
FIT_SEASONS = [int(x) for x in (sys.argv[1].split(",") if len(sys.argv) > 1 else "2021,2022,2023,2024,2025".split(","))]
HOLDOUT = int(sys.argv[2]) if len(sys.argv) > 2 else None
MIN_GAMES = 6
BINS = 12


def load_box(seasons):
    d = pd.concat([pd.read_csv(f"{DATA}/stats_player_week_{y}.csv", low_memory=False) for y in seasons])
    d = d[d.season_type == "REG"].copy()
    z = lambda c: d[c].fillna(0) if c in d else 0
    d["pass_yds"] = z("passing_yards")
    d["pass_att"] = z("attempts")
    d["comp"] = z("completions")
    d["comp_pct"] = np.where(d["pass_att"] >= 10, 100 * d["comp"] / d["pass_att"].replace(0, np.nan), np.nan)
    d["pass_td"] = z("passing_tds")
    d["ints"] = z("passing_interceptions")
    d["rush_yds"] = z("rushing_yards")
    d["rush_att"] = z("carries")
    d["rush_td"] = z("rushing_tds")
    d["rec"] = z("receptions")
    d["tgt"] = z("targets")
    d["rec_yds"] = z("receiving_yards")
    d["rec_td"] = z("receiving_tds")
    d["pass_rush_yds"] = d.pass_yds + d.rush_yds
    d["rush_rec_yds"] = d.rush_yds + d.rec_yds
    d["anytime_td"] = d.rush_td + d.rec_td
    d["rush_rec_td"] = d.rush_td + d.rec_td
    d["prr_td"] = d.pass_td + d.rush_td + d.rec_td
    fum = z("sack_fumbles_lost") + z("rushing_fumbles_lost") + z("receiving_fumbles_lost")
    two = z("passing_2pt_conversions") + z("rushing_2pt_conversions") + z("receiving_2pt_conversions")
    # PrizePicks NFL fantasy score, from their published scoring
    d["fantasy"] = (0.04 * d.pass_yds + 4 * d.pass_td - d.ints + 0.1 * d.rush_yds + 6 * d.rush_td
                    + d.rec + 0.1 * d.rec_yds + 6 * d.rec_td - fum + 2 * two + 6 * z("special_teams_tds"))
    d["kick_pts"] = 3 * z("fg_made") + z("pat_made")
    d["tackles"] = z("def_tackles_solo") + z("def_tackle_assists")
    d["sacks"] = z("def_sacks")
    return d


def load_longest(seasons):
    rows = []
    for y in seasons:
        try:
            p = pd.read_parquet(f"{DATA}/pbp_{y}.parquet",
                                columns=["season", "season_type", "game_id", "play_type", "rush_attempt",
                                         "complete_pass", "rusher_player_id", "receiver_player_id", "yards_gained"])
        except FileNotFoundError:
            continue
        p = p[p.season_type == "REG"]
        ru = p[(p.rush_attempt == 1) & p.rusher_player_id.notna()].groupby(["season", "game_id", "rusher_player_id"]).yards_gained.max()
        ru = ru.rename("long_rush").reset_index().rename(columns={"rusher_player_id": "player_id"})
        re = p[(p.complete_pass == 1) & p.receiver_player_id.notna()].groupby(["season", "game_id", "receiver_player_id"]).yards_gained.max()
        re = re.rename("long_rec").reset_index().rename(columns={"receiver_player_id": "player_id"})
        rows.append(ru.merge(re, on=["season", "game_id", "player_id"], how="outer"))
    return pd.concat(rows) if rows else pd.DataFrame(columns=["season", "game_id", "player_id", "long_rush", "long_rec"])


# which players get props on each stat, and the lowest season average worth modelling
STATS = {
    # key          column          positions                    floor   label shown in the app
    "pass_yds":   ("pass_yds",     ["QB"], 120, "Pass yards"),
    "pass_att":   ("pass_att",     ["QB"], 15,  "Pass attempts"),
    "comp":       ("comp",         ["QB"], 10,  "Completions"),
    "comp_pct":   ("comp_pct",     ["QB"], 45,  "Completion %"),
    "pass_td":    ("pass_td",      ["QB"], 0.4, "Pass TDs"),
    "ints":       ("ints",         ["QB"], 0.2, "Interceptions"),
    "pass_rush":  ("pass_rush_yds",["QB"], 130, "Pass+rush yards"),
    "prr_td":     ("prr_td",       ["QB"], 0.5, "Pass+rush+rec TDs"),
    "rush_yds":   ("rush_yds",     ["RB", "QB"], 15, "Rush yards"),
    "rush_att":   ("rush_att",     ["RB", "QB"], 4,  "Rush attempts"),
    "long_rush":  ("long_rush",    ["RB", "QB"], 6,  "Longest rush"),
    "rec_yds":    ("rec_yds",      ["WR", "TE", "RB"], 15, "Receiving yards"),
    "rec":        ("rec",          ["WR", "TE", "RB"], 1.5, "Receptions"),
    "tgt":        ("tgt",          ["WR", "TE", "RB"], 2.5, "Targets"),
    "long_rec":   ("long_rec",     ["WR", "TE", "RB"], 8,  "Longest reception"),
    "rush_rec":   ("rush_rec_yds", ["RB", "WR", "TE"], 25, "Rush+rec yards"),
    "anytime_td": ("anytime_td",   ["RB", "WR", "TE"], 0.15, "Anytime TD / Rush+rec TDs"),
    "fantasy":    ("fantasy",      ["QB", "RB", "WR", "TE"], 5, "Fantasy score"),
    "kick_pts":   ("kick_pts",     ["K"], 4,   "Kicking points"),
    "tackles":    ("tackles",      ["LB", "DB"], 2, "Tackles+assists"),
    "sacks":      ("sacks",        ["DL", "LB"], 0.15, "Sacks"),
}


MEDIAN_COLS = {"pass_yds", "pass_att", "comp", "comp_pct", "pass_rush_yds", "rush_yds", "rush_att", "long_rush",
               "rec_yds", "rec", "tgt", "long_rec", "rush_rec_yds", "fantasy", "kick_pts", "tackles"}
QB_COLS = {"pass_yds", "pass_att", "comp", "comp_pct", "pass_td", "ints", "pass_rush_yds", "prr_td"}


def player_seasons(df, col, positions, floor):
    pg = df["position_group"].fillna(df.get("position"))
    pos = df["position"].fillna("")
    use = df[(pg.isin(positions)) | (pos.isin(positions))]
    if col in QB_COLS:
        # passing props go to starters: keep only games where he was his team's main passer,
        # so part-time and relief appearances do not pass for game-to-game variation
        top = use.groupby(["season", "game_id", "team"]).pass_att.transform("max")
        use = use[(use.pass_att == top) & (use.pass_att > 0)]
    use = use[use[col].notna()]
    g = use.groupby(["season", "player_id"])[col]
    s = pd.DataFrame({"n": g.size(), "avg": g.mean(), "med": g.median(), "var": g.var(ddof=1)})
    s = s[(s.n >= MIN_GAMES) & (s["avg"] >= floor)].dropna()
    # A PrizePicks line sits at the player's median outcome, so for stats with a real
    # median the spread is fitted against the median. Touchdowns, sacks and picks are
    # mostly zero in a game, so their median says nothing and the average is used.
    s["mean"] = s["med"] if col in MEDIAN_COLS else s["avg"]
    s = s[s["mean"] > 0]
    s["ss"] = s["var"] * (s.n - 1)
    s["df"] = s.n - 1
    return s


def binned(s):
    s = s.sort_values("mean")
    k = min(BINS, max(3, len(s) // 15))
    s["bin"] = pd.qcut(s["mean"].rank(method="first"), k, labels=False)
    b = s.groupby("bin").apply(lambda t: pd.Series({
        "mean": np.average(t["mean"], weights=t["df"]),
        "sd": math.sqrt(t["ss"].sum() / t["df"].sum()),
        "df": t["df"].sum(), "players": len(t)}), include_groups=False)
    return b


def fit(b):
    x, y, w = np.log(b["mean"].values), np.log(b["sd"].values), b["df"].values
    W = np.diag(w)
    X = np.vstack([np.ones_like(x), x]).T
    beta = np.linalg.solve(X.T @ W @ X, X.T @ W @ y)
    yhat = X @ beta
    ss_res = np.sum(w * (y - yhat) ** 2)
    ss_tot = np.sum(w * (y - np.average(y, weights=w)) ** 2)
    return math.exp(beta[0]), beta[1], (1 - ss_res / ss_tot) if ss_tot > 0 else float("nan")


def main():
    box = load_box(FIT_SEASONS)
    longest = load_longest(FIT_SEASONS)
    if len(longest):
        meta = box[["season", "game_id", "player_id", "position", "position_group"]]
        box = box.merge(longest, on=["season", "game_id", "player_id"], how="left")
    out = {}
    for key, (col, positions, floor, label) in STATS.items():
        if col not in box or box[col].notna().sum() == 0:
            print(f"{label:28s} no data"); continue
        s = player_seasons(box, col, positions, floor)
        if len(s) < 30:
            print(f"{label:28s} too few player-seasons ({len(s)})"); continue
        b = binned(s)
        a, e, r2 = fit(b)
        lo, hi = float(b["mean"].min()), float(b["mean"].max())
        out[key] = {"label": label, "a": a, "b": e, "r2": r2, "lo": lo, "hi": hi,
                    "player_seasons": int(len(s)), "games": int(s.n.sum()),
                    "bins": [[round(m, 2), round(sd, 2)] for m, sd in zip(b["mean"], b["sd"])]}
        at = lambda m: a * min(max(m, lo), hi) ** e
        print(f"{label:28s} spread = {a:7.3f} x line^{e:5.2f}  R2 {r2:4.2f}  "
              f"lines {lo:6.1f}-{hi:6.1f}  {len(s):4d} player-seasons, {int(s.n.sum()):5d} games")
    json.dump(out, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), f"fit_{'_'.join(map(str, FIT_SEASONS))}.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
