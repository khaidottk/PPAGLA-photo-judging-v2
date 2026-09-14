// ============================================================
// PPAGLA Photo Judging — Google Apps Script
// ============================================================
//
// SETUP (do this once):
//
//  1. Create a Google Sheet. Inside it, create three tabs named:
//       Votes    — audit trail, written automatically
//       Tally    — aggregated scores, rebuilt on each submission
//       Entries  — import your entries.csv here (File → Import)
//     A fourth tab, "Runoff", is created automatically the first
//     time you check for ties.
//
//  2. Paste this script: Extensions → Apps Script → replace Code.gs
//
//  3. Set WINNERS_FOLDER_ID below (optional — if left blank the
//     script creates a "PPAGLA Winners" folder in your Drive root).
//     Set JUDGING_SITE_URL so the tie-check dialog can hand you a
//     ready-made round 2 link.
//
//  4. Deploy: click Deploy → New Deployment
//       Type:           Web App
//       Execute as:     Me
//       Who has access: Anyone
//     Copy the deployment URL — set it as VITE_APPS_SCRIPT_URL
//     in the judging app's environment variables.
//
//  5. Import entries.csv into the "Entries" tab so the winner
//     export can find Drive file IDs.
//     (File → Import → Upload → Append to current sheet)
//
//  6. When voting closes, run "Close Voting & Check for Ties" from
//     the PPAGLA menu. If it finds ties, send judges the round 2
//     link it gives you. See apps-script/README.md for the full
//     cycle-to-cycle runbook.
//
//  7. Once everything is resolved, run exportWinners() from the
//     PPAGLA menu.
//
// ============================================================

// ── Configuration ────────────────────────────────────────────

// Google Drive folder ID where winning images will be copied.
// Create a folder in Drive, open it, copy the ID from the URL:
//   drive.google.com/drive/folders/THIS_PART_IS_THE_ID
// Leave blank to auto-create "PPAGLA Winners" in your Drive root.
const WINNERS_FOLDER_ID = "";

// Base URL of the deployed judging site, e.g. "https://judging.example.com".
// Used only to build a clickable round 2 link in the tie-check dialog.
const JUDGING_SITE_URL = "";

// ── Sheet names (change only if you rename your tabs) ────────
const VOTES_SHEET_NAME   = "Votes";
const TALLY_SHEET_NAME   = "Tally";
const ENTRIES_SHEET_NAME = "Entries";
const RUNOFF_SHEET_NAME  = "Runoff";

// ── Scoring weights ──────────────────────────────────────────
// Used to rank entries in the Tally. Adjust if needed.
const WEIGHTS = { 1: 4, 2: 3, 3: 2, 4: 1 }; // 4 = HM

// Rank slot → award. Index 0 is the top rank. Seven slots:
// 1st, 2nd, 3rd, then four Honorable Mentions.
const PLACE_NAMES = ["1st Place", "2nd Place", "3rd Place", "HM", "HM", "HM", "HM"];
const PLACE_CODES = { "1st Place": 1, "2nd Place": 2, "3rd Place": 3, "HM": 4 };

// ── Runoff (round 2) settings ────────────────────────────────
// Category suffix used for round 2 vote rows. Because this makes the
// category key different from round 1, a runoff submission can never
// overwrite a judge's round 1 votes.
// NOTE: the dash is an EM DASH. This string must match RUNOFF_SUFFIX
// in JudgingApp.jsx byte for byte.
const RUNOFF_SUFFIX = " — Runoff";

// Only ties that reach into 1st, 2nd or 3rd place go to a runoff.
// A tie purely among HM slots is left alone — re-judging it would
// roughly double round 2 without changing any medal. Raise this to 7
// to send HM cut-off ties to a runoff as well.
const RUNOFF_MAX_PLACE = 3;

// ── Votes sheet columns (order matters) ─────────────────────
const VOTES_HEADERS = [
  "Timestamp", "JudgeId", "Category",
  "EntryId",   "Place",   "PlaceLabel",
  "Title",     "Photographer", "Publication",
  "Comment",   "NoAward", "Round",
];

// ── Runoff sheet columns ─────────────────────────────────────
// Category...Status describe the tie. ManualPlace is yours to fill in.
// The R2 columns and FinalPlace are rewritten on every tally rebuild
// as an audit trail of how each tie actually broke.
const RUNOFF_HEADERS = [
  "Category", "EntryId", "Title", "Photographer",
  "ContestedPlaces", "GroupId", "R1Score", "Status",
  "ManualPlace",
  "R2 1st", "R2 2nd", "R2 3rd", "R2 HM", "R2Score", "FinalPlace",
];


// ============================================================
// doPost — receives a vote submission from the judging app
// ============================================================
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss   = SpreadsheetApp.getActiveSpreadsheet();

    writeVotesToSheet(ss, data);
    rebuildTally(ss);

    return jsonResponse({ status: "success" });
  } catch (err) {
    return jsonResponse({ status: "error", message: err.message });
  }
}


