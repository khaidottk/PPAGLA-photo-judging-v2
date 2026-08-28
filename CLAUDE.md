# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install        # install dependencies
npm run dev        # start dev server (Vite, hot reload)
npm run build      # production build → dist/
npm run preview    # preview production build locally
```

No test runner or linter is configured.

## Architecture

This is a single-page React app (Vite) for blind photo contest judging. The entire application — all state, logic, and UI — lives in **`JudgingApp.jsx`**. `main.jsx` only mounts it; `index.html` is a minimal shell.

`apps-script/Code.gs` is the Google Apps Script backing the app. It is checked in for version history only — it must be pasted into the Apps Script editor and re-deployed to take effect. See `apps-script/README.md` for the install steps and the cycle-to-cycle runbook.

### Backend: Google Sheets + Apps Script

There is no traditional backend. Two URLs connect the app to Google's infrastructure, configured via **Vite environment variables** (see `.env.example`):

- **`VITE_CREDENTIALS_SHEET_URL`** — a publicly published Google Sheet CSV with columns `judgeId`, `password`, `role` (`judge` or `admin`). One row can have `judgeId = __entries_url__` to supply the entries sheet URL dynamically, or an `entriesUrl` column can be used instead.
- **`VITE_APPS_SCRIPT_URL`** — a Google Apps Script web app endpoint. GET requests fetch a judge's vote history; POST requests save votes.

### Configuration

Copy `.env.example` to `.env` and fill in the two URLs. On Vercel, set these as environment variables in Project Settings → Environment Variables. These URLs stay the same cycle to cycle when reusing the same Google Sheet.

The entries CSV (loaded after login from the URL stored in the credentials sheet) has columns: `entry_id`, `category`, `essay_id`, `essay_title`, `image_number`, `filename`, `caption`, `photographer`, `publication`, `headline`, `copyright`, `drive_file_id`, `image_url`.

### App phases

The `phase` state drives the top-level view:

| Phase | Description |
|-------|-------------|
| `login` | Credential entry form |
| `loading` | Fetching entries + judge history in parallel |
| `browse` | Category grid; judge selects a category |
| `judge` | Voting UI for a single category |
| `submitted` | Confirmation screen after submitting a category |
| `admin` | Admin view showing all judges' per-category progress |

In **round 2 (runoff) mode** — the same URL with `?round=2` — `browse` shows only
the tiebreaker categories and the round 1 grid is never rendered, so a judge
cannot reopen and resubmit a category they already finished.

### Data model

- **Single-image categories** (`isEssayCategory: false`): each entry is one photo.
- **Essay categories** (`isEssayCategory: true`): entries are grouped by `essay_id` into essay objects, each containing an ordered `photos` array. Essay prefixes are mapped to canonical category names via `ESSAY_ID_CATEGORY_MAP` (`PHOT` → "Photo Essay", `PICT` → "Picture Story", `POY` → "POY").

### Round 2 — runoff voting

Round 1 ranks by weighted score (1st=4, 2nd=3, 3rd=2, HM=1). Entries that tie on
score used to be ordered arbitrarily. Instead, the organizer runs **PPAGLA →
Close Voting & Check for Ties** in the Sheet, which writes the tied groups to a
`Runoff` tab; judges then rank just those photos at `?round=2`.

- `IS_RUNOFF` is set from the `?round=2` query parameter at module scope.
- `loadRunoffConfig()` fetches the open groups from `APPS_SCRIPT_URL?action=runoff`
  (not a published CSV — those cache for minutes and would hide a fresh runoff).
- `buildRunoffCategories()` filters the already-parsed round 1 categories down to
  the tied entries, so images, captions and essay grouping are reused as-is —
  which is why an essay category renders as folders in a runoff automatically.
- A group is contested for exactly the award slots it already occupies, HM
  included. `contestedPlaces` therefore always has one entry per photo (e.g.
  `[1,2,3,4]` for a 4-way tie at the top, `[3,4,4]` for a group spanning 3rd and
  two HM slots). `VoteRow` takes `allowedPlaces` and `maxHms` to match.
- Submitting requires **every** contested slot filled. The 1st-place comment is
  optional in a runoff and there is no No Award button.
- Votes POST with `category: "<Name> — Runoff"` and `round: 2`. The suffix gives
  them their own judge+category key in the Votes sheet, so round 1 is never
  overwritten. `RUNOFF_SUFFIX` uses an em dash and must match `Code.gs` exactly.
- `rebuildTally` in the Apps Script folds round 2 results back into the real
  category and keeps runoff blocks **out** of the Tally sheet — otherwise
  `exportWinners`, which copies every row with a `Suggested Place`, would create a
  bogus `— Runoff` Drive folder.

### Voting rules

- Places 1st/2nd/3rd are **exclusive** — assigning a place to a new entry removes it from the previous holder.
- HM (Honorable Mention, place `4`) allows up to **4** per category (`MAX_HMS = 4`).
- Clicking an already-assigned button deselects it.
- Judging is **blind**: `photographer` and `publication` are loaded but never rendered in the judge view.
- A 1st-place comment field appears when a 1st-place vote is cast.

### Image loading

`ContestImage` is a lazy-loading wrapper that shows a loading state, then the image, then a fallback if the URL fails. If `image_url` is empty but `drive_file_id` is present, a Google Drive thumbnail URL is generated via `driveThumbUrl()`.
