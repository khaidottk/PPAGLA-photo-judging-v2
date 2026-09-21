/**
 * PPAGLA Photo Judging — Fill drive_file_id from Google Drive folder
 * ================================================================
 * Paste this entire script into Extensions > Apps Script inside the
 * "PPAGLA Photo Judging - Results v2" spreadsheet, then run
 * fillDriveFileIds().
 *
 * What it does:
 *   1. Reads all filenames + row positions from the Entries sheet
 *   2. Lists every file (recursively) in your Drive folder
 *   3. Matches by filename (case-insensitive)
 *   4. Writes the Drive file ID into column L (drive_file_id)
 *   5. Writes a resized-thumbnail image URL into column M (image_url)
 *
 * The image URL format used is:
 *   https://drive.google.com/thumbnail?id=<fileId>&sz=w1600
 * This asks Google Drive to generate and serve a resized JPEG (capped at
 * 1600px on the long edge) instead of the full-resolution original. Some
 * submitted originals run up to ~70MB — judges' browsers were downloading
 * that full size for every grid thumbnail AND every lightbox view, since
 * this was previously a raw "lh3.googleusercontent.com/d/<fileId>" link
 * with no size cap. 1600px is plenty for on-screen judging while keeping
 * page loads fast; raise the sz= value if closer inspection is ever needed.
 * This works for any file shared as "Anyone with the link can view".
 */

// ─── CONFIGURATION ───────────────────────────────────────────────────────────

const FDF_ENTRIES_SHEET     = "Entries";

// Drive folder ID is stored in Script Properties so it can be changed each
// cycle without editing code. Set via PPAGLA menu → "Set Drive Folder ID"
// or File → Project Settings → Script Properties → FDF_DRIVE_FOLDER_ID.
function getDriveFolderId_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("FDF_DRIVE_FOLDER_ID");
  if (!id) {
    var response = SpreadsheetApp.getUi()
      .prompt("Drive Folder ID",
              "Enter the Google Drive folder ID for this cycle's images.\n" +
              "(The ID is the last part of the folder's share link URL.)",
              SpreadsheetApp.getUi().ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== SpreadsheetApp.getUi().Button.OK) return null;
    id = response.getResponseText().trim();
    if (id) props.setProperty("FDF_DRIVE_FOLDER_ID", id);
  }
  return id || null;
}