// ============================================================
// doGet — returns a judge's vote history (used by the judging app
//         on login and by the admin progress dashboard), or the
//         open runoff configuration when called with ?action=runoff
// ============================================================
function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if ((e.parameter.action || "") === "runoff") {
      return jsonResponse(getRunoffConfig(ss));
    }

    const judgeId = (e.parameter.judgeId || "").trim();
    if (!judgeId) throw new Error("judgeId parameter required");

    const history = buildJudgeHistory(ss, judgeId);

    return jsonResponse({ status: "success", votes: history });
  } catch (err) {
    return jsonResponse({ status: "error", message: err.message });
  }
}


// ============================================================
// writeVotesToSheet
// ============================================================
function writeVotesToSheet(ss, data) {
  const sheet = getOrCreateSheet(ss, VOTES_SHEET_NAME, VOTES_HEADERS);

  // Remove any previous submission for this judge + category
  // so a resubmission cleanly replaces the old one.
  // Runoff rows carry the runoff suffix in the category, so they are
  // a separate key and never collide with round 1.
  deleteJudgeCategoryRows(sheet, data.judgeId, data.category);

  const ts       = data.timestamp || new Date().toISOString();
  const noAward  = !!(data.noAward || !data.votes || data.votes.length === 0);
  const round    = Number(data.round) === 2 ? 2 : 1;
  const placeLabels = { 1: "1st Place", 2: "2nd Place", 3: "3rd Place", 4: "HM" };

  if (noAward) {
    sheet.appendRow([
      ts, data.judgeId, data.category,
      "", "", "No Award",
      "", "", "", "", true, round,
    ]);
    return;
  }

  data.votes.forEach((vote) => {
    sheet.appendRow([
      ts,
      data.judgeId,
      data.category,
      vote.entryId,
      vote.place,
      placeLabels[vote.place] || String(vote.place),
      vote.title        || "",
      vote.photographer || "",
      vote.publication  || "",
      vote.comment      || "",
      false,
      round,
    ]);
  });
}


// ============================================================
// deleteJudgeCategoryRows — removes existing rows for a
// judge + category so resubmissions replace cleanly
// ============================================================
function deleteJudgeCategoryRows(sheet, judgeId, category) {
  const data = sheet.getDataRange().getValues();
  // Scan bottom-up so row deletions don't shift indices
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === judgeId && data[i][2] === category) {
      sheet.deleteRow(i + 1); // sheet rows are 1-indexed
    }
  }
}


// ============================================================
// buildJudgeHistory — returns { CategoryName: [{entryId, place, comment}] }
// Runoff categories come back under their suffixed name, which is what
// lets the app show a "done" badge for a completed tiebreaker.
// ============================================================
function buildJudgeHistory(ss, judgeId) {
  const sheet = ss.getSheetByName(VOTES_SHEET_NAME);
  if (!sheet) return {};

  const rows    = sheet.getDataRange().getValues();
  const headers = rows[0];
  const c       = (name) => headers.indexOf(name);

  const history = {};

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[c("JudgeId")]) !== String(judgeId)) continue;

    const category = row[c("Category")];
    const noAward  = row[c("NoAward")];

    // Always ensure the category key exists (even for no-award submissions)
    if (!history[category]) history[category] = [];
    if (noAward) continue; // no-award → empty array signals "reviewed, no placements"

    const entryId = row[c("EntryId")];
    const place   = Number(row[c("Place")]);
    if (!entryId || !place) continue;

    history[category].push({
      entryId,
      place,
      title:   row[c("Title")]   || "",
      comment: row[c("Comment")] || "",
    });
  }

  return history;
}


// ============================================================
// Scoring helpers — shared by the tally and the tie detector so
// the two can never disagree about what an entry is worth.
// ============================================================
function weightedScore(scores) {
  return Object.keys(scores).reduce(
    (sum, p) => sum + (WEIGHTS[Number(p)] || 0) * scores[p], 0);
}

// Is this a round 2 (runoff) vote row?
function isRunoffRow(category, roundValue) {
  if (Number(roundValue) === 2) return true;
  return String(category || "").slice(-RUNOFF_SUFFIX.length) === RUNOFF_SUFFIX;
}

function baseCategoryName(category) {
  const s = String(category || "");
  return s.slice(-RUNOFF_SUFFIX.length) === RUNOFF_SUFFIX
    ? s.slice(0, s.length - RUNOFF_SUFFIX.length)
    : s;
}

// Aggregate vote rows into { category → { entryId → {meta, scores} } }.
// wantRunoff=false returns round 1 votes under their real category name;
// wantRunoff=true returns round 2 votes keyed by their BASE category.
function aggregateVotes(rows, wantRunoff) {
  const headers = rows[0];
  const c       = (name) => headers.indexOf(name);
  const iRound  = c("Round");
  const agg     = {};

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[c("NoAward")]) continue;

    const rawCategory = String(row[c("Category")] || "").trim();
    const entryId     = String(row[c("EntryId")]  || "").trim();
    const place       = Number(row[c("Place")]);
    if (!entryId || !rawCategory || !place) continue;

    const runoff = isRunoffRow(rawCategory, iRound >= 0 ? row[iRound] : 1);
    if (runoff !== !!wantRunoff) continue;

    const category = runoff ? baseCategoryName(rawCategory) : rawCategory;

    if (!agg[category]) agg[category] = {};
    if (!agg[category][entryId]) {
      agg[category][entryId] = {
        title:        row[c("Title")]        || "",
        photographer: row[c("Photographer")] || "",
        publication:  row[c("Publication")]  || "",
        scores: { 1: 0, 2: 0, 3: 0, 4: 0 },
      };
    }
    agg[category][entryId].scores[place] =
      (agg[category][entryId].scores[place] || 0) + 1;
  }

  return agg;
}

