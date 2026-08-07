import ExcelJS from "exceljs";
import { dictionaryRoles, wilson } from "./metrics";
import type {
  DictionaryEntry,
  MentionRow,
  Project,
  Prompt,
  ResponseRow,
  Run,
  RunMetrics,
} from "../types";
import type { buildCanonicalizer } from "./metrics";
import type { InsightsBundle } from "./insights";

/**
 * Live-formula Excel workbooks — the trust feature: every aggregate is a
 * COUNTIFS/AVERAGEIFS over the embedded Data and Mention Data sheets, so any
 * be clicked and traced to the coded answers behind it. The scorecard
 * carries a focus dropdown (any brand or parent company) that re-computes
 * the whole workbook for the selected focus. Confidence intervals are the
 * one script-computed exception (marked [script]) — Wilson is unreadable as
 * a native formula — precomputed for every focus × engine and looked up.
 */

type Canonicalizer = ReturnType<typeof buildCanonicalizer>;

const SLATE = "FF5B7E92"; // Resondex slate-blue
const HIGHLIGHT = "FFF9C74F"; // headline-number yellow, Kadro convention
const WIN_FILL = "FF70AD47";
const CONTESTED_FILL = "FFFFC000";
const ABSENT_FILL = "FFE06666";
const PARENT_PREFIX = "[Parent] ";

const BRAND_FILL: ExcelJS.FillPattern = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: SLATE },
};
const YELLOW_FILL: ExcelJS.FillPattern = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: HIGHLIGHT },
};

function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function styleHeader(ws: ExcelJS.Worksheet, row = 1) {
  const r = ws.getRow(row);
  r.font = { bold: true, color: { argb: "FFFFFFFF" } };
  r.fill = BRAND_FILL;
  ws.views = [{ state: "frozen", ySplit: row }];
}

/** ReadMe with the operational ceremony: labeled sections, data lock,
 * period, the [script] register, and the highlight convention. */
