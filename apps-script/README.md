# Apps Script — tie detection and round 2 runoff voting

This folder holds the whole Apps Script project behind the judging site. It
lives in the repo for version history — the files still have to be **pasted into
the Apps Script editor and re-deployed** to take effect.

| File | Script file name | What it does |
|---|---|---|
| `Code.gs` | `Code` | The web app: receives votes, serves history, rebuilds the Tally and Comments tabs, runs the tie/runoff machinery, exports winners to Drive, and owns the PPAGLA menu |
| `SquarespaceExport.gs` | `SquarespaceExport` | Copies winning images into `Squarespace Upload/` renamed the way the site expects. Reads the Tally by column name |
| `FillDriveFields.gs` | `FillDriveFields` | Fills `drive_file_id` and `image_url` on the Entries tab by matching filenames against a Drive folder |

All three share one global namespace in Apps Script, so names are prefixed
(`SQ_`, `FDF_`) to stay out of each other's way. The PPAGLA menu in `Code.gs`
calls into the other two, so a project missing one of them will show a menu item
that errors when clicked.

**Keep the repo as the source of truth.** Edit here, then paste into the Apps
Script editor — not the other way around. Editing in the browser and copying
back by hand is how the two copies drifted apart before.

## What this version adds

Round 1 ranks entries by weighted score (1st = 4, 2nd = 3, 3rd = 2, HM = 1). When
two entries land on the same score, the old script broke the tie by whichever
happened to appear first in the Votes sheet — an arbitrary order that could hand
out a 3rd-place medal by accident.

Now:

1. When voting closes you run **Close Voting & Check for Ties**. It finds every
   tie that reaches into 1st, 2nd or 3rd and writes it to a `Runoff` tab.
2. Judges vote on just those photos at `?round=2` on the normal site.
3. `rebuildTally` uses those round 2 votes to order the tied entries, so
   `Suggested Place` becomes correct on its own. **Export Winners needs no
   change** and is still run by hand whenever you're ready.

Round 1 votes are never touched. Round 2 rows are stored under
`"<Category> — Runoff"`, which is a different judge+category key, so a runoff
submission cannot overwrite anything from round 1.

## Installing this version

1. Open the Sheet → Extensions → Apps Script, replace the contents of `Code.gs`
   with this file.
2. Set `JUDGING_SITE_URL` near the top to your deployed site (e.g.
   `https://judging.example.com`). It is only used to print a ready-made round 2
   link in the tie-check dialog.
3. Nothing to migrate. The first submission after deploying widens the Votes
   sheet with any missing columns (**Round**, **CategoryComment**) on its own.
   Existing rows leave them blank — a blank Round counts as round 1. If you want
   the headers in place before judging opens, run **PPAGLA → Fix Votes
   Headers**.
4. Deploy → Manage deployments → edit the existing deployment → **New version**
   → Deploy. Keeping the same deployment means the site's
   `VITE_APPS_SCRIPT_URL` stays valid.
5. Reload the Sheet so the PPAGLA menu picks up the new items.

**Test on a copy first.** File → Make a copy duplicates the script too. Deploy
the copy as its own web app and point a local `.env` at it before touching the
live sheet.

## The runbook, each cycle

1. Judges finish round 1 as normal.
2. **PPAGLA → Close Voting & Check for Ties.**
   - No ties → it says so. Go straight to Export Winners.
   - Ties → it lists them and gives you the `?round=2` link.
3. Send judges that link. They see only the tied photos, log in the same way,
   and rank each group. Progress badges work as usual.
4. Watch the Tally sheet. It re-resolves itself on every submission, so there is
   no button to press and no deadline — late votes just re-resolve.
5. Anything the script could not break is highlighted orange on the `Runoff`
   tab. Fill in **ManualPlace** for those (see below).
6. **PPAGLA → Close Runoff** to stop the round 2 link showing anything.
7. **PPAGLA → Export Winners to Drive.**

### Keep the number of judges odd

With an **odd** number of judges a two-photo runoff *cannot* tie — one photo
must take more top slots. An even number makes ties both more likely and harder
to break, because a 2–2 split ties on score *and* neutralises the head-to-head
tiebreak.

Tie rate under random ballots (a pessimistic bound — real judges agree more than
random), before → after head-to-head:

| Group size | 3 judges | 4 judges | 5 judges |
|---|---|---|---|
| 2 photos | **0%** | 37.5% → 37.5% | **0%** |
| 3 photos | 22.2% → **5.6%** | 31.9% → 31.9% | 24.7% → **4.6%** |
| 4 photos | 44.1% → **16.0%** | 51.0% → 42.9% | 42.7% → **14.4%** |

So with a panel of three: **do not add a fourth judge.** Go to five or stay at
three.

## Judge comments

Judges write two kinds of comment:

- **A note on each photo they place** — "why this photo for 2nd?". Required for
  their 1st place pick, optional for the rest. Stored against the **entry id**,
  in the `Comment` column of `Votes`.
- **A round-up on the category** — optional, for things that belong to the field
  as a whole rather than one image. Stored in `CategoryComment`, repeated on
  every row of the submission.

Keying notes to the entry rather than to a place is what makes them survive
aggregation. A judge's note follows its photo into whatever award the combined
ballots give it.

### The `Comments` tab — the posting worksheet

One row per photo that actually won something, rebuilt from the finished Tally
so its placements can never drift from it:

