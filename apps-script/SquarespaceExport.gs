/**
 * PPAGLA Photo Judging — Export Winners for Squarespace
 * ================================================================
 * Add this as its own file in the Apps Script project
 * (Files ＋ → Script → name it "SquarespaceExport"), then add this line
 * to the PPAGLA menu in onOpen() in Code.gs:
 *
 *     .addItem("Export Squarespace Winners", "exportSquarespaceWinners")
 *
 * What it does:
 *   Copies every winning image (1st/2nd/3rd/HM, including runoff results,
 *   straight from the Tally tab's Suggested Place) into
 *
 *     PPAGLA Winners / Squarespace Upload / PortWinners, FireWinners, ...
 *
 *   renamed in the format the site's title script expects:
 *
 *     1st_PORT_Jane Smith - LA Times_1st.jpg          (single images)
 *     2nd_PICSTORY_Jane Smith - LA Times_03.jpg       (essay / picture story)
 *
 *   No phone numbers or original filenames — those stay in the regular
 *   "Export Winners to Drive" output, which this does not touch.
 *
 *   Files are full resolution. Run "Resize for Squarespace" on your Mac
 *   afterwards to bring them to 3000px on the long edge.
 *
 * Safe to re-run:
 *   • Files that are already there with the right name are skipped.
 *   • Files that are no longer winners (e.g. placements changed) are moved
 *     to the Drive trash (recoverable for 30 days).
 *   • If Google's 6-minute limit is hit, it stops cleanly and tells you to
 *     run it again; the next run picks up where it left off.
 */

// ── Squarespace naming (mirrors workflow/config.yaml) ────────────────────────
const SQ_PARENT_FOLDER_NAME = "Squarespace Upload";

const SQ_CATEGORY_CODES = {
  "Portrait":       "PORT",
  "Sports Action":  "SPORTAction",
  "Sports Feature": "SPORTFeat",
  "Feature":        "FEAT",
  "General News":   "GENNews",
  "Spot News":      "SPOTNews",
  "Fire":           "FIRE",
  "Pictorial":      "PICT",
  "Picture Story":  "PICSTORY",
  "Photo Essay":    "PHOTOESSAY",
  "Entertainment":  "ENT",
  "Animal":         "ANIMAL",
};

const SQ_CATEGORY_FOLDERS = {
  "Portrait":       "PortWinners",
  "Sports Action":  "SportsActionWinners",
  "Sports Feature": "SportsFeatureWinners",
  "Feature":        "FeatureWinner",
  "General News":   "GenNewsWinners",
  "Spot News":      "SpotNewsWinners",
  "Fire":           "FireWinners",
  "Pictorial":      "PictorialWinners",
  "Picture Story":  "PicStoryWinners",
  "Photo Essay":    "PhotoEssayWinners",
  "Entertainment":  "EntertainmentWinners",
  "Animal":         "AnimalWinners",
};

// Stop copying after this long so we finish before Google's 6-min cap.
const SQ_TIME_BUDGET_MS = 5 * 60 * 1000;