function addReadme(
  wb: ExcelJS.Workbook,
  title: string,
  sections: [string, string][]
): void {
  const ws = wb.addWorksheet("ReadMe");
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 110;
  const t = ws.addRow([title]);
  t.font = { bold: true, size: 14 };
  ws.addRow([]);
  for (const [label, text] of sections) {
    const r = ws.addRow([label, text]);
    r.getCell(1).font = { bold: true };
    r.getCell(1).alignment = { vertical: "top" };
    r.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
}

function ceremonySections(
  x: WorkbookInputs,
  answers: string,
  scriptComputed: string,
  sheetGuide: [string, string][] = []
): [string, string][] {
  const started = (x.run.started_at ?? x.run.created_at).slice(0, 10);
  const completed = (x.run.completed_at ?? x.run.created_at).slice(0, 10);
  return [
    ["What this answers", answers],
    ...(sheetGuide.length > 0
      ? ([["— Sheet guide —", "What each tab in this file is for."]] as [
          string,
          string,
        ][])
      : []),
    ...sheetGuide,
    ...(sheetGuide.length > 0
      ? ([["— Study conventions —", ""]] as [string, string][])
      : []),
    [
      "Why it matters",
      "Presence gets the brand considered; the first pick decides the purchase. Both are measured with repeats, so every rate carries a real interval.",
    ],
    [
      "Scope",
      `${x.metrics.totalResponses} coded answers = ${x.prompts.filter((p) => p.retired === 0).length} prompts × ${x.run.repeats} repeats on ${x.run.model}. Focus brand: ${x.project.brand}. Category: ${x.project.category}.`,
    ],
    ["Period", `Responses captured ${started} to ${completed}.`],
    [
      "Method",
      "API collection in fresh, stateless sessions (no personalization). AI-coded, dictionary-normalized; rejected names excluded from analysis, raw data preserved.",
    ],
    [
      "Source",
      `Run ${x.run.id.slice(0, 8)} (data lock ${x.run.completed_at ?? x.run.created_at}), dictionary v${x.metrics.dictionaryVersion}. The Data and Mention Data sheets are embedded copies so every formula resolves inside this file.`,
    ],
    [
      "Live formulas",
      "Every aggregate is a live COUNTIFS/AVERAGEIFS over the embedded sheets. Click any number to trace it.",
    ],
    ["Script-computed", `Marked [script]: ${scriptComputed}`],
    [
      "Focus dropdown",
      `The Scorecard's Focus cell is a dropdown of every analyzable brand and parent company (parents prefixed "${PARENT_PREFIX.trim()}"). Changing it re-computes the scorecard and prompt grid for that focus — same data, any lens.`,
    ],
    [
      "Yellow highlight",
      "F9C74F = headline number worth reading.",
    ],
  ];
}

export interface WorkbookInputs {
  project: Project;
  run: Run;
  metrics: RunMetrics;
  prompts: Prompt[];
  responses: ResponseRow[];
  mentionsByResponse: Map<string, MentionRow[]>;
  canon: Canonicalizer;
  dictionary: DictionaryEntry[];
  insights: InsightsBundle | null;
  promptCode: (promptId: string) => string;
}

export function parentMap(x: WorkbookInputs): Map<string, string> {
  return new Map(
    x.dictionary
      .filter((e) => e.status === "active")
      .map((e) => [
        e.canonical.trim().toLowerCase(),
        e.parent ?? e.display_name ?? e.canonical,
      ])
  );
}

export interface AnswerMention {
  norm: string;
  display: string;
  rank: number;
  framing: string;
  /** Every fossilized string that resolved to this brand in this answer —
   * the dictionary made auditable inside the workbook. */
  raws: string[];
  /** How many times the brand was named. Repetition is emphasis. */
  times: number;
}

/** Per-answer canonicalized mention summary, shared by every sheet builder.
 * One entry per (answer, brand): repeat mentions collapse into times/raws
 * and the brand keeps its earliest position. */
export function answerMentions(x: WorkbookInputs, r: ResponseRow): AnswerMention[] {
  const perBrand = new Map<string, AnswerMention>();
  for (const m of x.mentionsByResponse.get(r.id) ?? []) {
    if (x.canon.isRejected(m.brand)) continue;
    const norm = x.canon.norm(m.brand);
    const prev = perBrand.get(norm);
    if (!prev) {
      perBrand.set(norm, {
        norm,
        display: x.canon.canonical(m.brand),
        rank: m.rank,
        framing: m.framing,
        raws: [m.brand],
        times: 1,
      });
      continue;
    }
    prev.times += 1;
    if (!prev.raws.includes(m.brand)) prev.raws.push(m.brand);
    if (m.rank < prev.rank) prev.rank = m.rank;
    // Any negative framing of a brand in the answer colors the whole row.
    if (m.framing === "negative") prev.framing = "negative";
  }
  return [...perBrand.values()].sort((a, b) => a.rank - b.rank);
}

const DATA_FIXED = [
  "key",
  "model",
  "response_id",
  "prompt_code",
  "theme",
  "prompt_text",
  "repeat",
  "is_branded",
  "target_named",
  "target_first_named",
  "target_position",
  "target_negative",
  "first_brand",
  "n_brands",
  "top_pick",
  "top_pick_parent",
  "target_first_pick",
  "outcome",
  "word_count",
  "clarification_requested",
  "gives_recommendation",
  "includes_prices",
  "includes_specs",
  "total_recommendations",
];

/** Column geometry for the Data sheet, computable before the sheet exists —
 * so the presentation sheets can be written first and the evidence sheets
 * land at the end of the tab order. */
function dataLayout(x: WorkbookInputs) {
  const codes = x.project.reason_taxonomy;
  const cols: Record<string, string> = {};
  DATA_FIXED.forEach((name, i) => (cols[name] = colLetter(i + 1)));
  const codeCols = new Map<string, string>();
  codes.forEach((c, i) => codeCols.set(c, colLetter(DATA_FIXED.length + i + 1)));
  return {
    headers: [...DATA_FIXED, ...codes.map((c) => `arg: ${c}`)],
    cols,
    codeCols,
    codes,
  };
}

/** The shared Data sheet: one row per coded answer. `key` = prompt|repeat
 * powers the prompt grid's INDEX/MATCH pick cells. */
function addDataSheet(
  wb: ExcelJS.Workbook,
  x: WorkbookInputs,
  layout: ReturnType<typeof dataLayout>
): void {
  const { project, prompts, responses, canon } = x;
  const targetNorm = canon.norm(project.brand);
  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const parents = parentMap(x);
  const { headers, codes } = layout;

  const ws = wb.addWorksheet("Data");
  ws.addRow(headers);
  styleHeader(ws);
  ws.getColumn(6).width = 50;
  // Self-describing: a note past the last column, out of every formula range.
  const dataNote = ws.getCell(1, headers.length + 2);
  dataNote.value =
    "EVIDENCE SHEET — one row per sampled ANSWER (see 'Mention Data' for one row per brand named inside an answer). Every rate in this workbook is a COUNTIFS over these rows. response_id traces to the Quotes sheet and to 05_response_library in the study bundle. 'arg:' columns are 1 when the answer used that argument. Do not edit: the formulas count these cells.";
  dataNote.font = { italic: true, size: 10, color: { argb: "FF6B7280" } };

  for (const r of responses) {
    const p = promptById.get(r.prompt_id)!;
    const ordered = answerMentions(x, r);
    const tgt = ordered.find((m) => m.norm === targetNorm);
    const tgtPos = ordered.findIndex((m) => m.norm === targetNorm);
    const topPickNorm = r.top_pick_brand ? canon.norm(r.top_pick_brand) : null;
    const topPickDisplay = topPickNorm
      ? canon.canonical(r.top_pick_brand!)
      : null;
    const usedCodes = new Set(
      (r.reason_codes ?? "").split("|").map((c) => c.trim()).filter(Boolean)
    );
    ws.addRow([
      `${x.promptCode(r.prompt_id)}|${r.repeat_idx + 1}`,
      x.run.model,
      r.id,
      x.promptCode(r.prompt_id),
      p.theme,
      p.text,
      r.repeat_idx + 1,
      p.theme === "branded" ? 1 : 0,
      tgt ? 1 : 0,
      tgtPos === 0 ? 1 : 0,
      tgtPos >= 0 ? tgtPos + 1 : null,
      tgt?.framing === "negative" ? 1 : 0,
      ordered[0]?.display ?? null,
      ordered.length,
      topPickDisplay,
      topPickNorm ? (parents.get(topPickNorm) ?? topPickDisplay) : null,
      topPickNorm === targetNorm ? 1 : 0,
      r.outcome ?? "",
      r.text.split(/\s+/).length,
      r.clarification_requested ?? "",
      r.gives_recommendation ?? "",
      r.includes_prices ?? "",
      r.includes_specs ?? "",
      r.total_recommendations,
      ...codes.map((c) => (usedCodes.has(c) ? 1 : 0)),
    ]);
  }
}

const MENTION_HEADERS = [
  "response_id",
  "model",
  "prompt_code",
  "theme",
  "repeat",
  "is_branded",
  "raw_name",
  "brand",
  "parent",
  "brand_type",
  "position",
  "framing",
  "times_mentioned",
  "is_top_pick",
  "n_brands_in_answer",
  "outcome",
  "first_of_parent_in_answer",
];

/** Column geometry for Mention Data, computable before the sheet exists. */
function mentionLayout(): Record<string, string> {
  const cols: Record<string, string> = {};
  MENTION_HEADERS.forEach((h, i) => (cols[h] = colLetter(i + 1)));
  return cols;
}

/**
 * Mention Data (long format): one row per (answer, brand). Repeat mentions
 * of a brand inside one answer collapse into times_mentioned/raw_name and
 * keep the earliest position, so a plain COUNTIFS on brand already counts
 * DISTINCT ANSWERS — no dedup flag needed. The parent flag stays, because
 * two sibling brands can share one answer.
 */
function addMentionDataSheet(wb: ExcelJS.Workbook, x: WorkbookInputs): void {
  const { project, prompts, responses, canon } = x;
  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const parents = parentMap(x);
  const roleOf = dictionaryRoles(x.dictionary, project, canon);
  const ws = wb.addWorksheet("Mention Data");
  ws.addRow(MENTION_HEADERS);
  styleHeader(ws);
  ws.getColumn(7).width = 24;
  ws.getColumn(8).width = 24;
  ws.getColumn(9).width = 20;
  const note = ws.getCell(1, MENTION_HEADERS.length + 2);
  note.value =
    "EVIDENCE SHEET — one row per BRAND NAMED inside an answer. Data has one row per ANSWER and describes what that answer did about the study's focus brand; this sheet describes EVERY brand, which is what lets the Focus dropdown re-compute the whole workbook for any brand or parent company. One row = one brand in one answer, so COUNTIFS on brand counts distinct answers directly. raw_name is the fossilized extracted string(s) that resolved to this brand — the dictionary, auditable in place.";
  note.font = { italic: true, size: 10, color: { argb: "FF6B7280" } };

  for (const r of responses) {
    const p = promptById.get(r.prompt_id)!;
    const mentions = answerMentions(x, r);
    const topPickNorm = r.top_pick_brand ? canon.norm(r.top_pick_brand) : null;
    const seenParent = new Set<string>();
    for (const m of mentions) {
      const parent = parents.get(m.norm) ?? m.display;
      const firstParent = !seenParent.has(parent);
      seenParent.add(parent);
      ws.addRow([
        r.id,
        x.run.model,
        x.promptCode(r.prompt_id),
        p.theme,
        r.repeat_idx + 1,
        p.theme === "branded" ? 1 : 0,
        m.raws.join(" | "),
        m.display,
        parent,
        roleOf(m.norm),
        m.rank,
        m.framing,
        m.times,
        m.norm === topPickNorm ? 1 : 0,
        mentions.length,
        r.outcome ?? "",
        firstParent ? 1 : 0,
      ]);
    }
  }
}

interface FocusStats {
  named: number;
  picks: number;
  n: number;
}

/** Script-side mirror of the scorecard formulas, per focus × engine —
 * powers the precomputed CI lookup so intervals survive the dropdown. */
function computeFocusStats(
  x: WorkbookInputs,
  focus: string,
  engine: string | null
): FocusStats {
  const isParent = focus.startsWith(PARENT_PREFIX);
  const name = isParent ? focus.slice(PARENT_PREFIX.length) : focus;
  const parents = parentMap(x);
  const promptById = new Map(x.prompts.map((p) => [p.id, p]));
  let named = 0;
  let picks = 0;
  let n = 0;
  for (const r of x.responses) {
    if (engine && x.run.model !== engine) continue;
    const p = promptById.get(r.prompt_id)!;
    if (p.theme === "branded") continue;
    n += 1;
    const ms = answerMentions(x, r);
    const has = isParent
      ? ms.some((m) => (parents.get(m.norm) ?? m.display) === name)
      : ms.some((m) => m.display === name);
    if (has) named += 1;
    const pickNorm = r.top_pick_brand ? x.canon.norm(r.top_pick_brand) : null;
    if (pickNorm) {
      const pickDisplay = x.canon.canonical(r.top_pick_brand!);
      const pickParent = parents.get(pickNorm) ?? pickDisplay;
      if (isParent ? pickParent === name : pickDisplay === name) picks += 1;
    }
  }
  return { named, picks, n };
}

/** Modal pick per prompt — the brand most answers crowned. Focus-independent
 * (it is a property of the prompt), so stability reads the same whichever
 * focus is selected. [script]: Excel has no clean modal-of-text formula. */
function modalPickBy(
  x: WorkbookInputs,
  keyOf: (r: ResponseRow) => string | null
): Map<string, string> {
  const tally = new Map<string, Map<string, number>>();
  for (const r of x.responses) {
    if (!r.top_pick_brand) continue;
    const key = keyOf(r);
    if (key === null) continue;
    const display = x.canon.canonical(r.top_pick_brand);
    const counts = tally.get(key) ?? new Map<string, number>();
    counts.set(display, (counts.get(display) ?? 0) + 1);
    tally.set(key, counts);
  }
  const out = new Map<string, string>();
  for (const [key, counts] of tally) {
    const best = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0];
    if (best) out.set(key, best[0]);
  }
  return out;
}

function modalPickByPrompt(x: WorkbookInputs): Map<string, string> {
  return modalPickBy(x, (r) => x.promptCode(r.prompt_id));
}

/** Modal pick per unbranded theme — who wins each buyer stage. */
function modalPickByTheme(x: WorkbookInputs): Map<string, string> {
  const promptById = new Map(x.prompts.map((p) => [p.id, p]));
  return modalPickBy(x, (r) => {
    const p = promptById.get(r.prompt_id);
    return p && p.theme !== "branded" ? p.theme.replace("_", " ") : null;
  });
}

const pct1Fmt = "0.0%";

/** Section heading inside a sheet. */
function sectionRow(ws: ExcelJS.Worksheet, rowN: number, title: string) {
  const c = ws.getCell(`A${rowN}`);
  c.value = title;
  c.font = { bold: true, size: 12, color: { argb: SLATE } };
}

function noteRow(ws: ExcelJS.Worksheet, rowN: number, text: string) {
  const c = ws.getCell(`A${rowN}`);
  c.value = text;
  c.font = { italic: true, size: 10, color: { argb: "FF6B7280" } };
}

/**
 * Metric definitions under a table — one short row per term (term in A,
 * definition merged across the table width) so nothing wraps into a tall
 * cell. Returns the next free row.
 */
