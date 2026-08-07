import ExcelJS from "exceljs";
import { wilson } from "./metrics";
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
 * COUNTIFS/AVERAGEIFS over embedded Data/Mentions sheets, so any number can
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
  scriptComputed: string
): [string, string][] {
  const started = (x.run.started_at ?? x.run.created_at).slice(0, 10);
  const completed = (x.run.completed_at ?? x.run.created_at).slice(0, 10);
  return [
    ["What this answers", answers],
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
      `Run ${x.run.id.slice(0, 8)} (data lock ${x.run.completed_at ?? x.run.created_at}), dictionary v${x.metrics.dictionaryVersion}. The Data and Mentions sheets are embedded copies so every formula resolves inside this file.`,
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

function parentMap(x: WorkbookInputs): Map<string, string> {
  return new Map(
    x.dictionary
      .filter((e) => e.status === "active")
      .map((e) => [
        e.canonical.trim().toLowerCase(),
        e.parent ?? e.display_name ?? e.canonical,
      ])
  );
}

/** Per-answer canonicalized mention summary, shared by both sheet builders. */
function answerMentions(
  x: WorkbookInputs,
  r: ResponseRow
): { norm: string; display: string; rank: number; framing: string }[] {
  const perBrand = new Map<
    string,
    { display: string; rank: number; framing: string }
  >();
  for (const m of x.mentionsByResponse.get(r.id) ?? []) {
    if (x.canon.isRejected(m.brand)) continue;
    const norm = x.canon.norm(m.brand);
    const prev = perBrand.get(norm);
    if (!prev || m.rank < prev.rank) {
      perBrand.set(norm, {
        display: x.canon.canonical(m.brand),
        rank: m.rank,
        framing: prev?.framing === "negative" ? "negative" : m.framing,
      });
    } else if (m.framing === "negative") {
      prev.framing = "negative";
    }
  }
  return [...perBrand.entries()]
    .map(([norm, v]) => ({ norm, ...v }))
    .sort((a, b) => a.rank - b.rank);
}

/** The shared Data sheet: one row per coded answer. `key` = prompt|repeat
 * powers the prompt grid's INDEX/MATCH pick cells. */
function addDataSheet(
  wb: ExcelJS.Workbook,
  x: WorkbookInputs
): { cols: Record<string, string>; codeCols: Map<string, string> } {
  const { project, prompts, responses, canon } = x;
  const targetNorm = canon.norm(project.brand);
  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const parents = parentMap(x);
  const codes = project.reason_taxonomy;

  const fixed = [
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
    "total_recommendations",
  ];
  const headers = [...fixed, ...codes.map((c) => `arg: ${c}`)];
  const ws = wb.addWorksheet("Data");
  ws.addRow(headers);
  styleHeader(ws);
  ws.getColumn(6).width = 50;

  const cols: Record<string, string> = {};
  fixed.forEach((name, i) => (cols[name] = colLetter(i + 1)));
  const codeCols = new Map<string, string>();
  codes.forEach((c, i) => codeCols.set(c, colLetter(fixed.length + i + 1)));

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
      r.total_recommendations,
      ...codes.map((c) => (usedCodes.has(c) ? 1 : 0)),
    ]);
  }
  return { cols, codeCols };
}

/** Mentions sheet (long format) with dedup flags so distinct-answer counts
 * are a plain COUNTIFS — at brand and parent grain. */
