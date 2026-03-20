import { useState, useCallback, useEffect, useRef } from "react";

// ============================================================
// CONFIGURATION — edit these two URLs only
// ============================================================

// Credentials sheet (published CSV). Columns: judgeId, password, role
// role must be "judge" or "admin"
// File → Share → Publish to web → Sheet → CSV → Publish
const CREDENTIALS_SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vSXLD9aghj8OuvHLaIAqf_nKha5gBF8SnwuoRqtn9kkYfyekRRH_Z2-qMUnHijlCIF__56ZcHCxVEZq/pub?output=csv";

// Apps Script URL (receives votes, returns history)
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz41CcyUe-t3xUe6dieFH0jRsaoC0CYrc9FIYhShV_ouIafCO9FGrFJwGUIeAqoYQcc/exec";

// Maps the essay_id PREFIX (before the first "-") to its canonical top-level
// category name. This ensures essay entries are always grouped correctly under
// "Photo Essay", "Picture Story" etc. even if the category column in the
// spreadsheet contains something else (e.g. a caption or the essay title).
// Add or change entries here if new essay types are introduced.
const ESSAY_ID_CATEGORY_MAP = {
  "PHOT": "Photo Essay",
  "PICT": "Picture Story",
  "POY":  "POY",
};

// ============================================================
// CREDENTIALS PARSER
// Expects columns: judgeId, password, role
// Also looks for a row with judgeId="__entries_url__" whose
// password column holds the current entries sheet URL.
// ============================================================
function parseCredentialsCSV(csv) {
  const lines = csv.trim().split("\n");
  const parseLine = (line) => {
    const cols = []; let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { cols.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cols.push(cur);
    return cols.map((c) => c.trim());
  };
  const headers = parseLine(lines[0]);
  const col = (n) => headers.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const iJudge = col("judgeId"); const iPwd = col("password"); const iRole = col("role");
  const iUrl  = col("entriesUrl"); // optional column for the entries sheet URL

  const creds = []; let entriesUrl = "";
  lines.slice(1).forEach((line) => {
    if (!line.trim()) return;
    const c = parseLine(line);
    const judgeId = c[iJudge] || ""; const password = c[iPwd] || "";
    const role = (c[iRole] || "judge").toLowerCase();
    if (iUrl >= 0 && c[iUrl]) entriesUrl = c[iUrl];
    if (judgeId) creds.push({ judgeId, password, role });
  });
  return { creds, entriesUrl };
}

// ============================================================
// ENTRIES CSV PARSER
// Columns (from extract_and_upload.py):
//   entry_id, category, essay_id, essay_title, image_number,
//   filename, caption, photographer, publication, headline,
//   copyright, drive_file_id, image_url
//
// If image_url is empty but drive_file_id is present, a
// Google Drive thumbnail URL is generated automatically.
// ============================================================
function driveThumbUrl(fileId) {
  if (!fileId) return "";
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1200`;
}

function parseEntriesCSV(csv) {
  const lines = csv.trim().split("\n");
  const parseLine = (line) => {
    const cols = []; let cur = "", inQ = false;
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { cols.push(cur); cur = ""; continue; }
      cur += ch;
    }
    cols.push(cur);
    return cols.map((c) => c.trim());
  };
  const headers = parseLine(lines[0]);
  const col = (n) => headers.findIndex((h) => h.toLowerCase() === n.toLowerCase());

  const iCat   = col("category");    const iEId   = col("entry_id");
  const iEssId = col("essay_id");    const iEssT  = col("essay_title");
  const iImgN  = col("image_number"); const iFile  = col("filename");
  const iCap   = col("caption");     const iPhoto  = col("photographer");
  const iPub   = col("publication"); const iHead   = col("headline");
  const iUrl   = col("image_url");   const iDrive  = col("drive_file_id");

  const catRaw = new Map();
  lines.slice(1).forEach((line) => {
    if (!line.trim()) return;
    const c = parseLine(line);
    const essayId = c[iEssId] || "";
    // Derive parent category: if the essay_id has a known prefix (e.g. "PHOT-001"
    // → "Photo Essay"), use that — regardless of what the category column says.
    // This makes essay grouping robust even when the category column is wrong.
    const essayPrefix = essayId ? essayId.split("-")[0].toUpperCase() : "";
    const mappedCat   = ESSAY_ID_CATEGORY_MAP[essayPrefix] || null;
    const catName     = mappedCat || c[iCat];
    if (!catName) return;
    if (!catRaw.has(catName)) catRaw.set(catName, []);
    const rawUrl    = (iUrl   >= 0 ? c[iUrl]   : "") || "";
    const driveId   = (iDrive >= 0 ? c[iDrive] : "") || "";
    const imageUrl  = rawUrl || driveThumbUrl(driveId);
    catRaw.get(catName).push({
      entryId:     c[iEId]  || "",
      essayId,                        // already extracted above
      essayTitle:  c[iEssT] || "",
      imageNumber: parseInt(c[iImgN] || "0", 10) || 0,
      filename:    c[iFile] || "",
      caption:     c[iCap]  || "",
      photographer:c[iPhoto]|| "", // loaded but NOT shown to judges (blind)
      publication: c[iPub]  || "", // loaded but NOT shown to judges (blind)
      headline:    c[iHead] || "",
      imageUrl,
    });
  });

  return Array.from(catRaw.entries()).map(([name, rows]) => {
    const isEssay = rows.some((r) => r.essayId !== "");
    const catId   = name.toLowerCase().replace(/[^a-z0-9]/g, "_");

    if (!isEssay) {
      return {
        id: catId, name, isEssayCategory: false,
        entries: rows.map((r) => ({
          id: r.entryId, filename: r.filename, caption: r.caption,
          headline: r.headline, imageUrl: r.imageUrl,
          // Kept in data for submit payload, not displayed:
          photographer: r.photographer, publication: r.publication,
        })),
      };
    }

    // Group by essay_id
    const essayMap = new Map();
    rows.forEach((r) => {
      const key = r.essayId || r.entryId;
      if (!essayMap.has(key)) {
        essayMap.set(key, {
          id: r.essayId || r.entryId, essayTitle: r.essayTitle,
          photographer: r.photographer, publication: r.publication, photos: [],
        });
      }
      essayMap.get(key).photos.push({
        id: r.entryId, imageNumber: r.imageNumber, filename: r.filename,
        caption: r.caption, headline: r.headline, imageUrl: r.imageUrl,
      });
    });

    const essays = Array.from(essayMap.values()).map((e) => ({
      ...e,
      photos: e.photos.sort((a, b) => a.imageNumber - b.imageNumber),
      get coverUrl()   { return this.photos[0]?.imageUrl || ""; },
      get imageCount() { return this.photos.length; },
    }));

    return { id: catId, name, isEssayCategory: true, entries: essays };
  });
}

// ============================================================
// CONSTANTS
// ============================================================
const HM = 4;
const MAX_HMS = 4;
const PLACE_LABELS  = { 1: "1st Place", 2: "2nd Place", 3: "3rd Place", 4: "HM" };
const PLACE_COLORS  = {
  1: { bg: "#d4a017", text: "#1a1a1a", border: "#b8860b" },
  2: { bg: "#a8a8a8", text: "#1a1a1a", border: "#8a8a8a" },
  3: { bg: "#c87533", text: "#fff",    border: "#a0622a" },
  4: { bg: "#6b5d54", text: "#fff",    border: "#544840" },
};

// ============================================================
// ContestImage — lazy loading with fallback
// Pass src="" (or omit) to immediately show the unavailable state.
// ============================================================
function ContestImage({ src, alt, style, onClick }) {
  const [loaded, setLoaded] = useState(false);
  const [error,  setError]  = useState(!src); // immediately unavailable if no src
  return (
    <div style={{ position: "relative", overflow: "hidden", ...style }} onClick={onClick}>
      {!loaded && !error && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
          justifyContent: "center", background: "#141210", color: "#8a8580", fontSize: 14 }}>
          Loading…
        </div>
      )}
      {error ? (
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", background: "#141210", gap: 6 }}>
          <span style={{ fontSize: 24 }}>🖼</span>
          <span style={{ fontSize: 13, color: "#9a9590" }}>Image unavailable</span>
        </div>
      ) : (
        <img src={src} alt={alt || ""}
          onLoad={() => setLoaded(true)} onError={() => setError(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block",
            opacity: loaded ? 1 : 0, transition: "opacity 0.3s" }} />
      )}
    </div>
  );
}

// ============================================================
// MAIN APP
// ============================================================
export default function JudgingApp() {

  // ── Core state ──────────────────────────────────────────────
  const [phase, setPhase]           = useState("login"); // login|browse|judge|submitted|admin
  const [judgeId, setJudgeId]       = useState("");
  const [judgeToken, setJudgeToken] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [judgeRole, setJudgeRole]   = useState("judge"); // judge | admin
  const [allJudges, setAllJudges]   = useState([]);      // [{judgeId}] for admin panel

  // ── Entries & categories ────────────────────────────────────
  const [entriesUrl, setEntriesUrl]     = useState("");
  const [categories, setCategories]     = useState([]);
  const [dataLoading, setDataLoading]   = useState(false);
  const [dataError, setDataError]       = useState("");

  // ── Judging state ───────────────────────────────────────────
  const [selectedCat, setSelectedCat]     = useState(null);
  const [votes, setVotes]                 = useState({});    // {entryId: 1|2|3|4}
  const [firstPlaceComment, setFPComment] = useState("");
  const [viewingEssay, setViewingEssay]   = useState(null);
  const [lightbox, setLightbox]           = useState(null);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submittedCats, setSubmittedCats] = useState(new Set()); // submitted with ≥1 vote
  const [noAwardCats, setNoAwardCats]     = useState(new Set()); // submitted with 0 votes
  const [judgeHistory, setJudgeHistory]   = useState(null);
  const [viewingEssayFolder, setViewingEssayFolder] = useState(false);

  // ── Admin state ─────────────────────────────────────────────
  const [adminProgress, setAdminProgress] = useState({});   // {judgeId: [catName…]}
  const [adminLoading, setAdminLoading]   = useState(false);

  // Escape key closes lightbox
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ── Data loading ────────────────────────────────────────────
  const loadEntries = useCallback(async (url) => {
    setDataLoading(true); setDataError("");
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("Fetch failed");
      setCategories(parseEntriesCSV(await res.text()));
    } catch (e) {
      setDataError("Failed to load contest entries. Please refresh and try again.");
    }
    setDataLoading(false);
  }, []);

  const loadJudgeHistory = useCallback(async (jid) => {
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.startsWith("YOUR_")) return;
    try {
      const res  = await fetch(`${APPS_SCRIPT_URL}?judgeId=${encodeURIComponent(jid)}`);
      const data = await res.json();
      if (data.status === "success" && data.votes) {
        setJudgeHistory(data.votes);
        const done = new Set(); const noAwd = new Set();
        Object.entries(data.votes).forEach(([catName, voteArr]) => {
          const id = catName.toLowerCase().replace(/[^a-z0-9]/g, "_");
          if (voteArr.length > 0) done.add(id); else noAwd.add(id);
        });
        setSubmittedCats(done); setNoAwardCats(noAwd);
      }
    } catch (e) { console.error("History load failed:", e); }
  }, []);

  // ── Login ───────────────────────────────────────────────────
  const handleLogin = async () => {
    if (!judgeId.trim() || !judgeToken.trim()) {
      setLoginError("Please enter your Judge ID and access code.");
      return;
    }
    setLoginLoading(true); setLoginError("");
    try {
      const res  = await fetch(CREDENTIALS_SHEET_URL);
      if (!res.ok) throw new Error("Could not load credentials.");
      const { creds, entriesUrl: eUrl } = parseCredentialsCSV(await res.text());
      const match = creds.find((c) => c.judgeId === judgeId && c.password === judgeToken);
      if (!match) { setLoginError("Invalid Judge ID or access code."); setLoginLoading(false); return; }

      setJudgeRole(match.role);
      setAllJudges(creds.filter((c) => c.role === "judge").map((c) => c.judgeId));

      if (match.role === "admin") {
        setPhase("admin");
        setLoginLoading(false);
        return;
      }

      // Judge flow
      const url = eUrl || entriesUrl;
      if (!url) { setDataError("No entries sheet URL found. Contact your administrator."); setPhase("browse"); setLoginLoading(false); return; }
      setEntriesUrl(url);
      setPhase("loading");
      await Promise.all([loadEntries(url), loadJudgeHistory(judgeId)]);
      setPhase("browse");
    } catch (e) {
      setLoginError("Could not verify credentials. Check your connection and try again.");
    }
    setLoginLoading(false);
  };

  // ── Admin: load all judges' progress ───────────────────────
  const loadAdminProgress = useCallback(async (judgeIds) => {
    if (!APPS_SCRIPT_URL || APPS_SCRIPT_URL.startsWith("YOUR_")) return;
    setAdminLoading(true);
    try {
      const results = await Promise.all(
        judgeIds.map((jid) =>
          fetch(`${APPS_SCRIPT_URL}?judgeId=${encodeURIComponent(jid)}`)
            .then((r) => r.json())
            .then((d) => ({ jid, cats: d.status === "success" ? Object.keys(d.votes || {}) : [] }))
            .catch(() => ({ jid, cats: [] }))
        )
      );
      const prog = {};
      results.forEach(({ jid, cats }) => { prog[jid] = cats; });
      setAdminProgress(prog);
    } catch (e) { console.error("Admin progress load failed:", e); }
    setAdminLoading(false);
  }, []);

  useEffect(() => {
    if (phase === "admin" && allJudges.length > 0) loadAdminProgress(allJudges);
  }, [phase, allJudges, loadAdminProgress]);

  // ── Voting logic ────────────────────────────────────────────
  const hmCount       = () => Object.values(votes).filter((p) => p === HM).length;
  const getEntryPlace = (id) => votes[id] || null;
  const firstPlaceId  = () => Object.keys(votes).find((k) => votes[k] === 1) || null;

  const isVoteBtnDisabled = (entryId, place) => {
    if (votes[entryId] === place) return false;   // always can click to deselect
    if (place === HM) return hmCount() >= MAX_HMS; // HM: disabled if 4 already assigned
    return false; // 1st/2nd/3rd: clicking reassigns — never globally disabled
  };

  const toggleVote = (entryId, place) => {
    setVotes((prev) => {
      const next = { ...prev };
      if (place === HM) {
        // HM: check global limit
        const currentHMs = Object.values(next).filter((p) => p === HM).length;
        if (next[entryId] === HM) { delete next[entryId]; }           // toggle off
        else if (currentHMs < MAX_HMS) { next[entryId] = HM; }        // toggle on
        // else: silently ignore (button should be disabled)
      } else {
        // Exclusive place: remove from any other entry, then toggle for this one
        Object.keys(next).forEach((k) => { if (next[k] === place) delete next[k]; });
        if (next[entryId] === place) delete next[entryId]; else next[entryId] = place;
      }
      return next;
    });
  };

  // ── Category selection ──────────────────────────────────────
  const handleCategorySelect = (cat) => {
    setSelectedCat(cat); setViewingEssay(null); setLightbox(null); setFPComment("");
    if (judgeHistory?.[cat.name]) {
      const prev = {}; let comment = "";
      judgeHistory[cat.name].forEach((v) => {
        prev[v.entryId] = v.place;
        if (v.place === 1 && v.comment) comment = v.comment;
      });
      setVotes(prev); setFPComment(comment);
    } else { setVotes({}); }
    setPhase("judge");
  };

  // ── Submit ──────────────────────────────────────────────────
  const handleSubmit = async (forceNoAward = false) => {
    setSubmitLoading(true);
    const effectiveVotes = forceNoAward ? {} : votes;
    const allEntries     = selectedCat.entries;

    const payload = {
      judgeId,
      category:  selectedCat.name,
      timestamp: new Date().toISOString(),
      noAward:   Object.keys(effectiveVotes).length === 0,
      votes: Object.entries(effectiveVotes).map(([entryId, place]) => {
        const entry = allEntries.find((e) => e.id === entryId);
        return {
          entryId, place,
          title:        selectedCat.isEssayCategory ? (entry?.essayTitle || entryId) : (entry?.headline || entry?.filename || entryId),
          photographer: entry?.photographer || "",
          publication:  entry?.publication  || "",
          comment:      place === 1 ? firstPlaceComment : "",
        };
      }),
    };

    try {
      if (APPS_SCRIPT_URL && !APPS_SCRIPT_URL.startsWith("YOUR_")) {
        await fetch(APPS_SCRIPT_URL, {
          method: "POST", mode: "no-cors",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else { await new Promise((r) => setTimeout(r, 700)); }

      setJudgeHistory((prev) => ({ ...prev, [selectedCat.name]: payload.votes }));
      const catId = selectedCat.id;
      if (payload.noAward) { setNoAwardCats((p) => new Set([...p, catId])); }
      else                  { setSubmittedCats((p) => new Set([...p, catId])); }
      setPhase("submitted");
    } catch (e) { setDataError("Submission failed. Please try again."); }
    setSubmitLoading(false);
  };

  // ── Derived submit state ────────────────────────────────────
  const fp = firstPlaceId();
  const commentRequired = !!fp && !firstPlaceComment.trim();
  const canSubmit       = !commentRequired && !submitLoading;
  const placesAssigned  = Object.keys(votes).length;
  const assigned        = { 1: null, 2: null, 3: null, hm: 0 };
  Object.values(votes).forEach((p) => { if (p <= 3) assigned[p] = true; if (p === HM) assigned.hm++; });

  // ============================================================
  // STYLES — tuned for readability (older judges, bright contrast)
  // ============================================================
  const S = {
    app:    { minHeight: "100vh", background: "#0f0f0f", color: "#e8e4df", fontFamily: "'Georgia', serif", position: "relative" },
    grain:  { position: "fixed", inset: 0, opacity: 0.035, pointerEvents: "none", zIndex: 100,
               backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")` },
    header: { borderBottom: "1px solid #2a2a2a", padding: "18px 24px", display: "flex", alignItems: "center",
               justifyContent: "space-between", position: "sticky", top: 0, background: "#0f0f0f", zIndex: 50 },
    hLeft:  { display: "flex", alignItems: "center", gap: "12px" },
    logo:   { height: "28px", width: "auto", opacity: 0.9 },
    hTitle: { fontSize: "14px", letterSpacing: "2px", textTransform: "uppercase", color: "#a0a090" },
    hRight: { fontSize: "14px", color: "#a0a090", letterSpacing: "0.5px" },
    hero:   { padding: "56px 24px 40px", maxWidth: 880, margin: "0 auto", textAlign: "center" },
    heroTitle: { fontSize: "clamp(28px,4vw,42px)", fontWeight: 400, letterSpacing: "-0.5px", lineHeight: 1.2, color: "#e8e4df", marginBottom: 10 },
    heroSub:   { fontSize: "17px", color: "#a8a4a0", lineHeight: 1.7, maxWidth: 480, margin: "0 auto" },
    loginBox: { maxWidth: 400, margin: "28px auto 0", background: "#181614", border: "1px solid #2a2a2a", borderRadius: 8, padding: "32px 28px" },
    label:   { display: "block", fontSize: "13px", letterSpacing: "1.5px", textTransform: "uppercase", color: "#a0a090", marginBottom: 7, marginTop: 20 },
    input:   { width: "100%", background: "#0f0f0f", border: "1px solid #2a2a2a", borderRadius: 5, padding: "11px 14px", color: "#e8e4df", fontSize: "16px", fontFamily: "'Georgia', serif", outline: "none", boxSizing: "border-box" },
    textarea:{ width: "100%", background: "#0f0f0f", border: "1px solid #2a2a2a", borderRadius: 5, padding: "11px 14px", color: "#e8e4df", fontSize: "15px", fontFamily: "'Georgia', serif", outline: "none", boxSizing: "border-box", minHeight: "90px", resize: "vertical" },
    loginErr:{ color: "#e06060", fontSize: "14px", marginTop: 12, fontStyle: "italic" },
    btn:     { display: "block", width: "100%", marginTop: 24, padding: "13px", background: "#d4a017", border: "none", borderRadius: 5, color: "#1a1a1a", fontSize: "14px", letterSpacing: "2px", textTransform: "uppercase", fontFamily: "'Georgia', serif", fontWeight: 700, cursor: "pointer" },
    btnMuted:{ display: "block", width: "100%", marginTop: 10, padding: "11px", background: "transparent", border: "1px solid #3a3a3a", borderRadius: 5, color: "#9a9590", fontSize: "13px", letterSpacing: "1.5px", textTransform: "uppercase", fontFamily: "'Georgia', serif", cursor: "pointer" },

    // Category grid
    catGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px,1fr))", gap: 12, maxWidth: 880, margin: "0 auto", padding: "0 24px" },
    catCard: (state) => ({
      background: state === "done" ? "#1a2518" : state === "noaward" ? "#1a1a1a" : "#181614",
      border: `1px solid ${state === "done" ? "#2d4a2d" : state === "noaward" ? "#2a2a2a" : "#2a2a2a"}`,
      borderRadius: 8, padding: "24px 20px", cursor: "pointer", transition: "all 0.2s", position: "relative",
    }),
    catName:     { fontSize: "17px", fontWeight: 400, color: "#e8e4df", marginBottom: 4 },
    catCount:    { fontSize: "14px", color: "#a0a090", letterSpacing: "0.3px" },
    catEssayTag: { display: "inline-block", fontSize: "11px", letterSpacing: "1px", textTransform: "uppercase", color: "#d4a017", border: "1px solid #3a2a00", borderRadius: 3, padding: "2px 6px", marginBottom: 6 },
    catBadgeDone:    { position: "absolute", top: 12, right: 14, fontSize: "13px", color: "#7acc7a", letterSpacing: "0.5px" },
    catBadgeNoAward: { position: "absolute", top: 12, right: 14, fontSize: "13px", color: "#9a9590", letterSpacing: "0.5px" },
    catFolderTag:    { display: "inline-block", fontSize: "11px", letterSpacing: "1px", textTransform: "uppercase", color: "#d4a017", border: "1px solid #3a2a00", borderRadius: 3, padding: "2px 6px", marginBottom: 6 },

    // Navigation
    backNav: { padding: "24px 24px 0", maxWidth: 880, margin: "0 auto" },
    backBtn: { background: "none", border: "none", color: "#a0a090", fontSize: "16px", letterSpacing: "0.5px", cursor: "pointer", fontFamily: "'Georgia', serif", padding: 0, transition: "color 0.2s" },
    judgeWrap: { maxWidth: 880, margin: "0 auto", padding: "18px 24px 200px" },
    catTitle:  { fontSize: "clamp(22px,3.5vw,34px)", fontWeight: 400, color: "#e8e4df", marginBottom: 4 },
    catMeta:   { fontSize: "15px", color: "#a0a090", letterSpacing: "0.3px", marginBottom: 30 },

    // Single-image cards
    card:    (p) => ({ background: "#181614", border: `1px solid ${p ? PLACE_COLORS[p].border : "#2a2a2a"}`, borderRadius: 8, overflow: "hidden", marginBottom: 16, transition: "border-color 0.2s" }),
    imgWrap: { width: "100%", aspectRatio: "3/2", background: "#141210", position: "relative", cursor: "zoom-in", overflow: "hidden" },
    badge:   (p) => ({ position: "absolute", top: 10, left: 10, zIndex: 2, background: PLACE_COLORS[p].bg, color: PLACE_COLORS[p].text, fontSize: "12px", fontWeight: 700, letterSpacing: "1px", padding: "4px 10px", borderRadius: 3 }),
    entryInfo:    { padding: "16px 20px 18px" },
    entryHeadline:{ fontSize: "17px", fontWeight: 400, color: "#e8e4df", marginBottom: 6 },
    entryCaption: { fontSize: "16px", color: "#d0ccc7", lineHeight: 1.65 },
    voteRow:  { display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" },
    voteBtn:  (place, active, disabled) => ({
      flex: "1 1 70px", padding: "10px 6px",
      border: `1px solid ${active ? PLACE_COLORS[place].border : "#3a3a3a"}`,
      borderRadius: 5, background: active ? PLACE_COLORS[place].bg : "transparent",
      color: active ? PLACE_COLORS[place].text : disabled ? "#3a3530" : "#b0ada8",
      fontSize: "13px", letterSpacing: "0.8px", textTransform: "uppercase",
      fontFamily: "'Georgia', serif", fontWeight: active ? 700 : 400,
      cursor: disabled ? "not-allowed" : "pointer",
      opacity: disabled ? 0.4 : 1, transition: "all 0.16s",
    }),

    // Essay folder grid
    essayGrid:   { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px,1fr))", gap: 16 },
    folderCard:  (p) => ({ background: "#181614", border: `1px solid ${p ? PLACE_COLORS[p].border : "#2a2a2a"}`, borderRadius: 8, overflow: "hidden", transition: "border-color 0.2s" }),
    folderThumb: { width: "100%", aspectRatio: "4/3", position: "relative", overflow: "hidden", cursor: "pointer" },
    folderOverlay:{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(0,0,0,0.65) 0%,transparent 55%)", zIndex: 1, display: "flex", alignItems: "flex-end", padding: "12px 14px" },
    folderCount: { fontSize: "13px", color: "#e8e4df", background: "rgba(0,0,0,0.55)", padding: "3px 10px", borderRadius: 10 },
    folderInfo:  { padding: "14px 16px 16px" },
    folderTitle: { fontSize: "16px", fontWeight: 400, color: "#e8e4df", marginBottom: 12, lineHeight: 1.3 },
    viewBtn:     { background: "none", border: "1px solid #3a3a3a", borderRadius: 4, color: "#a0a090", fontSize: "14px", letterSpacing: "0.5px", padding: "7px 13px", cursor: "pointer", fontFamily: "'Georgia', serif", transition: "all 0.18s", display: "block", marginBottom: 12 },

    // Essay detail
    essayDetailTitle: { fontSize: "clamp(20px,2.8vw,28px)", fontWeight: 400, color: "#e8e4df", marginBottom: 6 },
    essayDetailMeta:  { fontSize: "15px", color: "#a0a090", marginBottom: 30 },
    essayPhotoGrid:   { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px,1fr))", gap: 14, marginBottom: 40 },
    essayPhotoCard:   { background: "#181614", border: "1px solid #2a2a2a", borderRadius: 6, overflow: "hidden" },
    essayPhotoImg:    { width: "100%", aspectRatio: "3/2", position: "relative", cursor: "zoom-in", overflow: "hidden" },
    essayPhotoInfo:   { padding: "12px 14px 14px" },
    essayPhotoNum:    { fontSize: "12px", letterSpacing: "1px", textTransform: "uppercase", color: "#a0a090", marginBottom: 5 },
    essayPhotoCap:    { fontSize: "15px", color: "#d0ccc7", lineHeight: 1.55 },

    // Essay detail voting panel
    essayVotePanel: { background: "#1a1816", border: "1px solid #3a3a3a", borderRadius: 8, padding: "20px 22px", marginBottom: 24 },
    essayVoteTitle: { fontSize: "15px", color: "#a0a090", marginBottom: 12, letterSpacing: "0.5px" },

    // Comment box
    commentBox:   { marginTop: 24, padding: "18px", background: "#1a1816", border: "1px solid #2d4a2d", borderRadius: 6 },
    commentLabel: { fontSize: "14px", letterSpacing: "1px", textTransform: "uppercase", color: "#8aca8a", marginBottom: 10, display: "block" },

    // Submit bar
    submitBar:   { position: "fixed", bottom: 0, left: 0, right: 0, background: "rgba(15,15,15,0.97)", backdropFilter: "blur(12px)", borderTop: "1px solid #2a2a2a", padding: "16px 24px", zIndex: 40 },
    submitInner: { maxWidth: 880, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" },
    submitStatus:{ fontSize: "15px", color: "#b0ada8", letterSpacing: "0.3px", lineHeight: 1.7 },
    submitHint:  { fontSize: "13px", color: "#8a8580", letterSpacing: "0.3px" },
    submitWarn:  { fontSize: "13px", color: "#e06060", fontStyle: "italic" },
    submitBtns:  { display: "flex", gap: 12, alignItems: "center", flexShrink: 0 },
    skipBtn:     { padding: "10px 18px", background: "transparent", border: "1px solid #3a3a3a", borderRadius: 5, color: "#9a9590", fontSize: "13px", letterSpacing: "1px", textTransform: "uppercase", fontFamily: "'Georgia', serif", cursor: "pointer", transition: "all 0.18s" },
    submitOn:    { padding: "12px 28px", background: "#d4a017", border: "none", borderRadius: 5, color: "#1a1a1a", fontSize: "14px", letterSpacing: "1.5px", textTransform: "uppercase", fontFamily: "'Georgia', serif", fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
    submitOff:   { padding: "12px 28px", background: "#1e1c18", border: "1px solid #2a2a2a", borderRadius: 5, color: "#5a5550", fontSize: "14px", letterSpacing: "1.5px", textTransform: "uppercase", fontFamily: "'Georgia', serif", fontWeight: 700, cursor: "not-allowed", whiteSpace: "nowrap" },

    // Success
    successIcon:  { fontSize: "44px", display: "block", marginBottom: 18 },
    successTitle: { fontSize: "26px", fontWeight: 400, color: "#e8e4df", marginBottom: 8 },
    successSub:   { fontSize: "17px", color: "#a8a4a0", lineHeight: 1.7, maxWidth: 460, margin: "0 auto" },
    smallBtn:     { display: "inline-block", marginTop: 24, padding: "10px 24px", background: "transparent", border: "1px solid #3a3a3a", borderRadius: 5, color: "#aea8a4", fontSize: "14px", letterSpacing: "1px", textTransform: "uppercase", fontFamily: "'Georgia', serif", cursor: "pointer", transition: "all 0.2s" },
    center:       { textAlign: "center", padding: "80px 24px", color: "#a0a090", fontSize: "17px" },

    // Lightbox
    lbOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.93)", zIndex: 200, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px" },
    lbImg:     { maxWidth: "90vw", maxHeight: "78vh", objectFit: "contain", borderRadius: 3 },
    lbCaption: { marginTop: 16, fontSize: "16px", color: "#d0ccc7", maxWidth: 680, textAlign: "center", lineHeight: 1.6 },
    lbClose:   { position: "absolute", top: 20, right: 26, background: "none", border: "none", color: "#a0a090", fontSize: "28px", cursor: "pointer", lineHeight: 1, zIndex: 1 },

    // Admin panel
    adminGrid:   { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px,1fr))", gap: 10, maxWidth: 880, margin: "0 auto", padding: "0 24px 60px" },
    adminCard:   { background: "#181614", border: "1px solid #2a2a2a", borderRadius: 8, padding: "18px" },
    adminName:   { fontSize: "15px", color: "#e8e4df", marginBottom: 10, letterSpacing: "0.5px" },
    adminCatRow: { fontSize: "13px", color: "#8a8580", lineHeight: 2 },
    adminDone:   { color: "#7acc7a" },
    adminPending:{ color: "#7a7570" },
  };

  // ── Shared Header ───────────────────────────────────────────
  const Header = ({ right }) => (
    <header style={S.header}>
      <div style={S.hLeft}>
        <img src="/1PPAGLA Logo White.png" alt="PPAGLA" style={S.logo} />
        <span style={S.hTitle}>PPAGLA Photo Contest</span>
      </div>
      {right && <span style={S.hRight}>{right}</span>}
    </header>
  );

  // ── Lightbox ────────────────────────────────────────────────
  const Lightbox = () => lightbox ? (
    <div style={S.lbOverlay} onClick={() => setLightbox(null)}>
      <button style={S.lbClose} onClick={() => setLightbox(null)}>✕</button>
      <img src={lightbox.imageUrl} alt={lightbox.caption || ""} style={S.lbImg}
        onClick={(e) => e.stopPropagation()} />
      {lightbox.caption && <p style={S.lbCaption}>{lightbox.caption}</p>}
    </div>
  ) : null;

  // ── Vote row (reused by single-image and essay cards) ───────
  const VoteRow = ({ entryId }) => (
    <div style={S.voteRow}>
      {[1, 2, 3, HM].map((place) => {
        const active    = getEntryPlace(entryId) === place;
        const disabled  = !active && isVoteBtnDisabled(entryId, place);
        const label     = place === HM
          ? (active ? "HM ✓" : `HM${!active && hmCount() > 0 ? ` (${hmCount()}/${MAX_HMS})` : ""}`)
          : PLACE_LABELS[place];
        return (
          <button key={place} style={S.voteBtn(place, active, disabled)}
            disabled={disabled} onClick={() => toggleVote(entryId, place)}>
            {label}
          </button>
        );
      })}
    </div>
  );

  // ── Submit bar (reused in judge views) ──────────────────────
  const SubmitBar = () => {
    const statusParts = [
      assigned[1] ? "1st ✓" : "1st —",
      assigned[2] ? "2nd ✓" : "2nd —",
      assigned[3] ? "3rd ✓" : "3rd —",
      `HM: ${assigned.hm}/${MAX_HMS}`,
    ];
    return (
      <div style={S.submitBar}>
        <div style={S.submitInner}>
          <div>
            <div style={S.submitStatus}>{statusParts.join("  ·  ")}</div>
            <div style={S.submitHint}>All placements optional · up to {MAX_HMS} HMs</div>
            {commentRequired && <div style={S.submitWarn}>Add a comment for your 1st place pick ↑</div>}
          </div>
          <div style={S.submitBtns}>
            <button style={S.skipBtn}
              onMouseEnter={(e) => { e.target.style.borderColor="#7a7570"; e.target.style.color="#c0bdb8"; }}
              onMouseLeave={(e) => { e.target.style.borderColor="#3a3a3a"; e.target.style.color="#9a9590"; }}
              onClick={() => { if (window.confirm("Submit with no awards for this category?")) handleSubmit(true); }}
            >
              No Award
            </button>
            <button style={canSubmit ? S.submitOn : S.submitOff}
              disabled={!canSubmit} onClick={() => handleSubmit(false)}>
              {submitLoading ? "Submitting…" : placesAssigned === 0 ? "Submit — No Award" : "Submit Votes"}
            </button>
          </div>
        </div>
      </div>
    );
  };

  // ============================================================
  // PHASE: LOGIN
  // ============================================================
  if (phase === "login") return (
    <div style={S.app}><div style={S.grain} />
      <Header />
      <div style={S.hero}>
        <h1 style={S.heroTitle}>Judge Portal</h1>
        <p style={S.heroSub}>Enter your credentials to begin reviewing and scoring entries.</p>
        <div style={S.loginBox}>
          <label style={{ ...S.label, marginTop: 0 }}>Judge ID</label>
          <input style={S.input} value={judgeId}
            onChange={(e) => setJudgeId(e.target.value)} placeholder="e.g. judge1"
            onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
          <label style={S.label}>Access Code</label>
          <input style={S.input} type="password" value={judgeToken}
            onChange={(e) => setJudgeToken(e.target.value)} placeholder="••••••••"
            onKeyDown={(e) => e.key === "Enter" && handleLogin()} />
          {loginError && <p style={S.loginErr}>{loginError}</p>}
          <button style={S.btn} onClick={handleLogin} disabled={loginLoading}>
            {loginLoading ? "Verifying…" : "Enter"}
          </button>
        </div>
      </div>
    </div>
  );

  // ============================================================
  // PHASE: LOADING
  // ============================================================
  if (phase === "loading") return (
    <div style={S.app}><div style={S.grain} />
      <Header right={`Judging as: ${judgeId}`} />
      <div style={S.center}>Loading contest entries…</div>
    </div>
  );

  // ============================================================
  // PHASE: ADMIN PANEL
  // ============================================================
  if (phase === "admin") {
    // Gather all category names from progress data
    const allCatNames = Array.from(
      new Set(Object.values(adminProgress).flat())
    ).sort();

    return (
      <div style={S.app}><div style={S.grain} />
        <Header right={`Admin: ${judgeId}`} />
        <div style={S.hero}>
          <h1 style={S.heroTitle}>Admin Dashboard</h1>
          <p style={S.heroSub}>Judging progress across all judges. Results are recorded in your Google Sheet.</p>
        </div>
        {adminLoading ? (
          <div style={S.center}>Loading progress…</div>
        ) : (
          <div style={S.adminGrid}>
            {allJudges.map((jid) => {
              const done = adminProgress[jid] || [];
              return (
                <div key={jid} style={S.adminCard}>
                  <div style={S.adminName}>{jid}</div>
                  {allCatNames.length === 0
                    ? <div style={S.adminCatRow}>No submissions yet</div>
                    : allCatNames.map((cat) => (
                        <div key={cat} style={{ ...S.adminCatRow, ...(done.includes(cat) ? S.adminDone : S.adminPending) }}>
                          {done.includes(cat) ? "✓" : "—"} {cat}
                        </div>
                      ))}
                </div>
              );
            })}
          </div>
        )}
        <div style={{ textAlign: "center", padding: "0 24px 60px" }}>
          <button style={{ ...S.smallBtn, marginTop: 8 }}
            onClick={() => loadAdminProgress(allJudges)}>
            ↺ Refresh
          </button>
        </div>
      </div>
    );
  }

  // ============================================================
  // PHASE: BROWSE
  // ============================================================
  if (phase === "browse") {
    if (dataLoading) return (
      <div style={S.app}><div style={S.grain} />
        <Header right={`Judging as: ${judgeId}`} />
        <div style={S.center}>Loading categories…</div>
      </div>
    );
    if (dataError) return (
      <div style={S.app}><div style={S.grain} />
        <Header right={`Judging as: ${judgeId}`} />
        <div style={{ ...S.center, color: "#e06060" }}>{dataError}</div>
      </div>
    );
    return (
      <div style={S.app}><div style={S.grain} />
        <Header right={`Judging as: ${judgeId}`} />
        <div style={S.hero}>
          <h1 style={S.heroTitle}>Select a Category</h1>
          <p style={S.heroSub}>All placements are optional. Award only what the work deserves.</p>
        </div>
        {(() => {
          const essayCats   = categories.filter((c) => c.isEssayCategory);
          const regularCats = categories.filter((c) => !c.isEssayCategory);

          const renderCatCard = (cat) => {
            const isDone    = submittedCats.has(cat.id);
            const isNoAward = noAwardCats.has(cat.id);
            const cardState = isDone ? "done" : isNoAward ? "noaward" : "default";
            return (
              <div key={cat.id} style={S.catCard(cardState)}
                onClick={() => handleCategorySelect(cat)}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = isDone ? "#4a7a4a" : "#d4a017"; e.currentTarget.style.transform = "translateY(-2px)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = isDone ? "#2d4a2d" : "#2a2a2a"; e.currentTarget.style.transform = "translateY(0)"; }}
              >
                {isDone    && <span style={S.catBadgeDone}>✓ Done</span>}
                {isNoAward && <span style={S.catBadgeNoAward}>— No Award</span>}
                <div style={S.catName}>{cat.name}</div>
                <div style={S.catCount}>
                  {cat.isEssayCategory
                    ? `${cat.entries.length} ${cat.entries.length === 1 ? "submission" : "submissions"}`
                    : `${cat.entries.length} ${cat.entries.length === 1 ? "photo" : "photos"}`}
                </div>
              </div>
            );
          };

          if (viewingEssayFolder) {
            const essayDoneCount = essayCats.filter((c) => submittedCats.has(c.id) || noAwardCats.has(c.id)).length;
            return (
              <>
                <div style={S.backNav}>
                  <button style={S.backBtn}
                    onMouseEnter={(e) => (e.target.style.color = "#d4a017")}
                    onMouseLeave={(e) => (e.target.style.color = "#a0a090")}
                    onClick={() => setViewingEssayFolder(false)}>
                    ← All Categories
                  </button>
                </div>
                <div style={{ ...S.hero, paddingTop: 16 }}>
                  <h1 style={S.heroTitle}>Photo Essay</h1>
                  <p style={S.heroSub}>{essayCats.length} categories · {essayDoneCount} of {essayCats.length} judged</p>
                </div>
                <div style={S.catGrid}>
                  {essayCats.map(renderCatCard)}
                </div>
              </>
            );
          }

          const essayDoneCount  = essayCats.filter((c) => submittedCats.has(c.id) || noAwardCats.has(c.id)).length;
          const essayAllDone    = essayCats.length > 0 && essayDoneCount === essayCats.length;
          const folderCardState = essayAllDone ? "done" : "default";
          const totalEssaySubmissions = essayCats.reduce((sum, c) => sum + c.entries.length, 0);

          return (
            <div style={S.catGrid}>
              {regularCats.map(renderCatCard)}
              {essayCats.length > 0 && (
                <div style={S.catCard(folderCardState)}
                  onClick={() => setViewingEssayFolder(true)}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = essayAllDone ? "#4a7a4a" : "#d4a017"; e.currentTarget.style.transform = "translateY(-2px)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = essayAllDone ? "#2d4a2d" : "#2a2a2a"; e.currentTarget.style.transform = "translateY(0)"; }}
                >
                  {essayAllDone && <span style={S.catBadgeDone}>✓ Done</span>}
                  <div style={S.catFolderTag}>Folder</div>
                  <div style={S.catName}>Photo Essay</div>
                  <div style={S.catCount}>
                    {essayCats.length} categories · {totalEssaySubmissions} submissions
                    {essayDoneCount > 0 && !essayAllDone && ` · ${essayDoneCount} judged`}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>
    );
  }

  // ============================================================
  // PHASE: JUDGE
  // ============================================================
  if (phase === "judge" && selectedCat) {

    // ── Essay: detail view (photos + vote for THIS essay) ──────
    if (selectedCat.isEssayCategory && viewingEssay) {
      const essayPlace = getEntryPlace(viewingEssay.id);
      return (
        <div style={S.app}><div style={S.grain} />
          <Header right={`Judging as: ${judgeId}`} />
          <Lightbox />
          <div style={S.backNav}>
            <button style={S.backBtn}
              onMouseEnter={(e) => (e.target.style.color = "#d4a017")}
              onMouseLeave={(e) => (e.target.style.color = "#a0a090")}
              onClick={() => { setViewingEssay(null); setLightbox(null); }}>
              ← {selectedCat.name}
            </button>
          </div>
          <div style={S.judgeWrap}>
            <div style={S.essayDetailTitle}>{viewingEssay.essayTitle}</div>
            <div style={S.essayDetailMeta}>{viewingEssay.imageCount} images · Click any image to enlarge</div>

            <div style={S.essayPhotoGrid}>
              {viewingEssay.photos.map((photo) => (
                <div key={photo.id} style={S.essayPhotoCard}>
                  <div style={S.essayPhotoImg}>
                    <ContestImage src={photo.imageUrl} alt={photo.caption}
                      style={{ width: "100%", height: "100%" }}
                      onClick={() => setLightbox({ imageUrl: photo.imageUrl, caption: photo.caption })} />
                  </div>
                  <div style={S.essayPhotoInfo}>
                    <div style={S.essayPhotoNum}>Photo {photo.imageNumber}</div>
                    {photo.headline && <div style={{ ...S.essayPhotoCap, color: "#e8e4df", marginBottom: 5 }}>{photo.headline}</div>}
                    {photo.caption  && <div style={S.essayPhotoCap}>{photo.caption}</div>}
                  </div>
                </div>
              ))}
            </div>

            {/* Vote for this essay from within the detail view */}
            <div style={S.essayVotePanel}>
              <div style={S.essayVoteTitle}>Your vote for "{viewingEssay.essayTitle}"</div>
              <VoteRow entryId={viewingEssay.id} />
              {essayPlace && (
                <div style={{ marginTop: 10, fontSize: 14, color: PLACE_COLORS[essayPlace].bg }}>
                  Currently assigned: {PLACE_LABELS[essayPlace]}
                </div>
              )}
            </div>

            {fp === viewingEssay.id && (
              <div style={S.commentBox}>
                <label style={S.commentLabel}>
                  Why does "{viewingEssay.essayTitle}" deserve 1st Place? *
                </label>
                <textarea style={S.textarea} value={firstPlaceComment}
                  onChange={(e) => setFPComment(e.target.value)}
                  placeholder="Share your reasoning for this 1st place selection…" />
              </div>
            )}
          </div>
          <SubmitBar />
        </div>
      );
    }

    // ── Essay: submission list ──────────────────────────────────
    if (selectedCat.isEssayCategory) return (
      <div style={S.app}><div style={S.grain} />
        <Header right={`Judging as: ${judgeId}`} />
        <Lightbox />
        <div style={S.backNav}>
          <button style={S.backBtn}
            onMouseEnter={(e) => (e.target.style.color = "#d4a017")}
            onMouseLeave={(e) => (e.target.style.color = "#a0a090")}
            onClick={() => { setPhase("browse"); setSelectedCat(null); setViewingEssayFolder(true); }}>
            ← Photo Essay
          </button>
        </div>
        <div style={S.judgeWrap}>
          <h1 style={S.catTitle}>{selectedCat.name}</h1>
          <div style={S.catMeta}>
            {selectedCat.entries.length} {selectedCat.entries.length === 1 ? "submission" : "submissions"} · Click a submission to view all its photos and vote
          </div>
          <div style={S.essayGrid}>
            {selectedCat.entries.map((essay) => {
              const myPlace = getEntryPlace(essay.id);
              return (
                <div key={essay.id} style={S.folderCard(myPlace)}>
                  <div style={S.folderThumb} onClick={() => setViewingEssay(essay)}>
                    <ContestImage src={essay.coverUrl} alt={essay.essayTitle}
                      style={{ width: "100%", height: "100%" }} />
                    <div style={S.folderOverlay}>
                      <span style={S.folderCount}>{essay.imageCount} photos</span>
                    </div>
                    {myPlace && <span style={S.badge(myPlace)}>{PLACE_LABELS[myPlace].toUpperCase()}</span>}
                  </div>
                  <div style={S.folderInfo}>
                    <div style={S.folderTitle}>{essay.essayTitle}</div>
                    <button style={S.viewBtn}
                      onMouseEnter={(e) => { e.target.style.borderColor="#d4a017"; e.target.style.color="#d4a017"; }}
                      onMouseLeave={(e) => { e.target.style.borderColor="#3a3a3a"; e.target.style.color="#a0a090"; }}
                      onClick={() => setViewingEssay(essay)}>
                      View {essay.imageCount} photos →
                    </button>
                    <VoteRow entryId={essay.id} />
                  </div>
                </div>
              );
            })}
          </div>
          {fp && selectedCat.entries.find((e) => e.id === fp) && (
            <div style={S.commentBox}>
              <label style={S.commentLabel}>
                Why does "{selectedCat.entries.find((e) => e.id === fp)?.essayTitle}" deserve 1st Place? *
              </label>
              <textarea style={S.textarea} value={firstPlaceComment}
                onChange={(e) => setFPComment(e.target.value)}
                placeholder="Share your reasoning for this 1st place selection…" />
            </div>
          )}
        </div>
        <SubmitBar />
      </div>
    );

    // ── Single-image judging ────────────────────────────────────
    return (
      <div style={S.app}><div style={S.grain} />
        <Header right={`Judging as: ${judgeId}`} />
        <Lightbox />
        <div style={S.backNav}>
          <button style={S.backBtn}
            onMouseEnter={(e) => (e.target.style.color = "#d4a017")}
            onMouseLeave={(e) => (e.target.style.color = "#a0a090")}
            onClick={() => { setPhase("browse"); setSelectedCat(null); }}>
            ← Categories
          </button>
        </div>
        <div style={S.judgeWrap}>
          <h1 style={S.catTitle}>{selectedCat.name}</h1>
          <div style={S.catMeta}>
            {selectedCat.entries.length} {selectedCat.entries.length === 1 ? "entry" : "entries"} · Click any image to enlarge · All placements optional · Up to {MAX_HMS} HMs
          </div>
          {selectedCat.entries.map((entry) => {
            const myPlace = getEntryPlace(entry.id);
            return (
              <div key={entry.id} style={S.card(myPlace)}>
                <div style={S.imgWrap}
                  onClick={() => setLightbox({ imageUrl: entry.imageUrl, caption: entry.caption })}>
                  <ContestImage src={entry.imageUrl} alt={entry.caption || entry.filename}
                    style={{ width: "100%", height: "100%" }} />
                  {myPlace && <span style={S.badge(myPlace)}>{PLACE_LABELS[myPlace].toUpperCase()}</span>}
                  <span style={{ position: "absolute", bottom: 10, right: 12, zIndex: 1, fontSize: "13px", color: "#ddd", background: "rgba(0,0,0,0.6)", padding: "3px 9px", borderRadius: 3, pointerEvents: "none" }}>
                    Click to enlarge
                  </span>
                </div>
                <div style={S.entryInfo}>
                  {entry.headline && <div style={S.entryHeadline}>{entry.headline}</div>}
                  {entry.caption  && <div style={S.entryCaption}>{entry.caption}</div>}
                  <VoteRow entryId={entry.id} />
                </div>
              </div>
            );
          })}
          {fp && selectedCat.entries.find((e) => e.id === fp) && (
            <div style={S.commentBox}>
              <label style={S.commentLabel}>Why does this image deserve 1st Place? *</label>
              <textarea style={S.textarea} value={firstPlaceComment}
                onChange={(e) => setFPComment(e.target.value)}
                placeholder="Share your reasoning for this 1st place selection…" />
            </div>
          )}
        </div>
        <SubmitBar />
      </div>
    );
  }

  // ============================================================
  // PHASE: SUBMITTED
  // ============================================================
  if (phase === "submitted") {
    const wasNoAward = noAwardCats.has(selectedCat?.id);
    const remaining  = categories.length - submittedCats.size - noAwardCats.size;
    return (
      <div style={S.app}><div style={S.grain} />
        <Header right={`Judging as: ${judgeId}`} />
        <div style={{ ...S.hero, paddingTop: 90, textAlign: "center" }}>
          <span style={S.successIcon}>{wasNoAward ? "—" : "✓"}</span>
          <h1 style={S.successTitle}>{wasNoAward ? "No Award Recorded" : "Votes Submitted"}</h1>
          <p style={S.successSub}>
            {wasNoAward
              ? <>Your decision to give no award in <strong style={{ color: "#e8e4df" }}>{selectedCat?.name}</strong> has been recorded.</>
              : <>Your rankings for <strong style={{ color: "#e8e4df" }}>{selectedCat?.name}</strong> have been recorded.</>}
            {" "}
            {remaining > 0
              ? `${remaining} ${remaining === 1 ? "category" : "categories"} remaining.`
              : "You have reviewed all categories. Thank you!"}
          </p>
          <button style={S.smallBtn}
            onMouseEnter={(e) => { e.target.style.borderColor="#d4a017"; e.target.style.color="#d4a017"; }}
            onMouseLeave={(e) => { e.target.style.borderColor="#3a3a3a"; e.target.style.color="#aea8a4"; }}
            onClick={() => { setPhase("browse"); setSelectedCat(null); setVotes({}); setFPComment(""); }}>
            ← Back to Categories
          </button>
        </div>
      </div>
    );
  }

  return null;
}