// Per-judge round 2 ballots, for the head-to-head tiebreak:
//   { baseCategory → { judgeId → { entryId: place } } }
function collectRunoffBallots(rows) {
  const headers = rows[0];
  const c       = (name) => headers.indexOf(name);
  const iRound  = c("Round");
  const ballots = {};

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[c("NoAward")]) continue;

    const rawCategory = String(row[c("Category")] || "").trim();
    const entryId     = String(row[c("EntryId")]  || "").trim();
    const judgeId     = String(row[c("JudgeId")]  || "").trim();
    const place       = Number(row[c("Place")]);
    if (!entryId || !rawCategory || !judgeId || !place) continue;
    if (!isRunoffRow(rawCategory, iRound >= 0 ? row[iRound] : 1)) continue;

    const category = baseCategoryName(rawCategory);
    if (!ballots[category]) ballots[category] = {};
    if (!ballots[category][judgeId]) ballots[category][judgeId] = {};
    ballots[category][judgeId][entryId] = place;
  }

  return ballots;
}


// ============================================================
// detectTies — the tie rule, defined in exactly one place.
//
// For a category's entries sorted by weighted score descending:
//   startRank = how many entries score strictly higher (0-indexed)
//   n         = how many share this score
// A group qualifies when n >= 2 and startRank < RUNOFF_MAX_PLACE,
// i.e. the tie reaches into 1st, 2nd or 3rd place.
//
// contestedPlaces is read straight off PLACE_NAMES: the award slots
// the group already occupies, HM slots included and with multiplicity.
// Its length always equals the group size, so in the runoff every
// photo gets exactly one label and nothing is left blank.
//
// Returns [{ category, entryIds, entries, contestedPlaces, score, startRank }]
// ============================================================
function detectTies(agg) {
  const groups = [];

  Object.keys(agg).sort().forEach((cat) => {
    const entries = sortedEntries(agg[cat]);

    let i = 0;
    while (i < entries.length) {
      const score = entries[i].score;
      let j = i;
      while (j < entries.length && entries[j].score === score) j++;
      const n = j - i;

      if (n >= 2 && i < RUNOFF_MAX_PLACE && score > 0) {
        // The award slots this group occupies. A group can run off the
        // end of the award list; those members win nothing either way,
        // so only the real slots are contested.
        const slots = PLACE_NAMES.slice(i, i + n);
        if (slots.length > 0) {
          groups.push({
            category:        cat,
            startRank:       i,
            score:           score,
            entryIds:        entries.slice(i, j).map((e) => e.entryId),
            entries:         entries.slice(i, j),
            contestedPlaces: slots.map((s) => PLACE_CODES[s]),
          });
        }
      }
      i = j;
    }
  });

  return groups;
}

// { entryId → data } → [{entryId, ...data, score}] sorted by score desc
function sortedEntries(catAgg) {
  return Object.keys(catAgg)
    .map((entryId) => {
      const e = catAgg[entryId];
      return {
        entryId:      entryId,
        title:        e.title,
        photographer: e.photographer,
        publication:  e.publication,
        scores:       e.scores,
        score:        weightedScore(e.scores),
      };
    })
    .sort((a, b) => b.score - a.score);
}


// ============================================================
// Runoff sheet I/O
// ============================================================

// Read the Runoff tab into { category → { entryId → row } }
function readRunoffSheet(ss) {
  const sheet = ss.getSheetByName(RUNOFF_SHEET_NAME);
  if (!sheet) return {};

  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return {};

  const headers = rows[0];
  const c       = (name) => headers.indexOf(name);
  const out     = {};

  for (let i = 1; i < rows.length; i++) {
    const row      = rows[i];
    const category = String(row[c("Category")] || "").trim();
    const entryId  = String(row[c("EntryId")]  || "").trim();
    if (!category || !entryId) continue;

    if (!out[category]) out[category] = {};
    out[category][entryId] = {
      rowIndex:        i + 1, // 1-indexed sheet row
      groupId:         String(row[c("GroupId")] || "").trim(),
      status:          String(row[c("Status")]  || "").trim().toLowerCase(),
      manualPlace:     normalizePlaceLabel(row[c("ManualPlace")]),
      contestedPlaces: String(row[c("ContestedPlaces")] || "").trim(),
    };
  }

  return out;
}