function addMentionsSheet(
  wb: ExcelJS.Workbook,
  x: WorkbookInputs
): { cols: Record<string, string> } {
  const { prompts, responses, canon } = x;
  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const parents = parentMap(x);
  const ws = wb.addWorksheet("Mentions");
  const headers = [
    "response_id",
    "model",
    "prompt_code",
    "is_branded",
    "brand",
    "parent",
    "position",
    "framing",
    "first_of_brand_in_answer",
    "first_of_parent_in_answer",
  ];
  ws.addRow(headers);
  styleHeader(ws);
  const cols: Record<string, string> = {};
  headers.forEach((h, i) => (cols[h] = colLetter(i + 1)));

  for (const r of responses) {
    const p = promptById.get(r.prompt_id)!;
    const seenParent = new Set<string>();
    for (const m of answerMentions(x, r)) {
      const parent = parents.get(m.norm) ?? m.display;
      const firstParent = !seenParent.has(parent);
      seenParent.add(parent);
      ws.addRow([
        r.id,
        x.run.model,
        x.promptCode(r.prompt_id),
        p.theme === "branded" ? 1 : 0,
        m.display,
        parent,
        m.rank,
        m.framing,
        1, // rows are already deduped per (answer, brand)
        firstParent ? 1 : 0,
      ]);
    }
  }
  return { cols };
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

const pct1Fmt = "0.0%";

export async function buildScorecardWorkbook(
  x: WorkbookInputs
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addReadme(
    wb,
    `${x.project.brand} — AI visibility scorecard`,
    ceremonySections(
      x,
      `How visible the focus is in AI answers for ${x.project.category} — by LLM engine and in total, for any brand or parent company via the Focus dropdown.`,
      "the 95% confidence intervals (Wilson score), precomputed for every focus × engine on the hidden CI sheet and looked up live; and the Key Insights figures, generated from the same computation as the live formulas."
    )
  );
  const { cols } = addDataSheet(wb, x);
  const { cols: mc } = addMentionsSheet(wb, x);
  const D = (c: string) => `Data!${cols[c]}:${cols[c]}`;
  const M = (c: string) => `Mentions!${mc[c]}:${mc[c]}`;

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
  lists.state = "hidden";

  // ----- precomputed CI lookup (the [script] register) -----
  const engines = [x.run.model];
  const ci = wb.addWorksheet("CI");
  ci.addRow(["key", "ci"]);
  for (const focus of options) {
    for (const engine of [...engines, "TOTAL"]) {
      const s = computeFocusStats(x, focus, engine === "TOTAL" ? null : engine);
      const present = wilson(s.named, s.n);
      const pick = wilson(s.picks, s.n);
      ci.addRow([
        `${focus}|${engine}|present`,
        `${Math.round(present.low * 100)}%–${Math.round(present.high * 100)}%`,
      ]);
      ci.addRow([
        `${focus}|${engine}|pick`,
        `${Math.round(pick.low * 100)}%–${Math.round(pick.high * 100)}%`,
      ]);
    }
  }
  ci.state = "hidden";

  // ----- Scorecard: focus dropdown + engine × total table -----
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
    "← pick any brand or parent company; every table in this workbook re-computes for it";
  ws.getCell("D1").font = { italic: true, color: { argb: "FF6B7280" } };
  // Helper: parent name when a parent focus is selected, else blank.
  ws.getCell("H1").value = {
    formula: `IF(LEFT($B$1,${PARENT_PREFIX.length})="${PARENT_PREFIX}",MID($B$1,${PARENT_PREFIX.length + 1},255),"")`,
  };
  ws.getCell("H1").font = { color: { argb: "FFFFFFFF" } };

  ws.getRow(3).values = [
    "Engine",
    "Answers",
    "Named",
    "Named %",
    "95% CI",
    "First picks",
    "Pick %",
    "95% CI",
    "Avg position",
  ];
  styleHeader(ws, 3);
  ws.views = [{ state: "frozen", ySplit: 3 }];

  const namedF = (modelCrit: string) =>
    `IF($H$1<>"",COUNTIFS(${modelCrit ? `${M("model")},${modelCrit},` : ""}${M("parent")},$H$1,${M("first_of_parent_in_answer")},1,${M("is_branded")},0),COUNTIFS(${modelCrit ? `${M("model")},${modelCrit},` : ""}${M("brand")},$B$1,${M("first_of_brand_in_answer")},1,${M("is_branded")},0))`;
  const picksF = (modelCrit: string) =>
    `IF($H$1<>"",COUNTIFS(${modelCrit ? `${D("model")},${modelCrit},` : ""}${D("top_pick_parent")},$H$1,${D("is_branded")},0),COUNTIFS(${modelCrit ? `${D("model")},${modelCrit},` : ""}${D("top_pick")},$B$1,${D("is_branded")},0))`;
  const posF = (modelCrit: string) =>
    `IFERROR(IF($H$1<>"",AVERAGEIFS(${M("position")},${modelCrit ? `${M("model")},${modelCrit},` : ""}${M("parent")},$H$1,${M("first_of_parent_in_answer")},1,${M("is_branded")},0),AVERAGEIFS(${M("position")},${modelCrit ? `${M("model")},${modelCrit},` : ""}${M("brand")},$B$1,${M("first_of_brand_in_answer")},1,${M("is_branded")},0)),"—")`;

  const engineRows = [...engines.map((e) => ({ label: e, crit: `$A{r}` })), { label: "TOTAL", crit: "" }];
  engineRows.forEach((er, i) => {
    const rowN = 4 + i;
    const crit = er.crit ? er.crit.replace("{r}", String(rowN)) : "";
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
        formula: `IFERROR(VLOOKUP($B$1&"|"&$A${rowN}&"|present",CI!$A:$B,2,FALSE),"[script]")`,
      },
      { formula: picksF(crit) },
      { formula: `IFERROR(F${rowN}/B${rowN},"")` },
      {
        formula: `IFERROR(VLOOKUP($B$1&"|"&$A${rowN}&"|pick",CI!$A:$B,2,FALSE),"[script]")`,
      },
      { formula: posF(crit) },
    ];
    ws.getCell(`D${rowN}`).numFmt = pct1Fmt;
    ws.getCell(`G${rowN}`).numFmt = pct1Fmt;
    ws.getCell(`I${rowN}`).numFmt = "0.0";
    if (er.label === "TOTAL") {
      ws.getRow(rowN).font = { bold: true };
      ws.getCell(`D${rowN}`).fill = YELLOW_FILL;
      ws.getCell(`G${rowN}`).fill = YELLOW_FILL;
    }
  });
  const noteRow = 4 + engineRows.length + 1;
  ws.getCell(`A${noteRow}`).value =
    "Named = distinct unbranded answers naming the focus. Pick % = share of unbranded answers crowning it THE recommendation. CIs are [script]-computed Wilson intervals (see ReadMe).";
  ws.getCell(`A${noteRow}`).font = { italic: true, color: { argb: "FF6B7280" } };

  // ----- Prompt Grid: the picks themselves, one column per repeat -----
  const pg = wb.addWorksheet("Prompt Grid");
  pg.getCell("A1").value =
    "What the assistant actually picked — each row one prompt, each column one repeat of that prompt. [script]-free: every cell is a live lookup into Data.";
  pg.getCell("A1").font = { italic: true, color: { argb: "FF6B7280" } };
  const R = x.run.repeats;
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
    "badge",
  ];
  pg.getRow(3).values = gridHeader;
  styleHeader(pg, 3);
  pg.views = [{ state: "frozen", ySplit: 3, xSplit: 3 }];
  pg.getColumn(3).width = 52;
  for (let i = 0; i < R; i++) pg.getColumn(4 + i).width = 16;

  const firstPickCol = 4;
  const cAnswers = colLetter(firstPickCol + R);
  const cNamed = colLetter(firstPickCol + R + 1);
  const cNamedPct = colLetter(firstPickCol + R + 2);
  const cDecided = colLetter(firstPickCol + R + 3);
  const cPicks = colLetter(firstPickCol + R + 4);
  const cBadge = colLetter(firstPickCol + R + 5);

  const active = x.prompts.filter((p) => p.retired === 0);
  active.forEach((p, i) => {
    const rowN = 4 + i;
    const code = x.promptCode(p.id);
    const values: (string | number | { formula: string })[] = [
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
        formula: `IF(Scorecard!$H$1<>"",COUNTIFS(${M("prompt_code")},$A${rowN},${M("parent")},Scorecard!$H$1,${M("first_of_parent_in_answer")},1),COUNTIFS(${M("prompt_code")},$A${rowN},${M("brand")},Scorecard!$B$1,${M("first_of_brand_in_answer")},1))`,
      },
      {
        formula: `IFERROR(${cNamed}${rowN}/${cAnswers}${rowN},"")`,
      },
      {
        formula: `COUNTIFS(${D("prompt_code")},$A${rowN},${D("outcome")},"pick")`,
      },
      {
        formula: `IF(Scorecard!$H$1<>"",COUNTIFS(${D("prompt_code")},$A${rowN},${D("top_pick_parent")},Scorecard!$H$1),COUNTIFS(${D("prompt_code")},$A${rowN},${D("top_pick")},Scorecard!$B$1))`,
      },
      {
        formula: `IF(${cNamed}${rowN}=0,"ABSENT",IF(${cPicks}${rowN}*2>${cDecided}${rowN},"WINS","CONTESTED"))`,
      }
    );
    pg.getRow(rowN).values = values;
    pg.getCell(`${cNamedPct}${rowN}`).numFmt = "0%";
  });
  const lastRow = 3 + active.length;
  // Highlight pick cells matching the selected focus (brand selections).
  pg.addConditionalFormatting({
    ref: `D4:${colLetter(firstPickCol + R - 1)}${lastRow}`,
    rules: [
      {
        type: "expression",
        priority: 1,
        formulae: [`D4=Scorecard!$B$1`],
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
  addInsightsSheet(wb, x.insights);
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
      `Who owns the category's AI answers, on what arguments, and where ${x.project.brand} wins or loses.`,
      "the 95% confidence intervals (Wilson score) and the per-prompt consensus badge from the dashboard; everything they summarize is recomputable from these sheets."
    )
  );
  const { cols, codeCols } = addDataSheet(wb, x);
  const { cols: mc } = addMentionsSheet(wb, x);

  const D = (c: string) => `Data!${cols[c]}:${cols[c]}`;
  const M = (c: string) => `Mentions!${mc[c]}:${mc[c]}`;
  const unbr = `COUNTIFS(${D("is_branded")},0)`;
  const totalMentions = `COUNTIFS(${M("is_branded")},0)`;

  // Leaderboard
  const lb = wb.addWorksheet("Leaderboard");
  lb.addRow([
    "brand",
    "type",
    "answers_named",
    "mention_rate",
    "ci_95",
    "avg_position",
    "share_of_voice",
  ]);
  styleHeader(lb);
  lb.getColumn(1).width = 28;
  x.metrics.brands.slice(0, 25).forEach((b, i) => {
    const rowN = i + 2;
    lb.addRow([
      b.brand,
      b.isTarget ? "target" : b.isCompetitor ? "competitor" : "emerged",
      {
        formula: `COUNTIFS(${M("is_branded")},0,${M("brand")},$A${rowN},${M("first_of_brand_in_answer")},1)`,
      },
      { formula: `IFERROR(C${rowN}/${unbr},"")` },
      `${Math.round(b.ciLow * 100)}%–${Math.round(b.ciHigh * 100)}%`,
      {
        formula: `IFERROR(AVERAGEIFS(${M("position")},${M("is_branded")},0,${M("brand")},$A${rowN},${M("first_of_brand_in_answer")},1),"—")`,
      },
      {
        formula: `IFERROR(COUNTIFS(${M("is_branded")},0,${M("brand")},$A${rowN})/${totalMentions},"")`,
      },
    ]);
    lb.getCell(`D${rowN}`).numFmt = pct1Fmt;
    lb.getCell(`F${rowN}`).numFmt = "0.0";
    lb.getCell(`G${rowN}`).numFmt = pct1Fmt;
  });

  // TopPicks
  if (x.metrics.topPicks) {
    const tp = wb.addWorksheet("TopPicks");
    tp.addRow(["brand", "first_picks", "share_of_decided"]);
    styleHeader(tp);
    tp.getColumn(1).width = 28;
    const decided = `COUNTIFS(${D("is_branded")},0,${D("outcome")},"pick")`;
    x.metrics.topPicks.slice(0, 20).forEach((t, i) => {
      const rowN = i + 2;
      tp.addRow([
        t.brand,
        {
          formula: `COUNTIFS(${D("is_branded")},0,${D("top_pick")},$A${rowN})`,
        },
        { formula: `IFERROR(B${rowN}/${decided},"")` },
      ]);
      tp.getCell(`C${rowN}`).numFmt = pct1Fmt;
    });
  }

  // ReasonLift
  if (x.metrics.reasonLift) {
    const rl = wb.addWorksheet("ReasonLift");
    rl.addRow([
      "argument",
      "answers_using",
      "share_all",
      "share_in_target_wins",
      "lift_points",
    ]);
    styleHeader(rl);
    rl.getColumn(1).width = 30;
    const wins = `COUNTIFS(${D("is_branded")},0,${D("target_first_pick")},1)`;
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
        { formula: `IFERROR((D${rowN}-C${rowN})*100,"")` },
      ]);
      rl.getCell(`C${rowN}`).numFmt = pct1Fmt;
      rl.getCell(`D${rowN}`).numFmt = pct1Fmt;
      rl.getCell(`E${rowN}`).numFmt = "+0;-0;0";
    });
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

  // Negatives (verbatim — text, not formulas)
  if (x.metrics.negatives && x.metrics.negatives.length > 0) {
    const ng = wb.addWorksheet("Negatives");
    ng.addRow(["prompt", "verbatim quote", "coder's reading"]);
    styleHeader(ng);
    ng.getColumn(1).width = 45;
    ng.getColumn(2).width = 60;
    ng.getColumn(3).width = 60;
    for (const n of x.metrics.negatives) {
      const r = ng.addRow([n.promptText, n.quote, n.interpretation]);
      r.alignment = { wrapText: true, vertical: "top" };
    }
  }

  addKeyInsightsSheet(wb, x);
  addInsightsSheet(wb, x.insights);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