// ============================================================
// Menu entry point
// ============================================================
function exportSquarespaceWinners() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();
  const started = Date.now();

  const tallySheet   = ss.getSheetByName(TALLY_SHEET_NAME);
  const entriesSheet = ss.getSheetByName(ENTRIES_SHEET_NAME);
  if (!tallySheet || !entriesSheet) {
    ui.alert("Tally or Entries tab not found.");
    return;
  }

  const plan = buildSquarespacePlan_(
    tallySheet.getDataRange().getValues(),
    entriesSheet.getDataRange().getValues()
  );

  if (plan.files.length === 0) {
    ui.alert("No winners found in the Tally tab.\n\n" + plan.problems.join("\n"));
    return;
  }

  // ── Folders ───────────────────────────────────────────────
  const rootFolder = WINNERS_FOLDER_ID
    ? DriveApp.getFolderById(WINNERS_FOLDER_ID)
    : getOrCreateDriveFolder(DriveApp.getRootFolder(), "PPAGLA Winners");
  const sqFolder = getOrCreateDriveFolder(rootFolder, SQ_PARENT_FOLDER_NAME);

  // Group planned files by output folder
  const byFolder = {};
  plan.files.forEach(function (f) {
    (byFolder[f.folder] = byFolder[f.folder] || []).push(f);
  });

  let copied = 0, skipped = 0, trashed = 0, errors = 0, outOfTime = false;
  const log = [];

  // Clear out category folders that no longer have any winners at all
  const knownFolders = Object.keys(SQ_CATEGORY_FOLDERS).map(function (k) { return SQ_CATEGORY_FOLDERS[k]; });
  knownFolders.forEach(function (name) {
    if (byFolder[name]) return;
    const it = sqFolder.getFoldersByName(name);
    if (!it.hasNext()) return;
    const files = it.next().getFiles();
    while (files.hasNext()) { files.next().setTrashed(true); trashed++; }
  });

  Object.keys(byFolder).sort().forEach(function (folderName) {
    if (outOfTime) return;
    const folder = getOrCreateDriveFolder(sqFolder, folderName);
    const wanted = {};
    byFolder[folderName].forEach(function (f) { wanted[f.name] = f; });

    // What's already there? Trash anything that isn't a current winner
    // (and any duplicate copies), remember the rest so we can skip them.
    const have = {};
    const existing = folder.getFiles();
    while (existing.hasNext()) {
      const file = existing.next();
      const name = file.getName();
      if (!wanted[name] || have[name]) {
        file.setTrashed(true);
        trashed++;
        log.push("🗑  " + folderName + "/" + name + " (no longer a winner)");
      } else {
        have[name] = true;
      }
    }

    byFolder[folderName].forEach(function (f) {
      if (outOfTime) return;
      if (have[f.name]) { skipped++; return; }
      if (Date.now() - started > SQ_TIME_BUDGET_MS) { outOfTime = true; return; }
      try {
        DriveApp.getFileById(f.fileId).makeCopy(f.name, folder);
        copied++;
      } catch (err) {
        errors++;
        log.push("✗  " + folderName + "/" + f.name + ": " + err.message);
      }
    });
  });

  // ── Summary ───────────────────────────────────────────────
  const counts = Object.keys(byFolder).sort().map(function (k) {
    return "   " + k + ": " + byFolder[k].length;
  });
  const lines = [];
  if (outOfTime) {
    lines.push("⏸  Paused before Google's time limit.",
               "Run  PPAGLA → Export Squarespace Winners  again to finish.", "");
  } else {
    lines.push("✓  Squarespace export complete.", "");
  }
  lines.push("Copied: " + copied + "   Already there: " + skipped +
             "   Removed: " + trashed + "   Errors: " + (errors + plan.problems.length));
  lines.push("Folder: " + rootFolder.getName() + " / " + SQ_PARENT_FOLDER_NAME, "");
  lines.push("Files per folder:");
  lines.push.apply(lines, counts);
  if (plan.problems.length || log.length) {
    lines.push("", "Notes:");
    lines.push.apply(lines, plan.problems.concat(log).slice(0, 40));
  }
  if (!outOfTime) {
    lines.push("", "Next: download/sync the folder and run \"Resize for Squarespace\" on your Mac.");
  }
  ui.alert(lines.join("\n"));
}