// Accept "1st", "1st place", "HM", "hm" etc. and return the canonical
// PLACE_NAMES spelling, so the organizer can type it however they like.
function normalizePlaceLabel(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "hm" || v.indexOf("honorable") === 0) return "HM";
  if (v.indexOf("1st") === 0 || v === "1" || v === "first")  return "1st Place";
  if (v.indexOf("2nd") === 0 || v === "2" || v === "second") return "2nd Place";
  if (v.indexOf("3rd") === 0 || v === "3" || v === "third")  return "3rd Place";
  return "";
}

// Config consumed by the judging app at ?action=runoff
function getRunoffConfig(ss) {
  const sheet = ss.getSheetByName(RUNOFF_SHEET_NAME);
  if (!sheet) return { status: "success", open: false, groups: [] };

  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return { status: "success", open: false, groups: [] };

  const headers = rows[0];
  const c       = (name) => headers.indexOf(name);
  const byGroup = {};
  const order   = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (String(row[c("Status")] || "").trim().toLowerCase() !== "open") continue;

    const category = String(row[c("Category")] || "").trim();
    const entryId  = String(row[c("EntryId")]  || "").trim();
    const groupId  = String(row[c("GroupId")]  || "").trim() || category;
    if (!category || !entryId) continue;

    if (!byGroup[groupId]) {
      byGroup[groupId] = {
        category:        category,
        groupId:         groupId,
        entryIds:        [],
        contestedPlaces: String(row[c("ContestedPlaces")] || "")
                           .split(",")
                           .map(function (s) { return Number(s.trim()); })
                           .filter(function (n) { return n >= 1 && n <= 4; }),
      };
      order.push(groupId);
    }
    byGroup[groupId].entryIds.push(entryId);
  }

  const groups = order.map(function (g) { return byGroup[g]; });
  return { status: "success", open: groups.length > 0, groups: groups };
}


// ============================================================
// closeVotingAndCheckTies — PPAGLA menu.
// Run this once voting is declared closed. It aggregates round 1
// votes, finds every tie that affects 1st/2nd/3rd, and writes them
// to the Runoff tab ready for round 2.
// ============================================================
function closeVotingAndCheckTies() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  const votesSheet = ss.getSheetByName(VOTES_SHEET_NAME);
  if (!votesSheet) { ui.alert("No Votes sheet found - nothing to check."); return; }

  const rows   = votesSheet.getDataRange().getValues();
  const agg    = aggregateVotes(rows, false);
  const groups = detectTies(agg);

  // Preserve any manual calls the organizer already made
  const existing    = readRunoffSheet(ss);
  const priorManual = {};
  Object.keys(existing).forEach(function (cat) {
    Object.keys(existing[cat]).forEach(function (eid) {
      if (existing[cat][eid].manualPlace) {
        priorManual[cat + " " + eid] = existing[cat][eid].manualPlace;
      }
    });
  });

  const sheet = getOrCreateSheet(ss, RUNOFF_SHEET_NAME, RUNOFF_HEADERS);
  sheet.clearContents();
  sheet.clearFormats();

  const out = [RUNOFF_HEADERS];
  groups.forEach(function (g, gi) {
    const groupId = g.category + " #" + (gi + 1);
    g.entries.forEach(function (e) {
      out.push([
        g.category, e.entryId, e.title, e.photographer,
        g.contestedPlaces.join(","), groupId, g.score, "open",
        priorManual[g.category + " " + e.entryId] || "",
        "", "", "", "", "", "",
      ]);
    });
  });

  sheet.getRange(1, 1, out.length, RUNOFF_HEADERS.length).setValues(out);
  sheet.getRange(1, 1, 1, RUNOFF_HEADERS.length)
    .setFontWeight("bold").setBackground("#eeeeee");
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, RUNOFF_HEADERS.length);

  if (groups.length === 0) {
    ui.alert(
      "Voting closed - no ties found.\n\n" +
      "Every category has a clear 1st, 2nd and 3rd. You can run\n" +
      "PPAGLA > Export Winners to Drive whenever you're ready."
    );
    return;
  }

  const link = JUDGING_SITE_URL
    ? JUDGING_SITE_URL.replace(/\/+$/, "") + "/?round=2"
    : "your judging site URL with ?round=2 on the end";

  const lines = groups.map(function (g) {
    const places = g.contestedPlaces.map(function (p) {
      return { 1: "1st", 2: "2nd", 3: "3rd", 4: "HM" }[p];
    }).join(", ");
    return "- " + g.category + ": " + g.entries.length +
           " tied at " + g.score + " pts, deciding " + places + "\n" +
           "     " + g.entries.map(function (e) { return e.entryId; }).join(", ");
  });

  ui.alert(
    "Voting closed - " + groups.length + " tie" + (groups.length === 1 ? "" : "s") +
    " need a second round.\n\n" +
    lines.join("\n") + "\n\n" +
    "Send judges this link:\n" + link + "\n\n" +
    "They will see only the tied photos. The Tally sheet updates itself\n" +
    "as their votes come in - no further action needed here.\n\n" +
    "Tip: an ODD number of judges makes ties far less likely. Do not\n" +
    "add a fourth judge to a panel of three."
  );
}