function definitions(
  ws: ExcelJS.Worksheet,
  startRow: number,
  lastCol: number,
  entries: [string, string][]
): number {
  let row = startRow;
  const head = ws.getCell(`A${row}`);
  head.value = "How to read this table";
  head.font = { bold: true, size: 10, color: { argb: "FF6B7280" } };
  row += 1;
  for (const [term, def] of entries) {
    const t = ws.getCell(`A${row}`);
    t.value = term;
    t.font = { italic: true, size: 10, color: { argb: "FF374151" } };
    t.alignment = { vertical: "top" };
    ws.mergeCells(row, 2, row, lastCol);
    const d = ws.getCell(row, 2);
    d.value = def;
    d.font = { size: 10, color: { argb: "FF6B7280" } };
    d.alignment = { vertical: "top", wrapText: false };
    row += 1;
  }
  return row;
}

function headerRow(ws: ExcelJS.Worksheet, rowN: number, values: string[]) {
  const r = ws.getRow(rowN);
  r.values = values;
  for (let i = 1; i <= values.length; i++) {
    const cell = r.getCell(i);
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = BRAND_FILL;
  }
}

export async function buildScorecardWorkbook(
  x: WorkbookInputs
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addReadme(
    wb,
    `${x.project.brand} — AI visibility scorecard`,
    ceremonySections(
      x,
      `This workbook answers 'Where do we stand?' — read it first. Its companion analysis workbook answers 'Who owns the category and why?'. Here: how visible the focus is in AI answers for ${x.project.category}, by LLM engine and in total, for any brand or parent company via the Focus dropdown.`,
      "the 95% confidence intervals (Wilson score), precomputed for every focus × engine on the hidden CI sheet and looked up live; the modal pick per prompt on the Prompt Grid; and the Key Insights figures, generated from the same computation as the live formulas.",
      [
        [
          "Scorecard",
          "Start here. Four tables for the selected focus: the visibility funnel by engine, how settled each answer is, performance by buyer question type, and whether the gap to each rival is real. Every table has its own definitions block underneath.",
        ],
        [
          "Prompt Grid",
          "One row per prompt showing what the assistant actually picked on each repeat, plus how consistent those picks were. This is where you find the winnable questions.",
        ],
        [
          "Key Insights",
          "The three or four findings worth saying out loud, as paired numbers with a one-line reading.",
        ],
        [
          "Quotes",
          "Every coded verbatim about the focus brand, with the coder's reading and the response_id to trace it.",
        ],
        [
          "Insights",
          "Numbered insights and recommended plays; every figure was substituted from the study's verified fact registry, never written by hand.",
        ],
        [
          "Data",
          "The evidence layer: one row per sampled answer, with its prompt, engine, whether the focus was named and where, what the answer picked, and a 0/1 column per argument it used. Every formula in this file counts over this sheet.",
        ],
        [
          "Mention Data",
          "The evidence layer at brand grain: one row per brand named in an answer, with its raw extracted name, position, framing, whether it was that answer's pick, how many times it was named, and the parent it rolls up to. Data answers 'what did this answer do?'; Mention Data answers 'who was named, where, and how?' — which is what makes the Focus dropdown able to re-compute for any brand.",
        ],
      ]
    )
  );
  const dl = dataLayout(x);
  const mc = mentionLayout();
  const D = (c: string) => `Data!${dl.cols[c]}:${dl.cols[c]}`;
  const M = (c: string) => `'Mention Data'!${mc[c]}:${mc[c]}`;

  // ----- focus options: every analyzable brand, then parents -----
  const brandOptions = x.metrics.brands.map((b) => b.brand);
  const parentOptions = [
    ...new Set(
      x.dictionary
        .filter((e) => e.status === "active" && e.parent)
        .map((e) => e.parent!)
    ),
  ].sort();
  const options = [
    ...brandOptions,
    ...parentOptions.map((p) => `${PARENT_PREFIX}${p}`),
  ];
  const lists = wb.addWorksheet("Lists");
  lists.addRow(["focus options"]);
  options.forEach((o) => lists.addRow([o]));
  // Parent helpers live here so the visible sheets stay clean. Each resolves
  // to the parent-company name when a [Parent] focus is picked, else blank.
  const parentIf = (cell: string) =>
    `IF(LEFT(${cell},${PARENT_PREFIX.length})="${PARENT_PREFIX}",MID(${cell},${PARENT_PREFIX.length + 1},255),"")`;
  lists.getCell("C1").value = { formula: parentIf("Scorecard!$B$1") };
  lists.getCell("C2").value = { formula: parentIf("'Prompt Grid'!$B$1") };
  const SCORE_PARENT = "Lists!$C$1";
  const GRID_PARENT = "Lists!$C$2";
  lists.state = "hidden";

  // ----- precomputed CI lookup (the [script] register) -----
  // Text for display, numeric bounds so "read as" can compare intervals.
  const engines = [x.run.model];
  const ci = wb.addWorksheet("CI");
  ci.addRow(["key", "ci", "low", "high"]);
  for (const focus of options) {
    for (const engine of [...engines, "TOTAL"]) {
      const s = computeFocusStats(x, focus, engine === "TOTAL" ? null : engine);
      for (const [metric, k] of [
        ["present", s.named],
        ["pick", s.picks],
      ] as const) {
        const w = wilson(k, s.n);
        ci.addRow([
          `${focus}|${engine}|${metric}`,
          `${Math.round(w.low * 100)}%–${Math.round(w.high * 100)}%`,
          w.low,
          w.high,
        ]);
      }
    }
  }
  ci.state = "hidden";

  // Prompt Grid column geometry — declared up front because the Scorecard's
  // stability bands count over the Prompt Grid's settled column.
  const R = x.run.repeats;
  const firstPickCol = 4;
  const cAnswers = colLetter(firstPickCol + R);
  const cNamed = colLetter(firstPickCol + R + 1);
  const cNamedPct = colLetter(firstPickCol + R + 2);
  const cDecided = colLetter(firstPickCol + R + 3);
  const cPicks = colLetter(firstPickCol + R + 4);
  const cModal = colLetter(firstPickCol + R + 5);
  const cStability = colLetter(firstPickCol + R + 6);
  const settledCol = colLetter(firstPickCol + R + 7);
  const cBadge = colLetter(firstPickCol + R + 8);

  // ----- Scorecard: focus dropdown + funnel, stability, themes, head-to-head -----
  const ws = wb.addWorksheet("Scorecard");
  ws.getColumn(1).width = 18;
  for (const c of ["B", "C", "D", "E", "F", "G", "H", "I"]) {
    ws.getColumn(c).width = 13;
  }
  ws.getCell("A1").value = "Focus";
  ws.getCell("A1").font = { bold: true };
  ws.getCell("B1").value = x.project.brand;
  ws.getCell("B1").fill = YELLOW_FILL;
  ws.getCell("B1").font = { bold: true };
  ws.getCell("B1").dataValidation = {
    type: "list",
    allowBlank: false,
    formulae: [`=Lists!$A$2:$A$${options.length + 1}`],
  };
  ws.getCell("D1").value =
    "← pick any brand or parent company; every table on this sheet re-computes for it";
  ws.getCell("D1").font = { italic: true, color: { argb: "FF6B7280" } };

  // Focus-aware count fragments, reused across every section.
  const mCrit = (extra: string, modelCrit: string) =>
    `${modelCrit ? `${M("model")},${modelCrit},` : ""}${M("is_branded")},0${extra}`;
  const namedF = (modelCrit: string, extra = "") =>
    `IF(${SCORE_PARENT}<>"",COUNTIFS(${mCrit(extra, modelCrit)},${M("parent")},${SCORE_PARENT},${M("first_of_parent_in_answer")},1),COUNTIFS(${mCrit(extra, modelCrit)},${M("brand")},$B$1))`;
  const picksF = (modelCrit: string, extra = "") =>
    `IF(${SCORE_PARENT}<>"",COUNTIFS(${modelCrit ? `${D("model")},${modelCrit},` : ""}${D("is_branded")},0${extra},${D("top_pick_parent")},${SCORE_PARENT}),COUNTIFS(${modelCrit ? `${D("model")},${modelCrit},` : ""}${D("is_branded")},0${extra},${D("top_pick")},$B$1))`;
  const posF = (modelCrit: string) =>
    `IFERROR(IF(${SCORE_PARENT}<>"",AVERAGEIFS(${M("position")},${mCrit("", modelCrit)},${M("parent")},${SCORE_PARENT},${M("first_of_parent_in_answer")},1),AVERAGEIFS(${M("position")},${mCrit("", modelCrit)},${M("brand")},$B$1)),"—")`;

  // ===== Section 1: the persuasion funnel, by engine =====
  let row = 3;
  sectionRow(ws, row, "Visibility funnel — named, shortlisted, chosen");
  row += 1;
  headerRow(ws, row, [
    "Engine",
    "Answers",
    "Named",
    "Named %",
    "95% CI",
    "Top-3",
    "Top-3 %",
    "First picks",
    "Pick %",
    "95% CI",
    "Avg position",
  ]);
  // Freeze only the Focus row: it drives every table below, and the sheet
  // stacks several tables with their own headers, so pinning one table's
  // header would be wrong everywhere else.
  ws.views = [{ state: "frozen", ySplit: 1 }];
  row += 1;
  const engineRows = [
    ...engines.map((e) => ({ label: e, useCrit: true })),
    { label: "TOTAL", useCrit: false },
  ];
  engineRows.forEach((er) => {
    const rowN = row;
    const crit = er.useCrit ? `$A${rowN}` : "";
    ws.getRow(rowN).values = [
      er.label,
      {
        formula: crit
          ? `COUNTIFS(${D("model")},${crit},${D("is_branded")},0)`
          : `COUNTIFS(${D("is_branded")},0)`,
      },
      { formula: namedF(crit) },
      { formula: `IFERROR(C${rowN}/B${rowN},"")` },
      {
        formula: `IFERROR(VLOOKUP($B$1&"|"&$A${rowN}&"|present",CI!$A:$D,2,FALSE),"[script]")`,
      },
      { formula: namedF(crit, `,${M("position")},"<=3"`) },
      { formula: `IFERROR(F${rowN}/B${rowN},"")` },
      { formula: picksF(crit) },
      { formula: `IFERROR(H${rowN}/B${rowN},"")` },
      {
        formula: `IFERROR(VLOOKUP($B$1&"|"&$A${rowN}&"|pick",CI!$A:$D,2,FALSE),"[script]")`,
      },
      { formula: posF(crit) },
    ];
    for (const c of ["D", "G", "I"]) ws.getCell(`${c}${rowN}`).numFmt = pct1Fmt;
    ws.getCell(`K${rowN}`).numFmt = "0.0";
    if (!er.useCrit) {
      ws.getRow(rowN).font = { bold: true };
      ws.getCell(`D${rowN}`).fill = YELLOW_FILL;
      ws.getCell(`I${rowN}`).fill = YELLOW_FILL;
    }
    row += 1;
  });
  const totalRowN = row - 1;
  row = definitions(ws, row + 1, 11, [
    [
      "Engine",
      "One row per LLM engine measured, plus TOTAL across all of them. Every engine answers the same battery.",
    ],
    [
      "Answers",
      "Unbranded answers sampled. Branded probes (which name the brand in the question) are excluded from every rate here — asking about a brand guarantees a mention.",
    ],
    ["Named", "Distinct answers in which the focus appears anywhere."],
    ["Named %", "Named ÷ Answers. The reach number: how often you are in the conversation at all."],
    [
      "Top-3",
      "Answers where the focus appears among the first three brands. The shortlist.",
    ],
    ["Top-3 %", "Top-3 ÷ Answers. A big drop from Named % is a position problem, not an awareness problem."],
    [
      "First picks",
      "Answers that crown the focus as THE recommendation (not merely list it).",
    ],
    ["Pick %", "First picks ÷ Answers. The drop from Named % to Pick % is the persuasion gap."],
    [
      "Avg position",
      "Mean rank of the focus's first appearance, across answers that name it. Lower is better; 1.0 means it always leads.",
    ],
    [
      "95% CI",
      "Wilson score interval [script]. Two rates are only different if their intervals do not overlap.",
    ],
    [
      "Trace any number",
      "Every count filters the Data or Mention Data sheet; each row there carries response_id, which is the same id used in the Quotes sheet and in 05_response_library of the study bundle.",
    ],
  ]);
  row += 2;

  // ===== Section 2: how settled the pick is (our repeats, made legible) =====
  sectionRow(ws, row, "How settled the answer is — where the category is winnable");
  row += 1;
  headerRow(ws, row, ["Consistency", "Prompts", "What it means"]);
  row += 1;
  const bandStart = row;
  const bands: [string, string, string][] = [
    [
      "Locked",
      "Settled",
      "The same brand wins at least 4 of 5 asks. Moving these takes a product or reputation change, not a message.",
    ],
    [
      "Leaning",
      "Leaning",
      "A majority winner with real disagreement underneath. Reachable with sustained content and citations.",
    ],
    [
      "Coin-flip",
      "Coin-flip",
      "No brand holds a majority across repeats — the assistant is genuinely undecided. These are the winnable prompts.",
    ],
    ["No pick", "No pick", "Answers explained options without committing to one."],
  ];
  bands.forEach(([label, key, meaning]) => {
    ws.getRow(row).values = [
      label,
      { formula: `COUNTIF('Prompt Grid'!$${settledCol}:$${settledCol},"${key}")` },
    ];
    // Merged across the table width so the explanation stays one line high.
    ws.mergeCells(row, 3, row, 11);
    const c = ws.getCell(row, 3);
    c.value = meaning;
    c.alignment = { vertical: "middle", wrapText: false };
    if (key === "Coin-flip") ws.getCell(`B${row}`).fill = YELLOW_FILL;
    row += 1;
  });
  row = definitions(ws, row + 1, 11, [
    [
      "Consistency",
      "For one prompt, the share of its decided answers that picked the same brand as the prompt's most common pick (the modal pick, shown on the Prompt Grid).",
    ],
    [
      "Settled",
      "Consistency 80% or higher — the same brand wins at least 4 of 5 asks.",
    ],
    ["Leaning", "Consistency above 50% but under 80% — a majority winner with real disagreement underneath."],
    ["Coin-flip", "Consistency 50% or lower — no brand holds a majority. The assistant is genuinely undecided here."],
    ["No pick", "No answer for that prompt committed to a recommendation at all."],
    ["Prompts", "How many prompts in the battery fall in that band."],
    [
      "Why this exists",
      "Repeats are asks of the SAME question to the SAME engine, so disagreement is instability in the model's answer — not a difference between platforms. Coin-flips are the cheapest prompts to go win.",
    ],
    [
      "Where to act",
      "Open the Prompt Grid, filter the 'settled' column to Coin-flip (highlighted yellow), and read across the pick columns to see who is taking the asks you are losing.",
    ],
  ]);
  row += 2;

  // ===== Section 3: by buyer question type =====
  sectionRow(ws, row, "By buyer question type");
  row += 1;
  headerRow(ws, row, [
    "Question type",
    "Answers",
    "Named",
    "Named %",
    "First picks",
    "Pick %",
    "Most common pick [script]",
  ]);
  row += 1;
  const themeModal = modalPickByTheme(x);
  const themes = [...new Set(x.prompts.filter((p) => p.retired === 0 && p.theme !== "branded").map((p) => p.theme))];
  themes.forEach((theme) => {
    const rowN = row;
    ws.getRow(rowN).values = [
      theme.replace("_", " "),
      { formula: `COUNTIFS(${D("theme")},$A${rowN},${D("is_branded")},0)` },
      {
        formula: `IF(${SCORE_PARENT}<>"",COUNTIFS(${M("theme")},$A${rowN},${M("parent")},${SCORE_PARENT},${M("first_of_parent_in_answer")},1),COUNTIFS(${M("theme")},$A${rowN},${M("brand")},$B$1))`,
      },
      { formula: `IFERROR(C${rowN}/B${rowN},"")` },
      {
        formula: `IF(${SCORE_PARENT}<>"",COUNTIFS(${D("theme")},$A${rowN},${D("top_pick_parent")},${SCORE_PARENT}),COUNTIFS(${D("theme")},$A${rowN},${D("top_pick")},$B$1))`,
      },
      { formula: `IFERROR(E${rowN}/B${rowN},"")` },
      themeModal.get(theme.replace("_", " ")) ?? "—",
    ];
    ws.getCell(`D${rowN}`).numFmt = pct1Fmt;
    ws.getCell(`F${rowN}`).numFmt = pct1Fmt;
    row += 1;
  });
  row = definitions(ws, row + 1, 11, [
    [
      "Question type",
      "What the buyer was doing when they asked: discovery (what exists), recommendation (what fits my situation), comparison (weighing options), use case (a specific constraint).",
    ],
    ["Answers", "Unbranded answers sampled for prompts of that type."],
    ["Named / Named %", "Distinct answers of that type naming the focus, and that count ÷ Answers."],
    ["First picks / Pick %", "Answers of that type crowning the focus, and that count ÷ Answers."],
    [
      "Most common pick",
      "The brand crowned most often across all answers of that type [script] — who is winning this buyer stage, whoever the focus is.",
    ],
    [
      "Why it matters",
      "Winning discovery but losing recommendation means you are known and not chosen once the buyer describes their situation — a messaging problem at a specific point in the journey, invisible in the overall rate.",
    ],
    [
      "Small cells",
      "Some question types carry few prompts; read a difference as directional until a second run confirms it.",
    ],
  ]);
  row += 2;

  // ===== Section 4: head to head, with interval-aware readings =====
  sectionRow(
    ws,
    row,
    "Is the gap real? — the focus against every other brand"
  );
  row += 1;
  ws.getCell(`A${row}`).value = {
    formula: `"Each row compares "&$B$1&" to one rival brand. The last column says whether the difference between them is a real lead or just sampling noise."`,
  };
  ws.getCell(`A${row}`).font = { italic: true, size: 10, color: { argb: "FF6B7280" } };
  row += 1;
  // Set filter: which competitive set the table shows.
  ws.getCell(`A${row}`).value = "Set";
  ws.getCell(`A${row}`).font = { bold: true };
  const setCell = `$B$${row}`;
  ws.getCell(`B${row}`).value = "All";
  ws.getCell(`B${row}`).fill = YELLOW_FILL;
  ws.getCell(`B${row}`).font = { bold: true };
  ws.getCell(`B${row}`).dataValidation = {
    type: "list",
    allowBlank: false,
    formulae: ['"All,Competitors,Discovered"'],
  };
  ws.getCell(`C${row}`).value =
    "← tracked competitors, model-volunteered discoveries, or everyone";
  ws.getCell(`C${row}`).font = { italic: true, size: 10, color: { argb: "FF6B7280" } };
  row += 1;
  headerRow(ws, row, [
    "Brand",
    "Set",
    "Named %",
    "95% CI",
    "Focus lead (pts)",
    "Read as",
  ]);
  row += 1;
  const roleOfWb = dictionaryRoles(x.dictionary, x.project, x.canon);
  const rivals = x.metrics.brands.slice(0, 15).map((b) => b.brand);
  rivals.forEach((brand) => {
    const rowN = row;
    // Row shows when its set matches the filter; the focus row always shows.
    const visible = `OR(${setCell}="All",$B${rowN}="target",AND(${setCell}="Competitors",$B${rowN}="competitor"),AND(${setCell}="Discovered",$B${rowN}="emerged"))`;
    ws.getRow(rowN).values = [
      brand,
      roleOfWb(brand),
      {
        formula: `IF(${visible},IFERROR(COUNTIFS(${M("is_branded")},0,${M("brand")},$A${rowN})/COUNTIFS(${D("is_branded")},0),""),"")`,
      },
      {
        formula: `IF(${visible},IFERROR(VLOOKUP($A${rowN}&"|TOTAL|present",CI!$A:$D,2,FALSE),"[script]"),"")`,
      },
      {
        formula: `IF(OR($A${rowN}=$B$1,NOT(${visible})),"",IFERROR(ROUND(($D$${totalRowN}-C${rowN})*100,1),""))`,
      },
      {
        // Interval-aware: overlapping CIs read as parity, never as a lead.
        formula: `IF(NOT(${visible}),"",IF($A${rowN}=$B$1,"— this is the focus —",IFERROR(IF(VLOOKUP($B$1&"|TOTAL|present",CI!$A:$D,3,FALSE)>VLOOKUP($A${rowN}&"|TOTAL|present",CI!$A:$D,4,FALSE),"real lead",IF(VLOOKUP($B$1&"|TOTAL|present",CI!$A:$D,4,FALSE)<VLOOKUP($A${rowN}&"|TOTAL|present",CI!$A:$D,3,FALSE),"real deficit","too close to call")),"—")))`,
      },
    ];
    ws.getCell(`B${rowN}`).font = { size: 10, color: { argb: "FF6B7280" } };
    ws.getCell(`C${rowN}`).numFmt = pct1Fmt;
    ws.getCell(`E${rowN}`).numFmt = "+0.0;-0.0;0";
    row += 1;
  });
  row = definitions(ws, row + 1, 11, [
    ["Brand", "Every other brand the answers named, most-reached first. The focus itself is included and marked."],
    [
      "Set",
      "The brand's role in this study: a tracked competitor you chose (or promoted in the Brand dictionary), or a discovery the model volunteered ('emerged'). The Set dropdown above the table filters rows to one group; rows outside the selected set blank out.",
    ],
    ["Named %", "Share of unbranded answers naming that brand — the same measure as the funnel's Named %, brand by brand."],
    ["95% CI", "That brand's Wilson interval [script]. The true rate is very likely somewhere in this range."],
    [
      "Focus lead (pts)",
      "The focus's Named % minus this brand's, in percentage points. Positive means the focus is higher on paper.",
    ],
    [
      "Read as",
      '"real lead" / "real deficit" = the two intervals do not overlap, so the gap survives sampling. "too close to call" = the intervals overlap: at this sample size the two brands are statistically tied, however different the percentages look.',
    ],
    [
      "Why this column exists",
      "A 17-point gap can still be noise at n=60. This is the check that stops a client briefing a tie as a win — the discipline no single-shot audit can offer.",
    ],
    [
      "To widen a tie",
      "Raise repeats per prompt on the next run; intervals narrow roughly with the square root of the sample.",
    ],
  ]);

  // ----- Prompt Grid: the picks themselves, one column per repeat -----
  const pg = wb.addWorksheet("Prompt Grid");
  // This sheet carries its own Focus selector so you can drill without
  // hopping back to the Scorecard (Excel cannot two-way-link two dropdowns
  // without macros — set both the same for one story, or differ to compare).
  pg.getCell("A1").value = "Focus";
  pg.getCell("A1").font = { bold: true };
  pg.getCell("B1").value = x.project.brand;
  pg.getCell("B1").fill = YELLOW_FILL;
  pg.getCell("B1").font = { bold: true };
  pg.getCell("B1").dataValidation = {
    type: "list",
    allowBlank: false,
    formulae: [`=Lists!$A$2:$A$${options.length + 1}`],
  };
  pg.getCell("D1").value =
    "← this sheet's focus (the Scorecard has its own; set both the same to read one story, or differ to compare two brands)";
  pg.getCell("D1").font = { italic: true, color: { argb: "FF6B7280" } };
  pg.getCell("A2").value =
    "What the assistant actually picked — each row one prompt, each column one repeat of the SAME question. Disagreement across a row is measured instability in the model's answer, and instability is opportunity.";
  pg.getCell("A2").font = { italic: true, color: { argb: "FF6B7280" } };
  const gridHeader = [
    "code",
    "theme",
    "prompt",
    ...Array.from({ length: R }, (_, i) => `pick r${i + 1}`),
    "answers",
    "named",
    "named %",
    "decided",
    "focus picks",
    "modal pick [script]",
    "consistency",
    "settled",
    "badge",
  ];
  pg.getRow(3).values = gridHeader;
  styleHeader(pg, 3);
  pg.views = [{ state: "frozen", ySplit: 3, xSplit: 3 }];
  pg.getColumn(3).width = 52;
  for (let i = 0; i < R; i++) pg.getColumn(4 + i).width = 16;
  pg.getColumn(firstPickCol + R + 5).width = 18;

  const modalByPrompt = modalPickByPrompt(x);
  const active = x.prompts.filter((p) => p.retired === 0);
  active.forEach((p, i) => {
    const rowN = 4 + i;
    const code = x.promptCode(p.id);
    const values: (string | number | { formula: string } | null)[] = [
      code,
      p.theme,
      p.text,
    ];
    for (let r = 1; r <= R; r++) {
      values.push({
        formula: `IFERROR(IF(INDEX(${D("top_pick")},MATCH($A${rowN}&"|${r}",${D("key")},0))=0,"· no pick ·",INDEX(${D("top_pick")},MATCH($A${rowN}&"|${r}",${D("key")},0))),"")`,
      });
    }
    values.push(
      { formula: `COUNTIFS(${D("prompt_code")},$A${rowN})` },
      {
        formula: `IF(${GRID_PARENT}<>"",COUNTIFS(${M("prompt_code")},$A${rowN},${M("parent")},${GRID_PARENT},${M("first_of_parent_in_answer")},1),COUNTIFS(${M("prompt_code")},$A${rowN},${M("brand")},$B$1))`,
      },
      { formula: `IFERROR(${cNamed}${rowN}/${cAnswers}${rowN},"")` },
      {
        formula: `COUNTIFS(${D("prompt_code")},$A${rowN},${D("outcome")},"pick")`,
      },
      {
        formula: `IF(${GRID_PARENT}<>"",COUNTIFS(${D("prompt_code")},$A${rowN},${D("top_pick_parent")},${GRID_PARENT}),COUNTIFS(${D("prompt_code")},$A${rowN},${D("top_pick")},$B$1))`,
      },
      modalByPrompt.get(code) ?? null,
      {
        // Share of decided answers agreeing with the modal pick — a property
        // of the prompt, so it reads the same whichever focus is selected.
        formula: `IFERROR(COUNTIFS(${D("prompt_code")},$A${rowN},${D("top_pick")},${cModal}${rowN})/${cDecided}${rowN},"")`,
      },
      {
        formula: `IF(${cDecided}${rowN}=0,"No pick",IF(${cStability}${rowN}>=0.8,"Settled",IF(${cStability}${rowN}>0.5,"Leaning","Coin-flip")))`,
      },
      {
        formula: `IF(${cNamed}${rowN}=0,"ABSENT",IF(${cPicks}${rowN}*2>${cDecided}${rowN},"WINS","CONTESTED"))`,
      }
    );
    pg.getRow(rowN).values = values;
    pg.getCell(`${cNamedPct}${rowN}`).numFmt = "0%";
    pg.getCell(`${cStability}${rowN}`).numFmt = "0%";
  });
  const lastRow = 3 + active.length;
  pg.autoFilter = { from: `A3`, to: `${cBadge}${lastRow}` };
  // Coin-flips are the winnable prompts — make them findable at a glance.
  pg.addConditionalFormatting({
    ref: `${settledCol}4:${settledCol}${lastRow}`,
    rules: [
      {
        type: "containsText",
        operator: "containsText",
        text: "Coin-flip",
        priority: 1,
        style: {
          fill: { type: "pattern", pattern: "solid", bgColor: { argb: HIGHLIGHT } },
          font: { bold: true },
        },
      },
    ],
  });
  // Highlight pick cells matching the selected focus (brand selections).
  pg.addConditionalFormatting({
    ref: `D4:${colLetter(firstPickCol + R - 1)}${lastRow}`,
    rules: [
      {
        type: "expression",
        priority: 1,
        formulae: [`D4=$B$1`],
        style: { fill: { type: "pattern", pattern: "solid", bgColor: { argb: "FFDCE6EC" } } },
      },
    ],
  });
  for (const [text, argb] of [
    ["WINS", WIN_FILL],
    ["CONTESTED", CONTESTED_FILL],
    ["ABSENT", ABSENT_FILL],
  ] as const) {
    pg.addConditionalFormatting({
      ref: `${cBadge}4:${cBadge}${lastRow}`,
      rules: [
        {
          type: "containsText",
          operator: "containsText",
          text,
          priority: 1,
          style: {
            fill: { type: "pattern", pattern: "solid", bgColor: { argb } },
            font: { bold: true, color: { argb: "FFFFFFFF" } },
          },
        },
      ],
    });
  }
  const gridNote = lastRow + 2;
  pg.getCell(`A${gridNote}`).value =
    "Badge (live): ABSENT when the focus is never named for the prompt; WINS when it takes a strict majority of decided answers; CONTESTED otherwise. The dashboard's consensus badge additionally uses the modal pick — edge cases can differ.";
  pg.getCell(`A${gridNote}`).font = { italic: true, color: { argb: "FF6B7280" } };

  // ----- Key Insights: the designed layout -----
  addKeyInsightsSheet(wb, x);
  addQuotesSheet(wb, x);
  addInsightsSheet(wb, x.insights);
  // Evidence last: the story reads first, the receipts sit behind it.
  addDataSheet(wb, x, dl);
  addMentionDataSheet(wb, x);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Big paired numbers with a one-line story — a slide living in the
 * workbook. Figures are code-computed from metrics (same computation as the
 * live formulas), never LLM-written. */
function addKeyInsightsSheet(wb: ExcelJS.Workbook, x: WorkbookInputs) {
  const ws = wb.addWorksheet("Key Insights");
  ws.getColumn(1).width = 4;
  ws.getColumn(2).width = 20;
  ws.getColumn(3).width = 6;
  ws.getColumn(4).width = 20;
  ws.getColumn(5).width = 90;
  const t = ws.addRow(["", `Key insights — ${x.project.brand}`]);
  t.font = { bold: true, size: 14 };
  ws.addRow([
    "",
    "Central findings. Every number is generated from the same computation as the live formulas.",
  ]);

  const pctS = (v: number) => `${(v * 100).toFixed(1)}%`;
  const target = x.metrics.brands.find((b) => b.isTarget)!;
  const rival = x.metrics.brands.find((b) => !b.isTarget);
  const pairs: {
    title: string;
    a: string;
    aLabel: string;
    b: string;
    bLabel: string;
    story: string;
  }[] = [];
  if (x.metrics.firstPick) {
    pairs.push({
      title: "Considered vs chosen",
      a: pctS(target.mentionRate),
      aLabel: `${x.project.brand} named`,
      b: pctS(x.metrics.firstPick.rate),
      bLabel: `${x.project.brand} first pick`,
      story:
        "Presence gets the brand on the list; the pick decides the purchase. The distance between these two numbers is the persuasion gap.",
    });
  }
  if (rival) {
    pairs.push({
      title: "The closest rival",
      a: pctS(target.mentionRate),
      aLabel: x.project.brand,
      b: pctS(rival.mentionRate),
      bLabel: rival.brand,
      story: `${rival.brand} is the nearest brand by reach — the gap between these rates is the visibility lead (intervals on the Scorecard).`,
    });
  }
  if (x.metrics.reasonLift && x.metrics.reasonLift.length > 0) {
    const top = [...x.metrics.reasonLift].sort((a, b) => b.lift - a.lift)[0];
    pairs.push({
      title: `The argument that travels with wins: ${top.code}`,
      a: pctS(top.shareWins),
      aLabel: "share of wins using it",
      b: pctS(top.shareAll),
      bLabel: "share of all answers",
      story: `When answers use this argument, ${x.project.brand} wins more often — feed it.`,
    });
  }
  if (x.metrics.positionDist) {
    const d = x.metrics.positionDist;
    pairs.push({
      title: "Polarized position",
      a: `${d.r1}×`,
      aLabel: "ranked #1",
      b: `${d.r4plus}×`,
      bLabel: "ranked 4th or lower",
      story:
        "Answers either lead with the brand or bury it — the middle barely exists. Winning the lead position is the whole game.",
    });
  }

  let row = 4;
  pairs.forEach((p, i) => {
    const tr = ws.getRow(row);
    tr.getCell(2).value = `${i + 1}. ${p.title}`;
    tr.getCell(2).font = { bold: true, size: 12 };
    const nr = ws.getRow(row + 1);
    nr.getCell(2).value = p.a;
    nr.getCell(2).font = { bold: true, size: 26, color: { argb: SLATE } };
    nr.getCell(3).value = "vs";
    nr.getCell(3).font = { size: 12, color: { argb: "FF6B7280" } };
    nr.getCell(3).alignment = { horizontal: "center", vertical: "bottom" };
    nr.getCell(4).value = p.b;
    nr.getCell(4).font = { bold: true, size: 26, color: { argb: "FF374151" } };
    const lr = ws.getRow(row + 2);
    lr.getCell(2).value = p.aLabel;
    lr.getCell(4).value = p.bLabel;
    lr.font = { size: 10, color: { argb: "FF6B7280" } };
    const sr = ws.getRow(row + 3);
    sr.getCell(2).value = p.story;
    ws.mergeCells(row + 3, 2, row + 3, 5);
    sr.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row += 5;
  });
}

/** Receipts: every coded verbatim about the study's focus brand, filed by
 * prompt, negatives flagged. These are what clients paste into their own
 * decks. Coded for the study's focus brand only — noted on the sheet. */
function addQuotesSheet(wb: ExcelJS.Workbook, x: WorkbookInputs) {
  const ws = wb.addWorksheet("Quotes");
  ws.getCell("A1").value = `What the answers say about ${x.project.brand} — verbatim`;
  ws.getCell("A1").font = { bold: true, size: 12, color: { argb: SLATE } };
  ws.getCell("A2").value =
    "One row per sampled answer that spoke about the focus brand, with the coder's reading. Quotes are coded for the study's focus brand, so this sheet does not follow the Scorecard's Focus dropdown.";
  ws.getCell("A2").font = { italic: true, size: 10, color: { argb: "FF6B7280" } };
  headerRow(ws, 4, [
    "response_id",
    "code",
    "prompt",
    "repeat",
    "framing",
    "verbatim quote",
    "coder's reading",
  ]);
  ws.getColumn(1).width = 38;
  ws.getColumn(2).width = 8;
  ws.getColumn(3).width = 42;
  ws.getColumn(4).width = 8;
  ws.getColumn(5).width = 11;
  ws.getColumn(6).width = 66;
  ws.getColumn(7).width = 60;
  ws.views = [{ state: "frozen", ySplit: 4 }];

  const promptById = new Map(x.prompts.map((p) => [p.id, p]));
  const targetNorm = x.canon.norm(x.project.brand);
  let row = 5;
  for (const r of x.responses) {
    if (!r.focus_quote) continue;
    const p = promptById.get(r.prompt_id)!;
    const neg = answerMentions(x, r).some(
      (m) => m.norm === targetNorm && m.framing === "negative"
    );
    ws.getRow(row).values = [
      r.id,
      x.promptCode(r.prompt_id),
      p.text,
      r.repeat_idx + 1,
      neg ? "negative" : "neutral/positive",
      r.focus_quote,
      r.focus_interpretation,
    ];
    for (const c of ["C", "F", "G"]) {
      ws.getCell(`${c}${row}`).alignment = { wrapText: true, vertical: "top" };
    }
    if (neg) ws.getCell(`E${row}`).font = { bold: true, color: { argb: "FFB91C1C" } };
    row += 1;
  }
  if (row > 5) ws.autoFilter = { from: "A4", to: `G${row - 1}` };
  const defRow = row + 1;
  definitions(ws, defRow, 7, [
    [
      "response_id",
      "The unique id of the sampled answer. The same id appears in the Data and Mention Data sheets, in the study bundle's 04_master_dataset CSVs, and names the answer's file in 05_response_library — paste it anywhere to pull the full text.",
    ],
    ["code", "Prompt code (P01, P02…). Matches the Prompt Grid and the response library folders."],
    ["repeat", "Which of the repeats of that prompt this answer was."],
    [
      "framing",
      "How the answer positioned the focus brand: negative when it criticized or advised against it, otherwise neutral/positive.",
    ],
    ["verbatim quote", "The sentence the coder pulled about the focus brand, unedited."],
    ["coder's reading", "One line on what the answer is doing to the brand — context, not a second quote."],
  ]);
}

function addInsightsSheet(wb: ExcelJS.Workbook, insights: InsightsBundle | null) {
  const ws = wb.addWorksheet("Insights");
  ws.getColumn(1).width = 8;
  ws.getColumn(2).width = 120;
  if (!insights) {
    ws.addRow(["", "Insights were not available when this workbook was built."]);
    return;
  }
  let n = 0;
  for (const s of insights.sections) {
    const h = ws.addRow(["", s.title]);
    h.font = { bold: true };
    for (const text of s.insights) {
      n += 1;
      const r = ws.addRow([`I${n}`, text]);
      r.alignment = { wrapText: true, vertical: "top" };
    }
    ws.addRow([]);
  }
  const ph = ws.addRow(["", "Recommended plays"]);
  ph.font = { bold: true };
  insights.plays.forEach((p, i) => {
    const r = ws.addRow([
      `P${i + 1}`,
      `${p.title} — ${p.gap} Play: ${p.play} Measured by: ${p.measuredBy}, today ${p.today}.`,
    ]);
    r.alignment = { wrapText: true, vertical: "top" };
  });
  ws.addRow([]);
  ws.addRow([
    "",
    `Traceability: every figure was substituted from the study's verified fact registry (${insights.verification.figuresSupplied} facts, ${insights.verification.placeholdersSubstituted} substitutions) and gate-checked against the dataset before shipping.`,
  ]).alignment = { wrapText: true, vertical: "top" };
}

export async function buildAnalysisWorkbook(
  x: WorkbookInputs
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addReadme(
    wb,
    `${x.project.brand} — AI visibility analysis workbook`,
    ceremonySections(
      x,
      `This workbook answers 'Who owns the category and why?' — its companion scorecard answers 'Where do we stand?' and is the place to start. Here: who owns the category's AI answers, on what arguments, and where ${x.project.brand} wins or loses.`,
      "the 95% confidence intervals (Wilson score) and the per-prompt consensus badge from the dashboard; everything they summarize is recomputable from these sheets.",
      [
        ["Leaderboard", "Every brand by reach, with intervals, average position, and share of voice. Set dropdown filters to competitors or discoveries."],
        ["TopPicks", "Who actually gets crowned — first-pick counts and share of decided answers. Set dropdown as above."],
        [
          "ReasonLift",
          "Which arguments travel with the focus brand's wins, which decide against it when it made the list and lost, and which mark conversations it is absent from.",
        ],
        ["Positions", "Where the focus lands when named: #1, #2, #3, 4th-or-lower, or absent."],
        [
          "Personality",
          "The style of the advisor, by engine: how often it clarifies or commits, how long it talks, how many brands it names, whether it quotes prices and specs.",
        ],
        ["Parents", "The same reach question at parent-company grain; every independent brand is its own parent."],
        [
          "Quotes",
          "Every coded verbatim about the focus brand with the coder's reading — negatives flagged in red, filterable by the framing column.",
        ],
        ["Key Insights / Insights", "The findings worth saying out loud, and the numbered insights with plays."],
        [
          "Data",
          "One row per sampled answer — the evidence every formula counts over.",
        ],
        [
          "Mention Data",
          "One row per brand named in an answer, with raw name, position, framing, pick flag, and parent company. This is what lets brand-level and parent-level tables be computed from the same evidence.",
        ],
      ]
    )
  );
  const dl = dataLayout(x);
  const { codeCols } = dl;
  const mc = mentionLayout();

  const D = (c: string) => `Data!${dl.cols[c]}:${dl.cols[c]}`;
  const M = (c: string) => `'Mention Data'!${mc[c]}:${mc[c]}`;
  const unbr = `COUNTIFS(${D("is_branded")},0)`;
  const totalMentions = `COUNTIFS(${M("is_branded")},0)`;

  const roleOfA = dictionaryRoles(x.dictionary, x.project, x.canon);
  const setDropdown = (ws: ExcelJS.Worksheet) => {
    ws.getCell("A1").value = "Set";
    ws.getCell("A1").font = { bold: true };
    ws.getCell("B1").value = "All";
    ws.getCell("B1").fill = YELLOW_FILL;
    ws.getCell("B1").font = { bold: true };
    ws.getCell("B1").dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: ['"All,Competitors,Discovered"'],
    };
    ws.getCell("C1").value =
      "← tracked competitors, model-volunteered discoveries, or everyone; rows outside the set blank out";
    ws.getCell("C1").font = { italic: true, size: 10, color: { argb: "FF6B7280" } };
  };
  const setVisible = (rowN: number) =>
    `OR($B$1="All",$B${rowN}="target",AND($B$1="Competitors",$B${rowN}="competitor"),AND($B$1="Discovered",$B${rowN}="emerged"))`;

  // Leaderboard
  const lb = wb.addWorksheet("Leaderboard");
  setDropdown(lb);
  lb.getRow(2).values = [
    "brand",
    "set",
    "answers_named",
    "mention_rate",
    "ci_95",
    "avg_position",
    "share_of_voice",
  ];
  styleHeader(lb, 2);
  lb.getColumn(1).width = 28;
  x.metrics.brands.slice(0, 25).forEach((b, i) => {
    const rowN = i + 3;
    const vis = setVisible(rowN);
    lb.getRow(rowN).values = [
      b.brand,
      roleOfA(b.brand),
      {
        formula: `IF(${vis},COUNTIFS(${M("is_branded")},0,${M("brand")},$A${rowN}),"")`,
      },
      { formula: `IF(${vis},IFERROR(C${rowN}/${unbr},""),"")` },
      { formula: `IF(${vis},"${Math.round(b.ciLow * 100)}%–${Math.round(b.ciHigh * 100)}%","")` },
      {
        formula: `IF(${vis},IFERROR(AVERAGEIFS(${M("position")},${M("is_branded")},0,${M("brand")},$A${rowN}),"—"),"")`,
      },
      {
        formula: `IF(${vis},IFERROR(COUNTIFS(${M("is_branded")},0,${M("brand")},$A${rowN})/${totalMentions},""),"")`,
      },
    ];
    lb.getCell(`B${rowN}`).font = { size: 10, color: { argb: "FF6B7280" } };
    lb.getCell(`D${rowN}`).numFmt = pct1Fmt;
    lb.getCell(`F${rowN}`).numFmt = "0.0";
    lb.getCell(`G${rowN}`).numFmt = pct1Fmt;
  });

  // TopPicks
  if (x.metrics.topPicks) {
    const tp = wb.addWorksheet("TopPicks");
    setDropdown(tp);
    tp.getRow(2).values = ["brand", "set", "first_picks", "share_of_decided"];
    styleHeader(tp, 2);
    tp.getColumn(1).width = 28;
    const decided = `COUNTIFS(${D("is_branded")},0,${D("outcome")},"pick")`;
    x.metrics.topPicks.slice(0, 20).forEach((t, i) => {
      const rowN = i + 3;
      const vis = setVisible(rowN);
      tp.getRow(rowN).values = [
        t.brand,
        roleOfA(t.brand),
        {
          formula: `IF(${vis},COUNTIFS(${D("is_branded")},0,${D("top_pick")},$A${rowN}),"")`,
        },
        { formula: `IF(${vis},IFERROR(C${rowN}/${decided},""),"")` },
      ];
      tp.getCell(`B${rowN}`).font = { size: 10, color: { argb: "FF6B7280" } };
      tp.getCell(`D${rowN}`).numFmt = pct1Fmt;
    });
  }

  // ReasonLift — three-way: wins / considered-but-lost / absent. The middle
  // column is the diagnostic one: arguments present when the focus made the
  // list and still lost are the arguments deciding against it.
  if (x.metrics.reasonLift) {
    const rl = wb.addWorksheet("ReasonLift");
    rl.addRow([
      "argument",
      "answers_using",
      "share_all",
      "in wins",
      "considered, lost",
      "absent",
      "lift_points",
    ]);
    styleHeader(rl);
    rl.getColumn(1).width = 30;
    const wins = `COUNTIFS(${D("is_branded")},0,${D("target_first_pick")},1)`;
    const consideredLost = `COUNTIFS(${D("is_branded")},0,${D("target_named")},1,${D("target_first_pick")},0)`;
    const absent = `COUNTIFS(${D("is_branded")},0,${D("target_named")},0)`;
    x.metrics.reasonLift.forEach((r, i) => {
      const rowN = i + 2;
      const cc = codeCols.get(r.code);
      if (!cc) return;
      const col = `Data!${cc}:${cc}`;
      rl.addRow([
        r.code,
        { formula: `COUNTIFS(${D("is_branded")},0,${col},1)` },
        { formula: `IFERROR(B${rowN}/${unbr},"")` },
        {
          formula: `IFERROR(COUNTIFS(${D("is_branded")},0,${col},1,${D("target_first_pick")},1)/${wins},"")`,
        },
        {
          formula: `IFERROR(COUNTIFS(${D("is_branded")},0,${col},1,${D("target_named")},1,${D("target_first_pick")},0)/${consideredLost},"")`,
        },
        {
          formula: `IFERROR(COUNTIFS(${D("is_branded")},0,${col},1,${D("target_named")},0)/${absent},"")`,
        },
        { formula: `IFERROR((D${rowN}-C${rowN})*100,"")` },
      ]);
      for (const c of ["C", "D", "E", "F"]) rl.getCell(`${c}${rowN}`).numFmt = pct1Fmt;
      rl.getCell(`G${rowN}`).numFmt = "+0;-0;0";
    });
    const defStart = x.metrics.reasonLift.length + 3;
    definitions(rl, defStart, 7, [
      ["argument", "A reason code from the study's frozen taxonomy — the justifications assistants use."],
      ["answers_using / share_all", "Unbranded answers using the argument, and that count as a share of all unbranded answers."],
      ["in wins", "Share of the focus brand's first-pick wins that used the argument. High here = an argument that travels with winning."],
      [
        "considered, lost",
        "Share of answers that NAMED the focus but picked someone else. Arguments high here and low in wins are the ones deciding against you when you are already on the list — the kill-shots.",
      ],
      ["absent", "Share of answers that never named the focus. Arguments high here define conversations you are not part of at all."],
      ["lift_points", "in-wins share minus overall share, in percentage points."],
    ]);
  }

  // Personality — the style of the advisor, by engine. Deterministic
  // response-level codes; the shape their per-view table takes at n=repeats.
  {
    const pe = wb.addWorksheet("Personality");
    pe.addRow([
      "engine",
      "answers",
      "clarifies %",
      "recommends %",
      "avg words",
      "avg brands named",
      "avg recommendations",
      "prices %",
      "specs %",
    ]);
    styleHeader(pe);
    pe.getColumn(1).width = 16;
    const engines = [x.run.model];
    [...engines.map((e) => ({ label: e, crit: true })), { label: "TOTAL", crit: false }].forEach(
      (er, i) => {
        const rowN = i + 2;
        const mcrit = er.crit ? `${D("model")},$A${rowN},` : "";
        pe.getRow(rowN).values = [
          er.label,
          { formula: `COUNTIFS(${mcrit}${D("is_branded")},0)` },
          {
            formula: `IFERROR(COUNTIFS(${mcrit}${D("is_branded")},0,${D("clarification_requested")},1)/B${rowN},"")`,
          },
          {
            formula: `IFERROR(COUNTIFS(${mcrit}${D("is_branded")},0,${D("gives_recommendation")},1)/B${rowN},"")`,
          },
          {
            formula: `IFERROR(AVERAGEIFS(${D("word_count")},${mcrit}${D("is_branded")},0),"")`,
          },
          {
            formula: `IFERROR(AVERAGEIFS(${D("n_brands")},${mcrit}${D("is_branded")},0),"")`,
          },
          {
            formula: `IFERROR(AVERAGEIFS(${D("total_recommendations")},${mcrit}${D("is_branded")},0),"")`,
          },
          {
            formula: `IFERROR(COUNTIFS(${mcrit}${D("is_branded")},0,${D("includes_prices")},1)/B${rowN},"")`,
          },
          {
            formula: `IFERROR(COUNTIFS(${mcrit}${D("is_branded")},0,${D("includes_specs")},1)/B${rowN},"")`,
          },
        ];
        for (const c of ["C", "D", "H", "I"]) pe.getCell(`${c}${rowN}`).numFmt = pct1Fmt;
        for (const c of ["E", "F", "G"]) pe.getCell(`${c}${rowN}`).numFmt = "0.0";
        if (!er.crit) pe.getRow(rowN).font = { bold: true };
      }
    );
    definitions(pe, engines.length + 4, 9, [
      ["engine", "One row per LLM engine, plus TOTAL. With one engine measured they match; the shape is ready for multi-engine runs."],
      ["clarifies %", "Share of unbranded answers that asked the user something instead of only answering."],
      ["recommends %", "Share that committed to recommending at least one option."],
      ["avg words / brands / recommendations", "How long the engine talks, how many brands it names, and how many it actively recommends per answer."],
      ["prices % / specs %", "Share of answers quoting a price or concrete spec figures — how 'grounded' the advisor sounds."],
      ["Why it matters", "This is the advisor's personality: a terse engine that names three brands is a different battlefield from a chatty one that names twelve. Style shifts here across runs can explain rate shifts before any brand work does."],
    ]);
  }

  // Positions
  const pos = wb.addWorksheet("Positions");
  pos.addRow(["position of focus brand", "answers"]);
  styleHeader(pos);
  pos.getColumn(1).width = 26;
  pos.addRow(["#1", { formula: `COUNTIFS(${D("is_branded")},0,${D("target_position")},1)` }]);
  pos.addRow(["#2", { formula: `COUNTIFS(${D("is_branded")},0,${D("target_position")},2)` }]);
  pos.addRow(["#3", { formula: `COUNTIFS(${D("is_branded")},0,${D("target_position")},3)` }]);
  pos.addRow([
    "4th or lower",
    { formula: `COUNTIFS(${D("is_branded")},0,${D("target_position")},">=4")` },
  ]);
  pos.addRow([
    "not named",
    { formula: `COUNTIFS(${D("is_branded")},0,${D("target_named")},0)` },
  ]);

  // Parents
  if (x.metrics.parentRollup && x.metrics.parentRollup.length > 0) {
    const pr = wb.addWorksheet("Parents");
    pr.addRow(["parent company", "brands", "answers_named", "reach", "share_of_voice"]);
    styleHeader(pr);
    pr.getColumn(1).width = 24;
    pr.getColumn(2).width = 44;
    x.metrics.parentRollup.slice(0, 25).forEach((p, i) => {
      const rowN = i + 2;
      pr.addRow([
        p.parent,
        p.brands.join(", "),
        {
          formula: `COUNTIFS(${M("is_branded")},0,${M("parent")},$A${rowN},${M("first_of_parent_in_answer")},1)`,
        },
        { formula: `IFERROR(C${rowN}/${unbr},"")` },
        {
          formula: `IFERROR(COUNTIFS(${M("is_branded")},0,${M("parent")},$A${rowN})/${totalMentions},"")`,
        },
      ]);
      pr.getCell(`D${rowN}`).numFmt = pct1Fmt;
      pr.getCell(`E${rowN}`).numFmt = pct1Fmt;
    });
  }

  // Quotes replaces the old Negatives sheet: same evidence, one concept in
  // both workbooks — every verbatim, with negatives flagged and filterable.
  addQuotesSheet(wb, x);

  addKeyInsightsSheet(wb, x);
  addInsightsSheet(wb, x.insights);
  addDataSheet(wb, x, dl);
  addMentionDataSheet(wb, x);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
