import ExcelJS from "exceljs";
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
 * COUNTIFS/AVERAGEIFS over an embedded Data sheet, so any number can be
 * clicked and traced to the coded answers behind it. Confidence intervals
 * are the one precomputed exception (Wilson is unreadable as a native
 * formula) and are documented as such in each ReadMe.
 */

type Canonicalizer = ReturnType<typeof buildCanonicalizer>;

const BRAND_FILL: ExcelJS.FillPattern = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF5B7E92" }, // Resondex slate-blue
};

function colLetter(n: number): string {
  // 1 -> A, 27 -> AA
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function styleHeader(ws: ExcelJS.Worksheet) {
  const row = ws.getRow(1);
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = BRAND_FILL;
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function addReadme(
  wb: ExcelJS.Workbook,
  title: string,
  lines: string[]
): void {
  const ws = wb.addWorksheet("ReadMe");
  ws.getColumn(1).width = 110;
  ws.addRow([title]).font = { bold: true, size: 14 };
  ws.addRow([]);
  for (const line of lines) {
    const r = ws.addRow([line]);
    r.alignment = { wrapText: true, vertical: "top" };
  }
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
    `Traceability: every figure in these insights was substituted from the study's verified fact registry (${insights.verification.figuresSupplied} facts, ${insights.verification.placeholdersSubstituted} substitutions) and gate-checked against the dataset before shipping.`,
  ]).alignment = { wrapText: true, vertical: "top" };
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

/** The shared Data sheet: one row per coded answer, one 0/1 column per
 * reason code, everything the formulas count over. Returns column letters
 * keyed by logical name. */
function addDataSheet(
  wb: ExcelJS.Workbook,
  x: WorkbookInputs
): { cols: Record<string, string>; codeCols: Map<string, string>; rows: number } {
  const { project, prompts, responses, mentionsByResponse, canon } = x;
  const targetNorm = canon.norm(project.brand);
  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const codes = project.reason_taxonomy;

  const fixed = [
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
    "target_first_pick",
    "outcome",
    "total_recommendations",
  ];
  const headers = [...fixed, ...codes.map((c) => `arg: ${c}`)];
  const ws = wb.addWorksheet("Data");
  ws.addRow(headers);
  styleHeader(ws);
  ws.getColumn(4).width = 50;

  const cols: Record<string, string> = {};
  fixed.forEach((name, i) => (cols[name] = colLetter(i + 1)));
  const codeCols = new Map<string, string>();
  codes.forEach((c, i) => codeCols.set(c, colLetter(fixed.length + i + 1)));

  for (const r of responses) {
    const p = promptById.get(r.prompt_id)!;
    const ms = (mentionsByResponse.get(r.id) ?? []).filter(
      (m) => !canon.isRejected(m.brand)
    );
    // Canonicalize + dedup within the answer: best (lowest) rank per brand.
    const perBrand = new Map<string, { display: string; rank: number; framing: string }>();
    for (const m of ms) {
      const norm = canon.norm(m.brand);
      const prev = perBrand.get(norm);
      if (!prev || m.rank < prev.rank) {
        perBrand.set(norm, {
          display: canon.canonical(m.brand),
          rank: m.rank,
          framing: m.framing,
        });
      } else if (m.framing === "negative") {
        prev.framing = "negative";
      }
    }
    const ordered = [...perBrand.entries()].sort((a, b) => a[1].rank - b[1].rank);
    const tgt = perBrand.get(targetNorm);
    const tgtPos = ordered.findIndex(([n]) => n === targetNorm);
    const topPickNorm = r.top_pick_brand ? canon.norm(r.top_pick_brand) : null;
    const usedCodes = new Set(
      (r.reason_codes ?? "").split("|").map((c) => c.trim()).filter(Boolean)
    );
    ws.addRow([
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
      ordered[0]?.[1].display ?? null,
      ordered.length,
      topPickNorm ? canon.canonical(r.top_pick_brand!) : null,
      topPickNorm === targetNorm ? 1 : 0,
      r.outcome ?? "",
      r.total_recommendations,
      ...codes.map((c) => (usedCodes.has(c) ? 1 : 0)),
    ]);
  }
  return { cols, codeCols, rows: responses.length };
}

/** Mentions sheet (long format) with dedup flags so distinct-answer counts
 * are a plain COUNTIFS. */
function addMentionsSheet(
  wb: ExcelJS.Workbook,
  x: WorkbookInputs
): { cols: Record<string, string> } {
  const { prompts, responses, mentionsByResponse, canon, dictionary } = x;
  const promptById = new Map(prompts.map((p) => [p.id, p]));
  const parentByNorm = new Map(
    dictionary
      .filter((e) => e.status === "active")
      .map((e) => [
        e.canonical.trim().toLowerCase(),
        e.parent ?? e.display_name ?? e.canonical,
      ])
  );
  const ws = wb.addWorksheet("Mentions");
  const headers = [
    "response_id",
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
    const seenBrand = new Set<string>();
    const seenParent = new Set<string>();
    const ms = (mentionsByResponse.get(r.id) ?? [])
      .filter((m) => !canon.isRejected(m.brand))
      .sort((a, b) => a.rank - b.rank);
    for (const m of ms) {
      const norm = canon.norm(m.brand);
      const parent = parentByNorm.get(norm) ?? canon.canonical(m.brand);
      const firstBrand = !seenBrand.has(norm);
      const firstParent = !seenParent.has(parent);
      seenBrand.add(norm);
      seenParent.add(parent);
      ws.addRow([
        r.id,
        x.promptCode(r.prompt_id),
        p.theme === "branded" ? 1 : 0,
        canon.canonical(m.brand),
        parent,
        m.rank,
        m.framing,
        firstBrand ? 1 : 0,
        firstParent ? 1 : 0,
      ]);
    }
  }
  return { cols };
}

const pctFmt = "0%";
const pct1Fmt = "0.0%";

export async function buildScorecardWorkbook(
  x: WorkbookInputs
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addReadme(wb, `${x.project.brand} — AI visibility scorecard`, [
    "What this answers: how visible the focus brand is in AI answers for the category, at a glance.",
    "Why live formulas: every rate on the Scorecard and PromptGrid sheets is a COUNTIFS/AVERAGEIFS over the Data sheet in this file. Click any number, read its formula, trace it to the coded answers it counts. Nothing is pasted in.",
    "The Data sheet: one row per sampled answer. is_branded=1 rows are the branded probes — headline rates exclude them (naming the brand guarantees a mention). target_first_pick=1 means the answer crowned the focus brand as THE recommendation. The 'arg:' columns are 0/1 flags for each reason-code argument the answer used.",
    "The one exception: 95% confidence intervals are precomputed values (Wilson score intervals — the native-formula form is unreadable). The rates they attach to are live formulas; the method is documented in 06_methodology.",
    "Insights: the numbered Insights sheet is generated from the study's verified fact registry — every figure is substituted from computed values and gate-checked against this dataset.",
  ]);
  const { cols, rows } = addDataSheet(wb, x);
  void rows;

  const ws = wb.addWorksheet("Scorecard");
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 18;
  ws.getColumn(4).width = 80;
  ws.addRow(["metric", "value", "95% CI", "what it captures"]);
  styleHeader(ws);

  const D = (c: string) => `Data!${cols[c]}:${cols[c]}`;
  const unbr = `COUNTIFS(${D("is_branded")},0)`;
  const t = x.metrics.brands.find((b) => b.isTarget)!;
  const ciStr = (lo: number, hi: number) =>
    `${Math.round(lo * 100)}%–${Math.round(hi * 100)}%`;

  const rowsSpec: [string, string | number | { formula: string }, string, string][] = [
    [
      "Answers sampled (unbranded)",
      { formula: unbr },
      "",
      "Branded probes excluded from every headline rate",
    ],
    [
      "Representation",
      { formula: `COUNTIFS(${D("is_branded")},0,${D("target_named")},1)/${unbr}` },
      ciStr(t.ciLow, t.ciHigh),
      `Any mention of ${x.project.brand} in an unbranded answer`,
    ],
    ...(x.metrics.firstPick
      ? ([
          [
            "First pick",
            {
              formula: `COUNTIFS(${D("is_branded")},0,${D("target_first_pick")},1)/${unbr}`,
            },
            ciStr(x.metrics.firstPick.ciLow, x.metrics.firstPick.ciHigh),
            `The answer crowns ${x.project.brand} as THE recommendation`,
          ],
        ] as [string, { formula: string }, string, string][])
      : []),
    [
      "First-named",
      {
        formula: `COUNTIFS(${D("is_branded")},0,${D("target_first_named")},1)/${unbr}`,
      },
      "",
      "The focus brand is the first brand in the answer",
    ],
    [
      "Average position",
      {
        formula: `IFERROR(AVERAGEIFS(${D("target_position")},${D("is_branded")},0,${D("target_named")},1),"—")`,
      },
      "",
      "Mean rank of first appearance, when named",
    ],
    [
      "Negative framings",
      {
        formula: `COUNTIFS(${D("is_branded")},0,${D("target_negative")},1)`,
      },
      "",
      "Unbranded answers framing the focus brand negatively",
    ],
    [
      "Decided answers",
      { formula: `COUNTIFS(${D("is_branded")},0,${D("outcome")},"pick")` },
      "",
      "Answers that committed to a recommendation",
    ],
  ];
  for (const [metric, value, ci, note] of rowsSpec) {
    const r = ws.addRow([metric, value, ci, note]);
    if (
      metric !== "Answers sampled (unbranded)" &&
      metric !== "Negative framings" &&
      metric !== "Decided answers"
    ) {
      r.getCell(2).numFmt = metric === "Average position" ? "0.0" : pct1Fmt;
    }
  }

  // PromptGrid: rows = prompts, all counts live.
  const pg = wb.addWorksheet("PromptGrid");
  pg.addRow([
    "code",
    "theme",
    "prompt",
    "answers",
    "target_named",
    "named_rate",
    "first_picks",
    "avg_position",
    "badge",
  ]);
  styleHeader(pg);
  pg.getColumn(3).width = 70;
  const active = x.prompts.filter((p) => p.retired === 0);
  active.forEach((p, i) => {
    const rowN = i + 2;
    const code = x.promptCode(p.id);
    const g = x.metrics.promptGrid?.find((z) => z.promptId === p.id);
    pg.addRow([
      code,
      p.theme,
      p.text,
      { formula: `COUNTIFS(${D("prompt_code")},$A${rowN})` },
      {
        formula: `COUNTIFS(${D("prompt_code")},$A${rowN},${D("target_named")},1)`,
      },
      {
        formula: `IFERROR(E${rowN}/D${rowN},"")`,
      },
      {
        formula: `COUNTIFS(${D("prompt_code")},$A${rowN},${D("target_first_pick")},1)`,
      },
      {
        formula: `IFERROR(AVERAGEIFS(${D("target_position")},${D("prompt_code")},$A${rowN},${D("target_named")},1),"—")`,
      },
      g?.badge ?? "",
    ]);
    pg.getCell(`F${rowN}`).numFmt = pctFmt;
    pg.getCell(`H${rowN}`).numFmt = "0.0";
  });

  addInsightsSheet(wb, x.insights);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export async function buildAnalysisWorkbook(
  x: WorkbookInputs
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  addReadme(wb, `${x.project.brand} — AI visibility analysis workbook`, [
    "What this answers: who owns the category's AI answers, on what arguments, and where the focus brand wins or loses.",
    "Why live formulas: every aggregate on Leaderboard, TopPicks, ReasonLift, Positions, and Parents is a COUNTIFS/AVERAGEIFS over the embedded Data and Mentions sheets. Click a number to trace it.",
    "Mentions sheet: one row per brand mention (canonicalized by the study dictionary; rejected names excluded). first_of_brand_in_answer=1 marks the first mention of a brand within one answer — distinct-answer counts filter on it, share-of-voice counts use all rows. first_of_parent_in_answer does the same at parent-company grain.",
    "Precomputed exceptions, documented: 95% confidence intervals (Wilson score) and the per-prompt consensus badge are values, not formulas; everything they summarize is recomputable from these sheets.",
  ]);
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
  pos.addRow([
    "#1",
    { formula: `COUNTIFS(${D("is_branded")},0,${D("target_position")},1)` },
  ]);
  pos.addRow([
    "#2",
    { formula: `COUNTIFS(${D("is_branded")},0,${D("target_position")},2)` },
  ]);
  pos.addRow([
    "#3",
    { formula: `COUNTIFS(${D("is_branded")},0,${D("target_position")},3)` },
  ]);
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

  addInsightsSheet(wb, x.insights);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