// ============================================================
// closeRunoff — PPAGLA menu. Marks every Runoff row closed so the
// round 2 link stops showing any tiebreakers.
// ============================================================
function closeRunoff() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const ui    = SpreadsheetApp.getUi();
  const sheet = ss.getSheetByName(RUNOFF_SHEET_NAME);
  if (!sheet) { ui.alert("No Runoff sheet found."); return; }

  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) { ui.alert("No runoff rows to close."); return; }

  const col = rows[0].indexOf("Status") + 1;
  if (col < 1) { ui.alert("Runoff sheet is missing its Status column."); return; }

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim()) sheet.getRange(i + 1, col).setValue("closed");
  }
  ui.alert("Runoff closed. The round 2 link will no longer show any tiebreakers.");
}


// ============================================================
// resolveGroup — decides the order of a set of tied entries.
//
// Order of authority:
//   1. ManualPlace from the Runoff tab (applied by the caller)
//   2. Round 2 weighted score
//   3. Head-to-head: how many judges ranked A above B (Copeland).
//      Every judge ranks every photo in the group with no blanks,
//      so this is always computable.
//   4. Most round 2 votes at the best slot, then the next, and so on
//   5. Most round 1 1st-place votes
//   6. Still tied - reported as unresolved rather than guessed at
//
// Returns { order: [...members], unresolved: bool }
// ============================================================
function resolveGroup(members, r2Scores, ballots) {
  const r2 = function (m) {
    const s = r2Scores[m.entryId];
    return s ? s.scores : { 1: 0, 2: 0, 3: 0, 4: 0 };
  };

  // Copeland score: pairwise wins minus losses across all round 2 ballots
  const copeland = {};
  members.forEach(function (a) {
    let net = 0;
    members.forEach(function (b) {
      if (a.entryId === b.entryId) return;
      let aOver = 0, bOver = 0;
      Object.keys(ballots || {}).forEach(function (judgeId) {
        const bal = ballots[judgeId];
        const pa = bal[a.entryId], pb = bal[b.entryId];
        if (!pa || !pb) return;      // this judge didn't rank both
        if (pa < pb) aOver++;        // lower place number = better
        else if (pb < pa) bOver++;
      });
      if (aOver > bOver) net++;
      else if (bOver > aOver) net--;
    });
    copeland[a.entryId] = net;
  });

  let unresolved = false;

  const order = members.slice().sort(function (a, b) {
    const sa = weightedScore(r2(a)), sb = weightedScore(r2(b));
    if (sa !== sb) return sb - sa;                                  // 2

    if (copeland[a.entryId] !== copeland[b.entryId]) {              // 3
      return copeland[b.entryId] - copeland[a.entryId];
    }

    for (let p = 1; p <= 4; p++) {                                  // 4
      const ca = r2(a)[p] || 0, cb = r2(b)[p] || 0;
      if (ca !== cb) return cb - ca;
    }

    const fa = (a.scores && a.scores[1]) || 0;                      // 5
    const fb = (b.scores && b.scores[1]) || 0;
    if (fa !== fb) return fb - fa;

    unresolved = true;                                              // 6
    return 0;
  });

  return { order: order, unresolved: unresolved };
}

// Place pinned entries at their ManualPlace slot, then fill the
// remaining slots with the resolved order.
function applyManualPins(members, slotLabels, resolvedOrder, manualFor) {
  const n      = slotLabels.length;
  const result = new Array(n);
  const used   = new Array(n);
  const pinned = {};

  members.forEach(function (m) {
    const want = manualFor(m.entryId);
    if (!want) return;
    for (let i = 0; i < n; i++) {
      if (!used[i] && slotLabels[i] === want) {
        result[i] = m; used[i] = true; pinned[m.entryId] = true;
        return;
      }
    }
  });

  let k = 0;
  resolvedOrder.forEach(function (m) {
    if (pinned[m.entryId]) return;
    while (k < n && used[k]) k++;
    if (k < n) { result[k] = m; used[k] = true; }
  });

  // Belt and braces: never leave a hole
  for (let i = 0; i < n; i++) {
    if (!result[i]) result[i] = members[i];
  }
  return result;
}