function setDriveFolderId() {
  var ui = SpreadsheetApp.getUi();
  var response = ui.prompt("Set Drive Folder ID",
    "Enter the Google Drive folder ID for this cycle's images.\n" +
    "(The ID is the last part of the folder's share link URL.)",
    ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  var id = response.getResponseText().trim();
  if (id) {
    PropertiesService.getScriptProperties().setProperty("FDF_DRIVE_FOLDER_ID", id);
    ui.alert("Drive folder ID saved: " + id);
  }
}

// ─── COLUMN INDICES (1-based) ─────────────────────────────────────────────────
// entry_id=A(1), category=B(2), essay_id=C(3), essay_title=D(4),
// image_number=E(5), filename=F(6), caption=G(7), photographer=H(8),
// publication=I(9), headline=J(10), copyright=K(11),
// drive_file_id=L(12), image_url=M(13)
const FDF_COL_FILENAME  = 6;   // F
const FDF_COL_DRIVE_ID  = 12;  // L
const FDF_COL_IMAGE_URL = 13;  // M

// ─── MAIN FUNCTION ───────────────────────────────────────────────────────────

function fillDriveFileIds() {
  const folderId = getDriveFolderId_();
  if (!folderId) {
    SpreadsheetApp.getUi().alert("No Drive folder ID set. Use PPAGLA menu → Set Drive Folder ID.");
    return;
  }

  const ss     = SpreadsheetApp.getActiveSpreadsheet();
  const sheet  = ss.getSheetByName(FDF_ENTRIES_SHEET);

  if (!sheet) {
    SpreadsheetApp.getUi().alert(`Sheet "${FDF_ENTRIES_SHEET}" not found.`);
    return;
  }

  const lastRow = sheet.getLastRow();
  Logger.log(`Entries sheet has ${lastRow - 1} data rows.`);

  // ── Step 1: Read all filenames and build row-index map ────────────────────
  // key = lowercase filename, value = array of 1-based row numbers
  Logger.log("Reading filenames from sheet…");
  const filenameCol = sheet.getRange(2, FDF_COL_FILENAME, lastRow - 1, 1).getValues();
  const rowMap = {};   // { "animals_xxx.jpg": [2, 5, 7, …] }

  filenameCol.forEach((row, i) => {
    const fn = (row[0] || "").toString().trim().toLowerCase();
    if (!fn) return;
    if (!rowMap[fn]) rowMap[fn] = [];
    rowMap[fn].push(i + 2); // +2 because row 1 is header
  });

  Logger.log(`Found ${Object.keys(rowMap).length} unique filenames in sheet.`);

  // ── Step 2: Recursively list all files in Drive folder ────────────────────
  Logger.log(`Scanning Drive folder ${folderId}…`);
  const driveFiles = listDriveFilesRecursive(folderId);
  Logger.log(`Found ${driveFiles.length} files in Drive.`);

  // ── Step 3: Match & update ────────────────────────────────────────────────
  let matched = 0;
  let unmatched = [];

  // Batch updates: collect [row, colDriveId, colImageUrl] changes
  // For efficiency write in bulk using setValues on ranges
  // Build a map of row → [driveId, imageUrl]
  const updates = {};  // { rowNumber: { driveId, imageUrl } }

  driveFiles.forEach(({ name, id }) => {
    const nameLower = name.toLowerCase();
    const rows = rowMap[nameLower];
    if (!rows) {
      unmatched.push(name);
      return;
    }
    const imageUrl = `https://drive.google.com/thumbnail?id=${id}&sz=w1600`;
    rows.forEach(r => {
      updates[r] = { driveId: id, imageUrl };
    });
    matched++;
  });

  // Write updates to sheet
  Logger.log(`Writing ${Object.keys(updates).length} row updates…`);
  Object.entries(updates).forEach(([rowStr, { driveId, imageUrl }]) => {
    const row = parseInt(rowStr, 10);
    sheet.getRange(row, FDF_COL_DRIVE_ID).setValue(driveId);
    sheet.getRange(row, FDF_COL_IMAGE_URL).setValue(imageUrl);
  });

  // Flush all writes
  SpreadsheetApp.flush();

  // ── Step 4: Report ────────────────────────────────────────────────────────
  const summary = [
    `✅ Done!`,
    `• Drive files found:  ${driveFiles.length}`,
    `• Filenames matched:  ${matched}`,
    `• Rows updated:       ${Object.keys(updates).length}`,
    `• Drive files with no matching sheet row: ${unmatched.length}`,
    unmatched.length > 0 ? `\nUnmatched (first 20):\n${unmatched.slice(0, 20).join("\n")}` : "",
  ].join("\n");

  Logger.log(summary);
  SpreadsheetApp.getUi().alert(summary);
}

// ─── HELPER: Recursively list files in a Drive folder ───────────────────────

function listDriveFilesRecursive(folderId, depth) {
  depth = depth || 0;
  const results = [];
  const folder = DriveApp.getFolderById(folderId);

  // Files directly in this folder
  const fileIter = folder.getFiles();
  while (fileIter.hasNext()) {
    const f = fileIter.next();
    const mime = f.getMimeType();
    // Only include image files
    if (mime.startsWith("image/") || /\.(jpe?g|png|gif|tiff?|webp)$/i.test(f.getName())) {
      results.push({ name: f.getName(), id: f.getId() });
    }
  }

  // Recurse into subfolders (for essay categories stored in subfolders)
  const folderIter = folder.getFolders();
  while (folderIter.hasNext()) {
    const sub = folderIter.next();
    const subFiles = listDriveFilesRecursive(sub.getId(), depth + 1);
    subFiles.forEach(f => results.push(f));
  }

  return results;
}

// ─── OPTIONAL: Add a menu item ───────────────────────────────────────────────

// NOTE: onOpen() is defined in Code.gs — do not add another one here.
// "Fill Drive File IDs" menu item is included in Code.gs's PPAGLA menu.