| Column | Meaning |
|---|---|
| `Category`, `Place`, `EntryId`, `Title`, `Photographer` | The award |
| **`Matching Comments`** | Notes from judges who gave this photo **the exact place it ended up with**. Quotable verbatim. |
| `Other Comments` | Notes on the same photo from judges who ranked it elsewhere, each labelled with the place *that* judge gave it |
| `Category Comments` | The round-ups, on the category's first row |

**Rows with a quotable comment are shaded green.** That is the at-a-glance
answer to "can I just post a judge's own words under this award?" — if the row
is green, yes.

Where it is blank, no judge put that photo at that place; the award came out of
the combined weighting. Then either quote from `Other Comments` with the
mismatch edited out, or write the line yourself. Categories nobody awarded still
get a row, marked `No Award`, so a round-up explaining why is not dropped.

### The `Tally` tab

Two columns at the far right mirror the same data next to the scores:
`Judge Comments` (notes on that photo, a `✓` marking each one whose judge gave
it the place it won) and `Category Comments` (the round-ups, on the category's
top row).

Everything is rewritten from `Votes` on every submission, so edits made in
either tab will not stick.

### Contests judged before this change

Judges used to comment only on their 1st place pick, in the same `Comment`
column. That data reads correctly as-is — it was always a note about that photo,
and it still is.

## The `Runoff` tab

One row per tied entry. `Close Voting & Check for Ties` rewrites the left-hand
columns; `rebuildTally` fills in the right-hand ones after each round 2 vote.

| Column | Written by | Meaning |
|---|---|---|
| `Category` | tie check | The real category name |
| `EntryId` | tie check | Entry or essay id |
| `Title`, `Photographer` | tie check | For your reference |
| `ContestedPlaces` | tie check | e.g. `1,2,3,4` — the award slots this group is fighting over |
| `GroupId` | tie check | Which tie group the row belongs to |
| `R1Score` | tie check | The round 1 weighted score they all share |
| `Status` | tie check | `open` = judges can vote on it; `closed` = hidden |
| **`ManualPlace`** | **you** | Overrides everything. See below. |
| `R2 1st`…`R2 HM` | tally | Round 2 vote counts |
| `R2Score` | tally | Round 2 weighted score |
| `FinalPlace` | tally | The slot this entry ended up with |

You can edit this tab by hand. Setting `Status` to `closed` on one group's rows
takes just that group out of round 2.

### `ManualPlace` — the organizer's override

Type `1st Place`, `2nd Place`, `3rd Place` or `HM` (or just `1st`, `2nd`, `3rd`,
`HM` — it's forgiving) next to an entry and it is pinned there. Everything else
in the group fills the remaining slots around it. Clearing the cell reverts to
the computed result.

Use this when a tie survives round 2 and the contest organizer makes the call.

This works because the `Runoff` tab is only ever written by the two menu
actions — never by a vote submission. **Editing the Tally sheet directly will
not stick**: `rebuildTally` clears and rewrites it on every submission.

## How a tie is decided

For each group, in order:

1. **`ManualPlace`**, if set.
2. **Round 2 weighted score.**
3. **Head-to-head.** How many judges ranked A above B. Every judge ranks every
   photo in a group with no blanks, so this is always computable and breaks most
   score ties.
4. Most round 2 votes at the best slot, then the next, and so on.
5. Most round 1 first-place votes.
6. Still tied → the group is highlighted orange on the `Runoff` tab and named in
   the dialog. The script says it could not decide rather than guessing; use
   `ManualPlace`.

A group is only ever reordered **within the slots it already occupied**, so a
runoff can never promote an entry above a higher-scoring one, or demote it below
a lower-scoring one.

## Which ties get a runoff

A group qualifies when two or more entries share a score **and** the group
reaches into 1st, 2nd or 3rd place. The contested slots are exactly the award
slots the group already sits in, HM slots included — so the number of buttons a
judge sees always equals the number of photos, and nothing is left blank.

Worked from the current cycle:

| Category | Tied | Slots the group occupies | Judges rank |
|---|---|---|---|
| Pictorial | 4 at 4 pts | ranks 1–4 | 1st, 2nd, 3rd, HM |
| Sports Action | 3 at 4 pts | ranks 2–4 | 2nd, 3rd, HM |
| General News | 3 at 4 pts | ranks 3–5 | 3rd, HM, HM |
| Fire, Portrait | 2 at 4 pts | ranks 3–4 | 3rd, HM |
| Picture Story | 2 at 6 pts | ranks 2–3 | 2nd, 3rd |
| Sports Feature | 2 at 4 pts | ranks 2–3 | 2nd, 3rd |

**Ties purely among HM slots are not escalated.** Re-judging them would roughly
double round 2 without changing a single medal. The cost is that in those
categories one HM slot stays decided by row order. To change that, set
`RUNOFF_MAX_PLACE` to `7` near the top of `Code.gs`.

## Things worth knowing

- **Runoff categories never appear in the Tally sheet.** They are folded into
  their real category instead. This matters because `exportWinners` copies every
  Tally row that has a `Suggested Place` — a visible `— Runoff` block would
  create a bogus Drive folder duplicating the real winners.
- **`RUNOFF_SUFFIX` must match the app.** It is `" — Runoff"` with an em dash, in
  both `Code.gs` and `JudgingApp.jsx`. Change one and round 2 votes stop being
  recognised.
- **The app reads the runoff config through `doGet(?action=runoff)`**, not a
  published CSV, so a freshly opened runoff is visible immediately. Published
  sheet CSVs cache for minutes.
- Re-running the tie check preserves any `ManualPlace` values you had already
  entered.