// ============================================================
// rebuildTally — recalculates the Tally sheet from all votes.
// Called automatically after every submission.
//
// Round 2 (runoff) votes never appear in the Tally as their own
// category. They are used to order the tied entries inside their
// real category instead. That keeps exportWinners, which copies
// every row with a Suggested Place, from producing a bogus
// "Runoff" folder that duplicates the real winners.
// ============================================================
function rebuildTally(ss) {
  const votesSheet = ss.getSheetByName(VOTES_SHEET_NAME);
  if (!votesSheet) return;

  const rows      = votesSheet.getDataRange().getValues();
  const agg       = aggregateVotes(rows, false);  // round 1, real categories
  const runoffAgg = aggregateVotes(rows, true);   // round 2, keyed by base category
  const ballots   = collectRunoffBallots(rows);
  const runoffCfg = readRunoffSheet(ss);

  const tallyHeaders = [
    "Category", "EntryId", "Title", "Photographer", "Publication",
    "1st Votes", "2nd Votes", "3rd Votes", "HM Votes",
    "Weighted Score", "Suggested Place",
  ];
  const tallyRows = [tallyHeaders];

  const audit      = {};  // "category entryId" → how the tie broke
  const unresolved = {};  // category → true

  Object.keys(agg).sort().forEach((cat) => {
    const entries = sortedEntries(agg[cat]);

    // ── Apply runoff results, if this category has any ──────────
    const cfg = runoffCfg[cat];
    if (cfg) {
      const byGroup = {};
      Object.keys(cfg).forEach(function (entryId) {
        const g = cfg[entryId].groupId || cat;
        if (!byGroup[g]) byGroup[g] = [];
        byGroup[g].push(entryId);
      });

      Object.keys(byGroup).forEach(function (groupId) {
        // Where do this group's entries currently sit? Working from
        // their actual positions means the group is only ever
        // reordered within the slots it already occupied - a runoff
        // can never promote an entry above a higher-scoring one.
        const positions = [];
        byGroup[groupId].forEach(function (id) {
          for (let i = 0; i < entries.length; i++) {
            if (entries[i].entryId === id) { positions.push(i); break; }
          }
        });
        if (positions.length < 2) return;
        positions.sort(function (a, b) { return a - b; });

        const members    = positions.map(function (i) { return entries[i]; });
        const slotLabels = positions.map(function (i) {
          return i < PLACE_NAMES.length ? PLACE_NAMES[i] : "";
        });

        const res = resolveGroup(members, runoffAgg[cat] || {}, ballots[cat] || {});
        const finalOrder = applyManualPins(
          members, slotLabels, res.order,
          function (entryId) { return (cfg[entryId] || {}).manualPlace || ""; }
        );

        positions.forEach(function (pos, k) { entries[pos] = finalOrder[k]; });

        finalOrder.forEach(function (m, k) {
          const s  = (runoffAgg[cat] || {})[m.entryId];
          const sc = s ? s.scores : { 1: 0, 2: 0, 3: 0, 4: 0 };
          audit[cat + " " + m.entryId] = {
            r2:         sc,
            r2Score:    s ? weightedScore(sc) : "",
            finalPlace: slotLabels[k] || "",
          };
        });

        const hasVotes = members.some(function (m) {
          return !!(runoffAgg[cat] || {})[m.entryId];
        });
        if (res.unresolved && hasVotes) unresolved[cat] = true;
      });
    }

    // ── Build the output rows ───────────────────────────────────
    let rank = 0;
    entries.forEach((entry) => {
      // Assign suggested place: 1st/2nd/3rd then up to 4 HMs
      let suggestedPlace = "";
      if (entry.score > 0 && rank < PLACE_NAMES.length) {
        suggestedPlace = PLACE_NAMES[rank];
        rank++;
      }

      tallyRows.push([
        cat, entry.entryId, entry.title, entry.photographer, entry.publication,
        entry.scores[1], entry.scores[2], entry.scores[3], entry.scores[4],
        entry.score, suggestedPlace,
      ]);
    });

    // Blank separator row between categories
    tallyRows.push(new Array(tallyHeaders.length).fill(""));
  });

  // Write to sheet
  const tallySheet = getOrCreateSheet(ss, TALLY_SHEET_NAME, null);
  tallySheet.clearContents();
  tallySheet.clearFormats();

  if (tallyRows.length < 2) return;

  tallySheet.getRange(1, 1, tallyRows.length, tallyHeaders.length)
    .setValues(tallyRows);

  // ── Formatting ──────────────────────────────────────────────
  const headerRow = tallySheet.getRange(1, 1, 1, tallyHeaders.length);
  headerRow.setFontWeight("bold").setBackground("#eeeeee");
  tallySheet.setFrozenRows(1);

  const highlightColors = {
    "1st Place": "#fff2cc", // gold tint
    "2nd Place": "#e8f5e9", // green tint
    "3rd Place": "#e8f0fe", // blue tint
    "HM":        "#fce8e6", // red tint
  };

  for (let i = 1; i < tallyRows.length; i++) {
    const suggestedPlace = tallyRows[i][10];
    const color = highlightColors[suggestedPlace];
    if (color) {
      tallySheet.getRange(i + 1, 1, 1, tallyHeaders.length).setBackground(color);
    }
  }

  tallySheet.autoResizeColumns(1, tallyHeaders.length);

  writeRunoffAudit(ss, audit, unresolved);
}


