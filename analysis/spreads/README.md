# How the swing numbers were measured

A "swing" is how much a stat really moves from one game to the next for a player at a
given line. Margins and pick quality are measured in swings, so a half-yard miss on a
79.5 line counts as bad luck and a half-touchdown miss counts as a real miss.

## Data

Five regular seasons of NFL box scores, 2021 to 2025, from
[nflverse](https://github.com/nflverse/nflverse-data) (weekly player stats), plus
2024 and 2025 play-by-play for Longest Reception and Longest Rush. About 90,000
player-games. Fantasy score uses PrizePicks' published scoring.

## Method

For each stat:

1. Every player-season with at least 6 games.
2. That player's own game-to-game standard deviation around his season, which is the
   variation a fair line cannot remove.
3. Players are grouped by their median game, the variation inside each group is pooled,
   and a curve is fitted: `spread = a * line^b`. The median is used because a PrizePicks
   line sits at a player's median outcome. Touchdowns, sacks and interceptions are
   mostly zero in a game, so for those the average is used instead.
4. Passing stats use only games where the QB was his team's main passer, so backups
   and relief appearances do not pass for game-to-game variation.
5. The app holds each line inside the range the curve was measured on, so it never
   extrapolates.

## Checks

- **Held-out season.** Fitted on 2021 to 2024 only, the curves predicted how much
  2025 players actually varied within 2% for most stats and within 7% for every stat
  except Longest Rush (12% low, because long runs are rare and lumpy).
- **Coverage.** Roughly 70 to 75% of games land within one swing of a player's
  average, about what a standard deviation should give.
- **The pool's own legs.** Across the first 36 graded legs, results landed an average
  squared distance of 1.38 swings from the line with these numbers, against 1.59 with
  the original estimates. Above 1.0 is expected, since lines are forecasts rather than
  perfect and a few legs were huge outliers.

## Limits

- One curve per stat, by line. It knows a 75-yard receiver swings more than a
  20-yard one, but not that one specific receiver is boom-or-bust.
- Lines stand in for a player's median. Demon and goblin lines are set off the median
  on purpose, so a swing on those legs is slightly less exact.

## Rerun

```
mkdir data   # then download stats_player_week_YYYY.csv and play_by_play_YYYY.parquet from nflverse-data releases
python3 measure.py 2021,2022,2023,2024     # fit for the held-out check
python3 validate.py                        # checks against 2025
python3 measure.py                         # final fit on all seasons, writes fit_*.json
```

Copy the new `a`, `b`, `lo`, `hi` values into the `SPREADS` table in `public/index.html`.