// ============================================================
// buildSquarespacePlan_ — pure function (no Drive calls), so it
// can be tested on its own. Returns { files: [...], problems: [...] }
// where each file is { category, place, folder, name, fileId }.
// ============================================================
function buildSquarespacePlan_(tallyValues, entriesValues) {
  const problems = [];
  const files = [];

  // ── Entries lookup ─────────────────────────────────────────
  const eh = entriesValues[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const ec = function (n) { return eh.indexOf(n); };
  const entryMap = {}, essayMap = {};
  for (let i = 1; i < entriesValues.length; i++) {
    const r = entriesValues[i];
    const e = {
      entryId:      String(r[ec("entry_id")] || "").trim(),
      essayId:      String(r[ec("essay_id")] || "").trim(),
      filename:     String(r[ec("filename")] || "").trim(),
      photographer: String(r[ec("photographer")] || "").trim(),
      publication:  String(r[ec("publication")] || "").trim(),
      fileId:       String(r[ec("drive_file_id")] || "").trim(),
      imageNumber:  Number(r[ec("image_number")] || 0),
    };
    if (!e.entryId) continue;
    entryMap[e.entryId] = e;
    if (e.essayId) (essayMap[e.essayId] = essayMap[e.essayId] || []).push(e);
  }

  // ── Tally → winners, in ranked order ───────────────────────
  const th = tallyValues[0].map(function (h) { return String(h).trim().toLowerCase(); });
  const tc = function (n) { return th.indexOf(n.toLowerCase()); };
  const hmCount = {};

  for (let i = 1; i < tallyValues.length; i++) {
    const r = tallyValues[i];
    const label    = String(r[tc("Suggested Place")] || "").trim();
    const category = String(r[tc("Category")] || "").trim();
    const entryId  = String(r[tc("EntryId")] || "").trim();
    if (!label || !category || !entryId) continue;

    let place;
    if (label === "1st Place") place = "1st";
    else if (label === "2nd Place") place = "2nd";
    else if (label === "3rd Place") place = "3rd";
    else if (label === "HM") { hmCount[category] = (hmCount[category] || 0) + 1; place = "HM" + hmCount[category]; }
    else { problems.push("⚠  " + category + " / " + entryId + ": unknown place \"" + label + "\""); continue; }

    const code   = SQ_CATEGORY_CODES[category];
    const folder = SQ_CATEGORY_FOLDERS[category];
    if (!code || !folder) {
      problems.push("⚠  " + category + ": no Squarespace code/folder set (edit SQ_CATEGORY_CODES / SQ_CATEGORY_FOLDERS)");
      continue;
    }

    const isEssay = !!essayMap[entryId];
    const photos = isEssay
      ? essayMap[entryId].slice().sort(function (a, b) { return a.imageNumber - b.imageNumber; })
      : (entryMap[entryId] ? [entryMap[entryId]] : []);
    if (photos.length === 0) {
      problems.push("⚠  " + category + " " + place + ": \"" + entryId + "\" not in Entries tab");
      continue;
    }

    const photographer = sqClean_(String(r[tc("Photographer")] || "").trim() || photos[0].photographer);
    const publication  = sqClean_(String(r[tc("Publication")]  || "").trim() || photos[0].publication);
    if (!photographer) {
      problems.push("⚠  " + category + " " + place + " (" + entryId + "): no photographer name — skipped. Fill it in on the Tally or Entries tab.");
      continue;
    }
    const credit = publication ? photographer + " - " + publication : photographer;

    photos.forEach(function (p, idx) {
      if (!p.fileId) {
        problems.push("⚠  " + category + " " + place + ": no Drive file ID for " + p.filename + " (run Fill Drive File IDs)");
        return;
      }
      const suffix = isEssay ? sqPad2_(p.imageNumber || idx + 1) : place;
      files.push({
        category: category,
        place:    place,
        folder:   folder,
        name:     place + "_" + code + "_" + credit + "_" + suffix + sqExt_(p.filename),
        fileId:   p.fileId,
      });
    });
  }

  return { files: files, problems: problems };
}


// ── Helpers ──────────────────────────────────────────────────
// Underscores would break the site's title script (it splits on "_"),
// so they become spaces. Also drops characters that break filenames.
function sqClean_(s) {
  return String(s || "")
    .replace(/_/g, " ")
    .replace(/[\\\/:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sqPad2_(n) { return (n < 10 ? "0" : "") + n; }

function sqExt_(filename) {
  const m = String(filename).match(/\.([A-Za-z0-9]+)$/);
  const ext = m ? m[1].toLowerCase() : "jpg";
  return "." + (ext === "jpeg" ? "jpg" : ext);
}