// ============================================================
// writeRunoffAudit — records how each tie broke, back onto the
// Runoff tab. Purely informational; nothing reads it back.
// Groups the script could not break are highlighted so the
// organizer knows to use ManualPlace.
// ============================================================
function writeRunoffAudit(ss, audit, unresolved) {
  const sheet = ss.getSheetByName(RUNOFF_SHEET_NAME);
  if (!sheet) return;

  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return;

  const headers = rows[0];
  const c       = (name) => headers.indexOf(name);
  const first   = c("R2 1st");
  if (first < 0) return;

  const block = [];
  for (let i = 1; i < rows.length; i++) {
    const cat = String(rows[i][c("Category")] || "").trim();
    const eid = String(rows[i][c("EntryId")]  || "").trim();
    const a   = audit[cat + " " + eid];
    if (!cat || !eid || !a) { block.push(["", "", "", "", "", ""]); continue; }
    block.push([
      a.r2[1] || 0, a.r2[2] || 0, a.r2[3] || 0, a.r2[4] || 0,
      a.r2Score, a.finalPlace,
    ]);
  }

  if (block.length === 0) return;
  sheet.getRange(2, first + 1, block.length, 6).setValues(block);

  // Flag any group the script could not break — and UNflag the ones it can
  // now break. A partly-voted group is often tied on the way to a clear
  // result: with one judge in, two photos can sit on identical counts and
  // exhaust every tiebreak, then separate once the rest vote. Setting the
  // colour without ever clearing it would leave that transient deadlock
  // showing as a permanent warning on a group that resolved perfectly well.
  for (let i = 1; i < rows.length; i++) {
    const cat = String(rows[i][c("Category")] || "").trim();
    if (!cat) continue;
    sheet.getRange(i + 1, 1, 1, headers.length)
      .setBackground(unresolved[cat] ? "#ffe0b2" : null);
  }
}


// ============================================================
// exportWinners — copies winning images to Drive.
// Run via PPAGLA menu → Export Winners.
// ============================================================
function exportWinners() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  // ── Load Entries sheet ──────────────────────────────────────
  const entriesSheet = ss.getSheetByName(ENTRIES_SHEET_NAME);
  if (!entriesSheet) {
    ui.alert(
      "Entries sheet not found.\n\n" +
      "Import your entries.csv into a tab named 'Entries' first:\n" +
      "File → Import → Upload → Append to current sheet"
    );
    return;
  }

  const eRows    = entriesSheet.getDataRange().getValues();
  const eHeaders = eRows[0];
  const eCol     = (name) =>
    eHeaders.findIndex((h) => h.toString().toLowerCase() === name.toLowerCase());

  // entryMap: entry_id → row data (single images)
  // essayMap: essay_id → [photos] (essay entries)
  const entryMap = {};
  const essayMap = {};

  for (let i = 1; i < eRows.length; i++) {
    const row        = eRows[i];
    const entryId    = String(row[eCol("entry_id")]    || "").trim();
    const essayId    = String(row[eCol("essay_id")]    || "").trim();
    const fileId     = String(row[eCol("drive_file_id")] || "").trim();
    const filename   = String(row[eCol("filename")]    || "").trim();
    const photographer = String(row[eCol("photographer")] || "").trim();
    const publication  = String(row[eCol("publication")]  || "").trim();
    const imageNumber  = Number(row[eCol("image_number")] || 0);

    if (!entryId) continue;

    entryMap[entryId] = { filename, photographer, publication, fileId, essayId, imageNumber };

    if (essayId) {
      if (!essayMap[essayId]) essayMap[essayId] = [];
      essayMap[essayId].push({ entryId, filename, photographer, publication, fileId, imageNumber });
    }
  }

  // ── Load Tally sheet ────────────────────────────────────────
  const tallySheet = ss.getSheetByName(TALLY_SHEET_NAME);
  if (!tallySheet) {
    ui.alert("Tally sheet not found. Make sure votes have been submitted.");
    return;
  }

  const tRows    = tallySheet.getDataRange().getValues();
  const tHeaders = tRows[0];
  const tCol     = (name) =>
    tHeaders.findIndex((h) => h.toString().toLowerCase() === name.toLowerCase());

  // Collect winners: { category → [{entryId, place, photographer, publication}] }
  const winners = {};

  for (let i = 1; i < tRows.length; i++) {
    const row   = tRows[i];
    const place = String(row[tCol("Suggested Place")] || "").trim();
    if (!place) continue;

    const category     = String(row[tCol("Category")]     || "").trim();
    const entryId      = String(row[tCol("EntryId")]      || "").trim();
    const photographer = String(row[tCol("Photographer")] || "").trim();
    const publication  = String(row[tCol("Publication")]  || "").trim();

    if (!category || !entryId) continue;
    if (!winners[category]) winners[category] = [];
    winners[category].push({ entryId, place, photographer, publication });
  }

  if (Object.keys(winners).length === 0) {
    ui.alert("No suggested placements found in the Tally sheet.\n\n" +
      "Make sure judges have submitted votes and the Tally sheet has been generated.");
    return;
  }

  // ── Set up Winners folder ────────────────────────────────────
  const rootFolder = WINNERS_FOLDER_ID
    ? DriveApp.getFolderById(WINNERS_FOLDER_ID)
    : getOrCreateDriveFolder(DriveApp.getRootFolder(), "PPAGLA Winners");

  // ── Copy files ──────────────────────────────────────────────
  const log    = [];
  let   copied = 0;
  let   errors = 0;

  Object.entries(winners).forEach(([category, categoryWinners]) => {
    const catFolder = getOrCreateDriveFolder(rootFolder, category);

    categoryWinners.forEach((winner) => {
      // Build filename prefix: e.g. "1st_Place_Jane_Smith_Los_Angeles_Times"
      const placePrefix  = winner.place.replace(/\s+/g, "_"); // "1st_Place"
      const photoCredit  = winner.photographer || "";
      const pubCredit    = winner.publication  || "";
      const safePhoto    = safeName(photoCredit);
      const safePub      = safeName(pubCredit);
      const prefix       = [placePrefix, safePhoto, safePub].filter(Boolean).join("_");

      if (essayMap[winner.entryId]) {
        // ── Essay winner: copy all photos ──────────────────────
        const photos = essayMap[winner.entryId]
          .sort((a, b) => a.imageNumber - b.imageNumber);

        if (photos.length === 0) {
          log.push(`⚠  ${category} / ${winner.place}: no photos found for ${winner.entryId}`);
          errors++;
          return;
        }

        const creditFromPhotos = photos[0].photographer || photoCredit;
        const pubFromPhotos    = photos[0].publication  || pubCredit;
        const essayPrefix      = [
          placePrefix,
          safeName(creditFromPhotos),
          safeName(pubFromPhotos),
        ].filter(Boolean).join("_");

        photos.forEach((photo) => {
          if (!photo.fileId) {
            log.push(`⚠  Missing Drive ID for ${photo.filename}`);
            errors++;
            return;
          }
          try {
            const file    = DriveApp.getFileById(photo.fileId);
            const newName = `${essayPrefix}_${photo.filename}`;
            file.makeCopy(newName, catFolder);
            log.push(`✓  ${category} / ${winner.place}: ${newName}`);
            copied++;
          } catch (err) {
            log.push(`✗  ${photo.filename}: ${err.message}`);
            errors++;
          }
        });

      } else if (entryMap[winner.entryId]) {
        // ── Single-image winner ────────────────────────────────
        const entry = entryMap[winner.entryId];

        if (!entry.fileId) {
          log.push(`⚠  ${category} / ${winner.place}: no Drive file ID for ${winner.entryId}`);
          errors++;
          return;
        }
        try {
          const file    = DriveApp.getFileById(entry.fileId);
          const newName = `${prefix}_${entry.filename}`;
          file.makeCopy(newName, catFolder);
          log.push(`✓  ${category} / ${winner.place}: ${newName}`);
          copied++;
        } catch (err) {
          log.push(`✗  ${entry.filename}: ${err.message}`);
          errors++;
        }

      } else {
        log.push(`⚠  ${category} / ${winner.place}: entry "${winner.entryId}" not found in Entries sheet`);
        errors++;
      }
    });
  });

  // ── Summary alert ────────────────────────────────────────────
  const summary =
    `Export complete!\n` +
    `Copied: ${copied}   Errors: ${errors}\n` +
    `Saved to: ${rootFolder.getName()}\n\n` +
    log.join("\n");

  ui.alert(summary);
}


// ============================================================
// onOpen — adds a custom PPAGLA menu to the Sheet
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("PPAGLA")
    .addItem("Rebuild Tally",                 "rebuildTally_menu")
    .addSeparator()
    .addItem("Close Voting & Check for Ties", "closeVotingAndCheckTies")
    .addItem("Close Runoff",                  "closeRunoff")
    .addSeparator()
    .addItem("Export Winners to Drive",       "exportWinners")
    .addSeparator()
    .addItem("Set Drive Folder ID",           "setDriveFolderId")
    .addItem("Fill Drive File IDs",           "fillDriveFileIds")
    .addToUi();
}

// Menu wrapper (rebuildTally needs an ss param normally)
function rebuildTally_menu() {
  rebuildTally(SpreadsheetApp.getActiveSpreadsheet());
  SpreadsheetApp.getUi().alert("Tally rebuilt successfully.");
}


// ============================================================
// Helpers
// ============================================================

// Convert "Jane Smith" → "Jane_Smith", "L.A. Times" → "LA_Times"
function safeName(str) {
  return (str || "")
    .trim()
    .replace(/[.]/g, "")          // remove periods
    .replace(/\s+/g, "_")         // spaces → underscores
    .replace(/[^a-zA-Z0-9_\-]/g, ""); // remove other special chars
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length > 0) {
      sheet.appendRow(headers);
      const headerRange = sheet.getRange(1, 1, 1, headers.length);
      headerRange.setFontWeight("bold").setBackground("#eeeeee");
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

function getOrCreateDriveFolder(parent, name) {
  const iter = parent.getFoldersByName(name);
  return iter.hasNext() ? iter.next() : parent.createFolder(name);
}


// ─── ONE-TIME FIX: Correct Votes sheet header row ────────────────────────────
// Run this once after pasting this version of the script. It adds the
// "Round" column. Existing rows leave it blank, which counts as round 1.
function fixVotesHeaders() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(VOTES_SHEET_NAME);
  if (!sheet) { Logger.log("Votes sheet not found"); return; }
  sheet.getRange(1, 1, 1, VOTES_HEADERS.length).setValues([VOTES_HEADERS]);
  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert("Votes headers fixed! Now run Rebuild Tally.");
  Logger.log("Headers set: " + VOTES_HEADERS.join(", "));
}
