import PptxGenJS from "pptxgenjs";
import { dictionaryRoles } from "./metrics";
import { answerMentions, parentMap, type WorkbookInputs } from "./workbooks";
import type { ProjectTrend } from "../types";

/**
 * The summary deck — third renderer of the same verified objects the
 * dashboard and workbooks display. The deck authors nothing: metrics come
 * from computeRunMetrics, prose from the gate-verified insights bundle,
 * per-prompt verdicts are composed deterministically from computed fields.
 * Variants: "standard" (deterministic verdicts only) and "ai_beta" (adds
 * narrative captions from the verified insights bundle to analysis slides).
 */

export type DeckVariant = "standard" | "ai_beta";

export interface DeckInputs extends WorkbookInputs {
  trend: ProjectTrend | null;
  variant: DeckVariant;
}

// Resondex visual system
const SLATE = "5B7E92";
const INK = "1F2937";
const INK2 = "4B5563";
const INK3 = "9CA3AF";
const PAPER = "FFFFFF";
const SOFT = "EEF3F6";
const HIGHLIGHT = "F9C74F";
const WIN = "70AD47";
const CONTESTED = "FFC000";
const ABSENT = "E06666";
const FONT = "Inter";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`;

interface PromptPage {
  code: string;
  theme: string;
  text: string;
  picks: string[]; // per repeat, "—" for no pick
  answers: number;
  decided: number;
  named: number;
  avgPos: number | null;
  focusPicks: number;
  modal: string | null;
  modalCount: number;
  stability: number | null;
  badge: "WINS" | "CONTESTED" | "ABSENT";
  quote: string | null;
  verdict: string;
}

/** Everything the prompt pages need, computed once from the coded answers. */
function buildPromptPages(x: DeckInputs): PromptPage[] {
  const targetNorm = x.canon.norm(x.project.brand);
  const active = x.prompts.filter((p) => p.retired === 0);
  const pages: PromptPage[] = [];
  for (const p of active) {
    const rows = x.responses
      .filter((r) => r.prompt_id === p.id)
      .sort((a, b) => a.repeat_idx - b.repeat_idx);
    const picks = rows.map((r) =>
      r.top_pick_brand ? x.canon.canonical(r.top_pick_brand) : "—"
    );
    const decidedRows = rows.filter((r) => r.outcome === "pick");
    const tally = new Map<string, number>();
    for (const r of decidedRows) {
      if (!r.top_pick_brand) continue;
      const d = x.canon.canonical(r.top_pick_brand);
      tally.set(d, (tally.get(d) ?? 0) + 1);
    }
    const modalEntry = [...tally.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0];
    let named = 0;
    let posSum = 0;
    let focusPicks = 0;
    for (const r of rows) {
      const ms = answerMentions(x, r);
      const idx = ms.findIndex((m) => m.norm === targetNorm);
      if (idx >= 0) {
        named += 1;
        posSum += idx + 1;
      }
      if (r.top_pick_brand && x.canon.norm(r.top_pick_brand) === targetNorm) {
        focusPicks += 1;
      }
    }
    const stability =
      decidedRows.length > 0 && modalEntry
        ? modalEntry[1] / decidedRows.length
        : null;
    const badge: PromptPage["badge"] =
      named === 0
        ? "ABSENT"
        : focusPicks * 2 > decidedRows.length
          ? "WINS"
          : "CONTESTED";
    const quote =
      rows.map((r) => r.focus_quote).find((q): q is string => Boolean(q)) ??
      null;
    const avgPos = named > 0 ? posSum / named : null;
    const brand = x.project.brand;
    let verdict: string;
    if (badge === "WINS") {
      verdict = `${brand} wins this prompt — picked in ${focusPicks} of ${decidedRows.length} decided answers${stability !== null ? ` (consistency ${pct(stability)})` : ""}.`;
    } else if (badge === "ABSENT") {
      verdict = `${brand} is absent — never named across ${rows.length} answers${modalEntry ? `; ${modalEntry[0]} leads with ${modalEntry[1]} picks` : ""}.`;
    } else {
      verdict = `Contested — ${modalEntry ? `${modalEntry[0]} takes ${modalEntry[1]} of ${decidedRows.length} decided answers` : "no brand holds a majority"}; ${brand} takes ${focusPicks}. Named in ${named} of ${rows.length}${avgPos ? ` at average position #${avgPos.toFixed(1)}` : ""}.`;
    }
    pages.push({
      code: x.promptCode(p.id),
      theme: p.theme.replace("_", " "),
      text: p.text,
      picks,
      answers: rows.length,
      decided: decidedRows.length,
      named,
      avgPos,
      focusPicks,
      modal: modalEntry?.[0] ?? null,
      modalCount: modalEntry?.[1] ?? 0,
      stability,
      badge,
      quote,
      verdict,
    });
  }
  const order = { WINS: 0, CONTESTED: 1, ABSENT: 2 };
  return pages.sort(
    (a, b) => order[a.badge] - order[b.badge] || a.code.localeCompare(b.code)
  );
}

const badgeColor = (b: PromptPage["badge"]) =>
  b === "WINS" ? WIN : b === "CONTESTED" ? CONTESTED : ABSENT;

export async function buildStudyDeck(x: DeckInputs): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: 13.33, height: 7.5 });
  pptx.layout = "WIDE";
  const brand = x.project.brand;
  const stamp = (x.run.completed_at ?? x.run.created_at).slice(0, 10);
  const isBeta = x.variant === "ai_beta";
  const target = x.metrics.brands.find((b) => b.isTarget)!;
  const pages = buildPromptPages(x);
  const insights = x.insights;

  // Narrative captions (beta): gate-verified sentences from the insights
  // bundle, matched to the slide they describe. Never freehand.
  const narrative = (key: string): string | null => {
    if (!isBeta || !insights) return null;
    const section = insights.sections.find((s) => s.key === key);
    return section?.insights[0] ?? null;
  };

  const addFooter = (slide: PptxGenJS.Slide, page: string) => {
    slide.addText(
      `${brand} AI visibility study · ${stamp} · Answerpoll by Resondex${isBeta ? " · AI narrative (beta)" : ""}`,
      { x: 0.5, y: 7.08, w: 10, h: 0.3, fontSize: 9, color: INK3, fontFace: FONT }
    );
    slide.addText(page, {
      x: 12.3, y: 7.08, w: 0.6, h: 0.3, fontSize: 9, color: INK3, align: "right", fontFace: FONT,
    });
  };

  let pageNo = 0;
  const newSlide = (title?: string, subtitle?: string) => {
    pageNo += 1;
    const s = pptx.addSlide();
    s.background = { color: PAPER };
    if (title) {
      s.addText(title, {
        x: 0.5, y: 0.32, w: 12.3, h: 0.55, fontSize: 26, bold: true, color: INK, fontFace: FONT,
      });
      s.addShape("rect", { x: 0.52, y: 0.95, w: 0.85, h: 0.06, fill: { color: SLATE } });
    }
    if (subtitle) {
      s.addText(subtitle, {
        x: 0.5, y: 1.05, w: 12.3, h: 0.4, fontSize: 12.5, color: INK2, fontFace: FONT,
      });
    }
    addFooter(s, String(pageNo));
    return s;
  };

  const addNarrative = (slide: PptxGenJS.Slide, key: string) => {
    const text = narrative(key);
    if (!text) return;
    slide.addShape("rect", { x: 0.5, y: 6.3, w: 12.33, h: 0.62, fill: { color: SOFT } });
    slide.addText(
      [
        { text: "AI reading (verified): ", options: { bold: true, color: SLATE } },
        { text, options: { color: INK2 } },
      ],
      { x: 0.65, y: 6.33, w: 12.05, h: 0.56, fontSize: 11.5, fontFace: FONT, valign: "middle" }
    );
  };

  // ---------- 1. cover ----------
  {
    pageNo += 1;
    const s = pptx.addSlide();
    s.background = { color: SLATE };
    s.addText(`${brand} — AI visibility study`, {
      x: 0.8, y: 2.5, w: 11.7, h: 1.1, fontSize: 40, bold: true, color: PAPER, fontFace: FONT,
    });
    s.addText(
      `${x.project.category}${x.project.audience ? ` · ${x.project.audience}` : ""}`,
      { x: 0.8, y: 3.6, w: 11.7, h: 0.5, fontSize: 18, color: "DCE6EC", fontFace: FONT }
    );
    s.addText(
      `${x.metrics.totalResponses} coded answers · ${x.run.model} · ${stamp} · run ${x.run.id.slice(0, 8)}`,
      { x: 0.8, y: 4.25, w: 11.7, h: 0.4, fontSize: 13, color: "DCE6EC", fontFace: FONT }
    );
    s.addText("Answerpoll by Resondex — data made decisive.", {
      x: 0.8, y: 6.6, w: 8, h: 0.4, fontSize: 12, color: "DCE6EC", fontFace: FONT,
    });
    if (isBeta) {
      s.addShape("roundRect", { x: 10.6, y: 0.5, w: 2.2, h: 0.5, fill: { color: HIGHLIGHT }, rectRadius: 0.08 });
      s.addText("AI narrative · beta", {
        x: 10.6, y: 0.5, w: 2.2, h: 0.5, fontSize: 12, bold: true, color: INK, align: "center", valign: "middle", fontFace: FONT,
      });
    }
  }

  // ---------- 2. objective & method ----------
  {
    const s = newSlide("Objective and method", "What was measured, and why every number carries an interval");
    const unbrandedPrompts = x.prompts.filter((p) => p.retired === 0 && p.theme !== "branded").length;
    const rows: PptxGenJS.TableRow[] = [
      ["Question", `When buyers ask AI assistants about ${x.project.category}, how often is ${brand} named — and how often is it THE pick?`],
      ["Sample", `${x.metrics.totalResponses} answers = ${x.prompts.filter((p) => p.retired === 0).length} prompts × ${x.run.repeats} repeats on ${x.run.model}. ${unbrandedPrompts} unbranded prompts drive every headline rate.`],
      ["Prompt battery", "Calibrated to 1,006 verified commercial prompts from real AI conversations (WildChat corpus) — length, register, and question-type mix match how buyers actually ask."],
      ["Repeats and intervals", "Each prompt is asked repeatedly: a single AI answer is an anecdote, a distribution is a measurement. Every rate carries a 95% Wilson interval."],
      ["Coding", "Every answer is parsed for brands named (in order, with framing), the crowned pick, the arguments used, and a verbatim quote about the focus brand. Dictionary-normalized; fully recomputable from the shipped dataset."],
      ["Data lock", `Run ${x.run.id.slice(0, 8)}, completed ${x.run.completed_at ?? stamp}, dictionary v${x.metrics.dictionaryVersion}.`],
    ].map(([k, v]) => [
      { text: k, options: { bold: true, color: SLATE, fontSize: 12, fontFace: FONT, valign: "top" as const } },
      { text: v, options: { color: INK2, fontSize: 12, fontFace: FONT, valign: "top" as const } },
    ]);
    s.addTable(rows, { x: 0.5, y: 1.55, w: 12.3, colW: [2.2, 10.1], border: { type: "solid", color: "E5E7EB", pt: 0.5 }, autoPage: false });
  }

  // ---------- 3. how to read ----------
  {
    const s = newSlide("How to read this deck");
    const items: [string, string, string][] = [
      [WIN, "WINS", `${brand} takes a strict majority of the prompt's decided answers.`],
      [CONTESTED, "CONTESTED", "Named but not winning — the answers disagree, which means the prompt is movable."],
      [ABSENT, "ABSENT", `${brand} is never named for the prompt — the conversation happens without it.`],
    ];
    items.forEach(([color, label, desc], i) => {
      const y = 1.7 + i * 0.75;
      s.addShape("roundRect", { x: 0.6, y, w: 1.7, h: 0.5, fill: { color }, rectRadius: 0.06 });
      s.addText(label, { x: 0.6, y, w: 1.7, h: 0.5, align: "center", valign: "middle", bold: true, color: PAPER, fontSize: 13, fontFace: FONT });
      s.addText(desc, { x: 2.5, y, w: 10.2, h: 0.5, valign: "middle", color: INK2, fontSize: 13, fontFace: FONT });
    });
    s.addText(
      [
        { text: "Intervals: ", options: { bold: true, color: INK } },
        { text: "every rate shows a 95% confidence range. Two rates are only different when their ranges do not overlap — a visible gap inside overlapping intervals is sampling noise, and this deck says so rather than briefing it as a lead. ", options: { color: INK2 } },
        { text: "\n\nConsistency: ", options: { bold: true, color: INK } },
        { text: "repeats of the same question to the same engine. Disagreement across repeats is instability in the assistant's answer — and the unstable prompts are the winnable ones.", options: { color: INK2 } },
      ],
      { x: 0.6, y: 4.3, w: 12.1, h: 1.8, fontSize: 13, fontFace: FONT }
    );
  }

  // ---------- 4. executive summary ----------
  if (insights) {
    const s = newSlide("Executive summary", "Every figure below was substituted from the study's verified fact registry");
    const head = insights.sections.find((sec) => sec.key === "scorecard" || sec.title === "Headline");
    const lines = (head?.insights ?? []).slice(0, 4);
    lines.forEach((t, i) => {
      s.addText(
        [
          { text: `${i + 1}  `, options: { bold: true, color: SLATE, fontSize: 20 } },
          { text: t, options: { color: INK, fontSize: 15 } },
        ],
        { x: 0.7, y: 1.75 + i * 1.05, w: 11.9, h: 1.0, fontFace: FONT, valign: "top" }
      );
    });
  }

  // ---------- 5. scorecard tiles ----------
  {
    const s = newSlide("Where we stand", `${x.metrics.unbrandedResponses} unbranded answers · ${x.run.model}`);
    const tiles: [string, string, string][] = [
      ["Named", pct(target.mentionRate), `95% CI ${pct(target.ciLow)}–${pct(target.ciHigh)}`],
      ...(x.metrics.firstPick
        ? ([["First pick", pct(x.metrics.firstPick.rate), `95% CI ${pct(x.metrics.firstPick.ciLow)}–${pct(x.metrics.firstPick.ciHigh)}`]] as [string, string, string][])
        : []),
      ["Average position", target.avgRank ? `#${target.avgRank.toFixed(1)}` : "—", "when named"],
      ["Share of voice", pct(target.shareOfVoice), "of all brand mentions"],
    ];
    const w = 2.9;
    tiles.forEach(([label, value, sub], i) => {
      const xPos = 0.55 + i * (w + 0.25);
      s.addShape("roundRect", { x: xPos, y: 2.0, w, h: 2.6, fill: { color: SOFT }, rectRadius: 0.06 });
      s.addText(label.toUpperCase(), { x: xPos + 0.25, y: 2.25, w: w - 0.5, h: 0.35, fontSize: 11, bold: true, color: INK3, fontFace: FONT });
      s.addText(value, { x: xPos + 0.25, y: 2.7, w: w - 0.5, h: 1.0, fontSize: 44, bold: true, color: SLATE, fontFace: FONT });
      s.addText(sub, { x: xPos + 0.25, y: 3.85, w: w - 0.5, h: 0.5, fontSize: 11.5, color: INK2, fontFace: FONT });
    });
    addNarrative(s, "scorecard");
  }

  // ---------- 6. funnel ----------
  {
    const named = target.mentionCount;
    const n = x.metrics.unbrandedResponses;
    let top3 = 0;
    const targetNorm = x.canon.norm(brand);
    for (const r of x.responses) {
      const p = x.prompts.find((pp) => pp.id === r.prompt_id);
      if (!p || p.theme === "branded") continue;
      const ms = answerMentions(x, r);
      const idx = ms.findIndex((m) => m.norm === targetNorm);
      if (idx >= 0 && idx < 3) top3 += 1;
    }
    const picks = x.metrics.firstPick?.count ?? 0;
    const s = newSlide("The visibility funnel", "Named → shortlisted → chosen. The drop between stages says what kind of problem you have.");
    const stages: [string, number, string][] = [
      ["Named anywhere", named, "the reach"],
      ["In the top 3", top3, "the shortlist"],
      ["The pick", picks, "the win"],
    ];
    stages.forEach(([label, k, sub], i) => {
      const wMax = 10.6;
      const wBar = Math.max((k / Math.max(named, 1)) * wMax, 0.8);
      const y = 1.9 + i * 1.35;
      s.addShape("rect", { x: 1.0, y, w: wBar, h: 0.85, fill: { color: i === 2 ? SLATE : "8FA9B9" } });
      s.addText(`${label} — ${k} of ${n} (${pct(k / Math.max(n, 1))})`, {
        x: 1.15, y, w: 10, h: 0.85, valign: "middle", fontSize: 15, bold: true, color: PAPER, fontFace: FONT,
      });
      s.addText(sub, { x: 11.75, y, w: 1.4, h: 0.85, valign: "middle", fontSize: 11, color: INK3, fontFace: FONT });
    });
    const gapNote =
      top3 < named && picks <= top3
        ? `The steepest drop is ${named - top3 >= top3 - picks ? "Named → Top-3: a position problem — the brand is in the conversation and buried in the list" : "Top-3 → Pick: a persuasion problem — shortlisted and not chosen"}.`
        : "";
    if (gapNote) s.addText(gapNote, { x: 1.0, y: 5.9, w: 11.3, h: 0.5, fontSize: 13, italic: true, color: INK2, fontFace: FONT });
  }

  // ---------- 7. leaderboard chart ----------
  {
    const s = newSlide("The brand landscape", "Share of unbranded answers naming each brand — intervals in the workbook; overlapping intervals read as parity");
    const top = x.metrics.brands.slice(0, 10);
    s.addChart("bar", [
      {
        name: "Named %",
        labels: top.map((b) => b.brand),
        values: top.map((b) => Math.round(b.mentionRate * 1000) / 10),
      },
    ], {
      x: 0.5, y: 1.55, w: 12.3, h: 4.6,
      barDir: "bar",
      chartColors: top.map((b) => (b.isTarget ? SLATE : "C3CFD8")),
      chartColorsOpacity: 100,
      catAxisLabelFontSize: 11,
      valAxisLabelFontSize: 10,
      valAxisMaxVal: 100,
      dataLabelFormatCode: '0.0"%"',
      showValue: true,
      dataLabelFontSize: 10,
      valAxisHidden: true,
      catAxisLabelFontFace: FONT,
      dataLabelFontFace: FONT,
    });
    addNarrative(s, "leaderboard");
  }

  // ---------- 8. parents ----------
  if (x.metrics.parentRollup && x.metrics.parentRollup.length > 0) {
    const s = newSlide("By parent company", "Reach at parent grain — an answer naming any of a parent's brands counts once. Independents are their own parent.");
    const top = x.metrics.parentRollup.slice(0, 10);
    s.addChart("bar", [
      {
        name: "Reach",
        labels: top.map((p) => p.parent),
        values: top.map((p) => Math.round(p.mentionRate * 1000) / 10),
      },
    ], {
      x: 0.5, y: 1.55, w: 12.3, h: 4.3,
      barDir: "bar",
      chartColors: top.map((p) => (p.includesTarget ? SLATE : "C3CFD8")),
      dataLabelFormatCode: '0.0"%"',
      showValue: true,
      dataLabelFontSize: 10,
      valAxisHidden: true,
      catAxisLabelFontSize: 11,
      catAxisLabelFontFace: FONT,
      dataLabelFontFace: FONT,
    });
    const multi = top.filter((p) => p.brands.length > 1);
    if (multi.length > 0) {
      s.addText(
        multi.map((p) => `${p.parent}: ${p.brands.join(", ")}`).join("  ·  "),
        { x: 0.5, y: 5.95, w: 12.3, h: 0.4, fontSize: 10.5, color: INK3, fontFace: FONT }
      );
    }
    addNarrative(s, "parents");
  }

  // ---------- 8b. by engine ----------
  if (x.metrics.engines && x.metrics.engines.length > 1) {
    const s = newSlide(
      "The same question, four advisors",
      "Each engine answered the identical battery; coding is one fixed coder, so these gaps are the engines themselves"
    );
    const header: PptxGenJS.TableRow = ["Engine", "Answers", "Named", "95% CI", "First pick", "Avg position"].map((h) => ({
      text: h, options: { bold: true, color: PAPER, fill: { color: SLATE }, fontSize: 12, fontFace: FONT },
    }));
    const body: PptxGenJS.TableRow[] = x.metrics.engines.map((e) => [
      { text: e.model, options: { fontSize: 12.5, color: INK, fontFace: FONT } },
      { text: String(e.answers), options: { fontSize: 12.5, color: INK2, align: "right" as const, fontFace: FONT } },
      { text: pct(e.namedRate), options: { fontSize: 12.5, bold: true, color: INK, align: "right" as const, fontFace: FONT } },
      { text: `${pct(e.ciLow)}–${pct(e.ciHigh)}`, options: { fontSize: 11.5, color: INK3, align: "right" as const, fontFace: FONT } },
      { text: pct(e.pickRate), options: { fontSize: 12.5, bold: true, color: INK, align: "right" as const, fontFace: FONT } },
      { text: e.avgPosition ? `#${e.avgPosition.toFixed(1)}` : "—", options: { fontSize: 12.5, color: INK2, align: "right" as const, fontFace: FONT } },
    ]);
    s.addTable([header, ...body], { x: 0.5, y: 1.7, w: 12.3, colW: [3.4, 1.7, 1.8, 2.2, 1.8, 1.4], border: { type: "solid", color: "E5E7EB", pt: 0.5 } });
    s.addText(
      "Assistants are not interchangeable: the same buyer question routed to a different engine can produce a different shortlist. Coverage across engines is coverage of the market.",
      { x: 0.5, y: 5.6, w: 12.3, h: 0.6, fontSize: 12.5, italic: true, color: INK2, fontFace: FONT }
    );
  }

  // ---------- 8c. source landscape ----------
  if (x.metrics.sources && x.metrics.sources.domains.length > 0) {
    const src = x.metrics.sources;
    const s = newSlide(
      "Where grounded answers get their facts",
      `Grounded engines cite their sources - ${src.citedAnswers} answers carried citations. These sites are writing the AI's script.`
    );
    const top = src.domains.slice(0, 10);
    s.addChart("bar", [
      {
        name: "Citing answers",
        labels: top.map((d) => (d.brand ? `${d.domain} (owned: ${d.brand})` : d.domain)),
        values: top.map((d) => d.answers),
      },
    ], {
      x: 0.5, y: 1.55, w: 12.3, h: 4.3,
      barDir: "bar",
      chartColors: top.map((d) => (d.brand ? SLATE : "C3CFD8")),
      showValue: true,
      dataLabelFontSize: 10,
      valAxisHidden: true,
      catAxisLabelFontSize: 10.5,
      catAxisLabelFontFace: FONT,
      dataLabelFontFace: FONT,
    });
    s.addText(
      "Dark bars are brand-owned domains (owned media); light bars are third-party sites - reviews, comparisons, communities - the earned surface where content work changes what the AI says. Full domain table and per-answer evidence in the analysis workbook.",
      { x: 0.5, y: 6.0, w: 12.3, h: 0.7, fontSize: 12, italic: true, color: INK2, fontFace: FONT }
    );
    addNarrative(s, "sources");
  }

  // ---------- 9. who wins instead ----------
  if (x.metrics.topPicks && x.metrics.topPicks.length > 0) {
    const s = newSlide(
      "Who wins instead",
      `The brand each answer actually crowned — over ${x.metrics.outcomes?.pick ?? 0} decided answers`
    );
    const top = x.metrics.topPicks.slice(0, 8);
    s.addChart("bar", [
      {
        name: "First picks",
        labels: top.map((t) => t.brand),
        values: top.map((t) => t.picks),
      },
    ], {
      x: 0.5, y: 1.55, w: 12.3, h: 4.6,
      barDir: "bar",
      chartColors: top.map((t) => (t.isTarget ? SLATE : "C3CFD8")),
      showValue: true,
      dataLabelFontSize: 10,
      valAxisHidden: true,
      catAxisLabelFontSize: 11,
      catAxisLabelFontFace: FONT,
      dataLabelFontFace: FONT,
    });
    addNarrative(s, "top_picks");
  }

  // ---------- 10. arguments ----------
  if (x.metrics.reasonLift && x.metrics.reasonLift.length > 0) {
    const s = newSlide(
      "The arguments that decide it",
      "Share of answers using each argument: in wins, when considered-but-lost, and when absent"
    );
    const sorted = [...x.metrics.reasonLift].sort((a, b) => b.lift - a.lift);
    const shown = [...sorted.slice(0, 4), ...sorted.slice(-3)];
    const header: PptxGenJS.TableRow = ["Argument", "All answers", "In wins", "Considered, lost", "Lift"].map((h) => ({
      text: h, options: { bold: true, color: PAPER, fill: { color: SLATE }, fontSize: 12, fontFace: FONT },
    }));
    const body: PptxGenJS.TableRow[] = shown.map((r) => [
      { text: r.code, options: { fontSize: 12, color: INK, fontFace: FONT } },
      { text: pct(r.shareAll), options: { fontSize: 12, color: INK2, fontFace: FONT, align: "right" as const } },
      { text: pct(r.shareWins), options: { fontSize: 12, color: INK2, fontFace: FONT, align: "right" as const } },
      { text: pct(r.shareAbsent), options: { fontSize: 12, color: INK2, fontFace: FONT, align: "right" as const } },
      { text: `${r.lift >= 0 ? "+" : ""}${Math.round(r.lift * 100)} pts`, options: { fontSize: 12, bold: true, color: r.lift >= 0 ? WIN : ABSENT, fontFace: FONT, align: "right" as const } },
    ]);
    s.addTable([header, ...body], { x: 0.5, y: 1.6, w: 12.3, colW: [4.9, 1.85, 1.85, 1.85, 1.85], border: { type: "solid", color: "E5E7EB", pt: 0.5 } });
    const worst = sorted[sorted.length - 1];
    s.addShape("rect", { x: 0.5, y: 5.35, w: 12.3, h: 0.75, fill: { color: "FDECEC" } });
    s.addText(
      [
        { text: "The kill-shot: ", options: { bold: true, color: ABSENT } },
        { text: `"${worst.code}" runs ${Math.abs(Math.round(worst.lift * 100))} pts below its overall share in ${brand} wins — when answers weigh it, ${brand} loses. Full three-way table in the analysis workbook.`, options: { color: INK2 } },
      ],
      { x: 0.7, y: 5.4, w: 12.0, h: 0.65, fontSize: 12.5, fontFace: FONT, valign: "middle" }
    );
    addNarrative(s, "arguments");
  }

  // ---------- 11. stability ----------
  {
    const bands = { Settled: 0, Leaning: 0, "Coin-flip": 0, "No pick": 0 };
    for (const p of pages) {
      if (p.decided === 0) bands["No pick"] += 1;
      else if ((p.stability ?? 0) >= 0.8) bands.Settled += 1;
      else if ((p.stability ?? 0) > 0.5) bands.Leaning += 1;
      else bands["Coin-flip"] += 1;
    }
    const s = newSlide(
      "How settled the answers are",
      "Consistency across repeats of the same question — no single-shot audit can see this"
    );
    const entries = Object.entries(bands);
    entries.forEach(([label, count], i) => {
      const xPos = 0.55 + i * 3.15;
      const hl = label === "Coin-flip";
      s.addShape("roundRect", { x: xPos, y: 1.7, w: 2.9, h: 1.7, fill: { color: hl ? HIGHLIGHT : SOFT }, rectRadius: 0.06 });
      s.addText(String(count), { x: xPos, y: 1.85, w: 2.9, h: 0.9, fontSize: 40, bold: true, color: INK, align: "center", fontFace: FONT });
      s.addText(label, { x: xPos, y: 2.85, w: 2.9, h: 0.4, fontSize: 13, color: INK2, align: "center", fontFace: FONT });
    });
    const flips = pages.filter((p) => p.decided > 0 && (p.stability ?? 0) <= 0.5);
    if (flips.length > 0) {
      s.addText("The winnable prompts — no brand holds a majority:", {
        x: 0.6, y: 3.8, w: 12.1, h: 0.4, fontSize: 14, bold: true, color: INK, fontFace: FONT,
      });
      flips.slice(0, 4).forEach((p, i) => {
        s.addText(
          [
            { text: `${p.code}  `, options: { bold: true, color: SLATE } },
            { text: `"${p.text.length > 90 ? p.text.slice(0, 90) + "…" : p.text}" — `, options: { color: INK2 } },
            { text: p.modal ? `${p.modal} leads ${p.modalCount} of ${p.decided}` : "wide open", options: { color: INK, bold: true } },
          ],
          { x: 0.8, y: 4.3 + i * 0.55, w: 11.9, h: 0.5, fontSize: 12, fontFace: FONT }
        );
      });
    }
  }

  // ---------- 12. by question type ----------
  {
    const s = newSlide("By buyer question type", "Where in the journey the brand wins — and who takes the stages it loses");
    const promptById = new Map(x.prompts.map((p) => [p.id, p]));
    const themes = ["discovery", "recommendation", "comparison", "use_case"];
    const targetNorm = x.canon.norm(brand);
    const header: PptxGenJS.TableRow = ["Question type", "Answers", `${brand} named`, `${brand} picked`, "Most common pick"].map((h) => ({
      text: h, options: { bold: true, color: PAPER, fill: { color: SLATE }, fontSize: 12, fontFace: FONT },
    }));
    const body: PptxGenJS.TableRow[] = [];
    for (const theme of themes) {
      const rows = x.responses.filter((r) => promptById.get(r.prompt_id)?.theme === theme);
      if (rows.length === 0) continue;
      let named = 0;
      let picked = 0;
      const tally = new Map<string, number>();
      for (const r of rows) {
        if (answerMentions(x, r).some((m) => m.norm === targetNorm)) named += 1;
        if (r.top_pick_brand) {
          const d = x.canon.canonical(r.top_pick_brand);
          tally.set(d, (tally.get(d) ?? 0) + 1);
          if (x.canon.norm(r.top_pick_brand) === targetNorm) picked += 1;
        }
      }
      const modal = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      const modalIsTarget = modal && x.canon.norm(modal[0]) === targetNorm;
      body.push([
        { text: theme.replace("_", " "), options: { fontSize: 12.5, color: INK, fontFace: FONT } },
        { text: String(rows.length), options: { fontSize: 12.5, color: INK2, align: "right" as const, fontFace: FONT } },
        { text: `${named} (${pct(named / rows.length)})`, options: { fontSize: 12.5, color: INK2, align: "right" as const, fontFace: FONT } },
        { text: `${picked} (${pct(picked / rows.length)})`, options: { fontSize: 12.5, color: INK2, align: "right" as const, fontFace: FONT } },
        { text: modal ? modal[0] : "—", options: { fontSize: 12.5, bold: true, color: modalIsTarget ? WIN : ABSENT, fontFace: FONT } },
      ]);
    }
    s.addTable([header, ...body], { x: 0.5, y: 1.7, w: 12.3, colW: [3.0, 1.7, 2.5, 2.5, 2.6], border: { type: "solid", color: "E5E7EB", pt: 0.5 } });
    addNarrative(s, "prompts");
  }

  // ---------- 13. prompt heatmap ----------
  {
    const s = newSlide("The prompt battery at a glance", "One row per prompt · detail pages follow, grouped by outcome");
    const header: PptxGenJS.TableRow = ["", "Prompt", "Named", "Picks", "Consistency", "Outcome"].map((h) => ({
      text: h, options: { bold: true, color: PAPER, fill: { color: SLATE }, fontSize: 10.5, fontFace: FONT },
    }));
    const body: PptxGenJS.TableRow[] = pages.map((p) => [
      { text: p.code, options: { bold: true, fontSize: 9.5, color: SLATE, fontFace: FONT } },
      { text: p.text.length > 82 ? p.text.slice(0, 82) + "…" : p.text, options: { fontSize: 9.5, color: INK2, fontFace: FONT } },
      { text: `${p.named}/${p.answers}`, options: { fontSize: 9.5, color: INK2, align: "right" as const, fontFace: FONT } },
      { text: `${p.focusPicks}/${p.decided}`, options: { fontSize: 9.5, color: INK2, align: "right" as const, fontFace: FONT } },
      { text: p.stability !== null ? pct(p.stability) : "—", options: { fontSize: 9.5, color: INK2, align: "right" as const, fontFace: FONT } },
      { text: p.badge, options: { fontSize: 9, bold: true, color: PAPER, fill: { color: badgeColor(p.badge) }, align: "center" as const, fontFace: FONT } },
    ]);
    s.addTable([header, ...body], {
      x: 0.5, y: 1.5, w: 12.3, colW: [0.7, 7.3, 1.1, 1.1, 1.2, 0.9],
      border: { type: "solid", color: "EEF2F5", pt: 0.5 }, rowH: 0.32,
    });
  }

  // ---------- 14+. prompt detail pages ----------
  for (const p of pages) {
    const s = newSlide(undefined);
    s.addShape("roundRect", { x: 0.5, y: 0.45, w: 1.7, h: 0.5, fill: { color: badgeColor(p.badge) }, rectRadius: 0.06 });
    s.addText(p.badge, { x: 0.5, y: 0.45, w: 1.7, h: 0.5, align: "center", valign: "middle", bold: true, color: PAPER, fontSize: 13, fontFace: FONT });
    s.addText(`${p.code} · ${p.theme}`, { x: 2.4, y: 0.45, w: 4, h: 0.5, valign: "middle", fontSize: 13, color: INK3, fontFace: FONT });
    s.addText(`“${p.text}”`, { x: 0.5, y: 1.15, w: 12.3, h: 0.95, fontSize: 17, bold: true, color: INK, fontFace: FONT, valign: "top" });
    // picks per repeat
    const cellW = Math.min(2.35, 11.8 / p.picks.length);
    p.picks.forEach((pick, i) => {
      const xPos = 0.5 + i * (cellW + 0.12);
      const isFocus = pick !== "—" && x.canon.norm(pick) === x.canon.norm(brand);
      s.addShape("roundRect", { x: xPos, y: 2.35, w: cellW, h: 0.85, fill: { color: isFocus ? SLATE : SOFT }, rectRadius: 0.05 });
      s.addText(`r${i + 1}`, { x: xPos + 0.08, y: 2.4, w: cellW - 0.16, h: 0.25, fontSize: 9, color: isFocus ? "DCE6EC" : INK3, fontFace: FONT });
      s.addText(pick === "—" ? "· no pick ·" : pick, {
        x: xPos + 0.08, y: 2.6, w: cellW - 0.16, h: 0.55, fontSize: 11.5, bold: true,
        color: isFocus ? PAPER : INK, fontFace: FONT, valign: "middle",
      });
    });
    s.addText(
      `${brand}: named in ${p.named} of ${p.answers} answers${p.avgPos ? ` (avg position #${p.avgPos.toFixed(1)})` : ""} · picked in ${p.focusPicks} of ${p.decided} decided · consistency ${p.stability !== null ? pct(p.stability) : "—"}`,
      { x: 0.5, y: 3.45, w: 12.3, h: 0.4, fontSize: 12.5, color: INK2, fontFace: FONT }
    );
    s.addShape("rect", { x: 0.5, y: 4.05, w: 12.33, h: 1.35, fill: { color: SOFT } });
    s.addText(
      p.quote
        ? [
            { text: "What the answers say:  ", options: { bold: true, color: SLATE } },
            { text: `“${p.quote}”`, options: { italic: true, color: INK2 } },
          ]
        : [{ text: `${brand} was not discussed in these answers.`, options: { italic: true, color: INK3 } }],
      { x: 0.7, y: 4.15, w: 11.9, h: 1.15, fontSize: 12.5, fontFace: FONT, valign: "top" }
    );
    s.addText(
      [
        { text: "Verdict: ", options: { bold: true, color: INK } },
        { text: p.verdict, options: { color: INK2 } },
      ],
      { x: 0.5, y: 5.6, w: 12.3, h: 0.7, fontSize: 13, fontFace: FONT, valign: "top" }
    );
    // AI-beta: the gate-verified lever line for this prompt, when written.
    if (isBeta && insights) {
      const gridIdx = (x.metrics.promptGrid ?? []).findIndex(
        (g) => g.text === p.text
      );
      const lever =
        gridIdx >= 0
          ? insights.levers?.find((l) => l.code === `L${gridIdx + 1}`)
          : undefined;
      if (lever) {
        s.addShape("rect", { x: 0.5, y: 6.35, w: 12.33, h: 0.6, fill: { color: SOFT } });
        s.addText(
          [
            { text: "AI lever (verified): ", options: { bold: true, color: SLATE } },
            { text: lever.lever, options: { color: INK2 } },
          ],
          { x: 0.7, y: 6.38, w: 12.0, h: 0.54, fontSize: 11.5, fontFace: FONT, valign: "middle" }
        );
      }
    }
  }

  // ---------- negatives ----------
  if (x.metrics.negatives && x.metrics.negatives.length > 0) {
    const s = newSlide(
      "Where the answers push back",
      `${x.metrics.negatives.length} answers framed ${brand} negatively — verbatim, with the coder's reading`
    );
    x.metrics.negatives.slice(0, 4).forEach((n, i) => {
      const y = 1.6 + i * 1.3;
      s.addShape("rect", { x: 0.55, y, w: 0.05, h: 1.1, fill: { color: ABSENT } });
      s.addText(
        [
          { text: `“${n.quote ?? ""}”  `, options: { italic: true, color: INK } },
          { text: n.interpretation ? `— ${n.interpretation}` : "", options: { color: INK3 } },
        ],
        { x: 0.8, y, w: 12.0, h: 1.2, fontSize: 12, fontFace: FONT, valign: "top" }
      );
    });
    addNarrative(s, "negatives");
  }

  // ---------- trend ----------
  if (x.trend && x.trend.runs.length >= 2) {
    const s = newSlide("Trend", `${brand} vs tracked rivals across ${x.trend.runs.length} completed runs`);
    const series = x.trend.series.slice(0, 6);
    s.addChart("line", series.map((ser) => ({
      name: ser.brand,
      labels: x.trend!.runs.map((r) => r.date),
      values: ser.points.map((pt) => Math.round(pt.rate * 1000) / 10),
    })), {
      x: 0.5, y: 1.55, w: 12.3, h: 5.0,
      chartColors: series.map((ser) => (ser.isTarget ? SLATE : "C3CFD8")),
      lineSize: 2.5,
      valAxisMaxVal: 100,
      catAxisLabelFontSize: 10,
      valAxisLabelFontSize: 10,
      catAxisLabelFontFace: FONT,
    });
    addNarrative(s, "trend");
  }

  // ---------- plays ----------
  if (insights && insights.plays.length > 0) {
    const s = newSlide("The plays", "Each play names its metric and today's baseline — re-run the study and it grades itself");
    insights.plays.slice(0, 4).forEach((p, i) => {
      const y = 1.55 + i * 1.35;
      s.addShape("roundRect", { x: 0.5, y, w: 12.33, h: 1.2, fill: { color: SOFT }, rectRadius: 0.05 });
      s.addText(
        [
          { text: `${i + 1}. ${p.title} — `, options: { bold: true, color: INK } },
          { text: `${p.play} `, options: { color: INK2 } },
          { text: `Measured by: ${p.measuredBy}, today ${p.today}.`, options: { bold: true, color: SLATE } },
        ],
        { x: 0.75, y: y + 0.08, w: 11.8, h: 1.05, fontSize: 12, fontFace: FONT, valign: "top" }
      );
    });
  }

  // ---------- limits + back ----------
  {
    const s = newSlide("Limitations, stated openly");
    const limits = [
      `One assistant measured this run (${x.run.model}); results describe this engine's behavior specifically. Multi-engine coverage is on the roadmap and the analyses are already engine-keyed.`,
      "API collection measures default answers in clean sessions — no personalization, and no platform-side ad units or retrieval citations.",
      `Intervals reflect sampling at ${x.run.repeats} repeats per prompt; differences inside overlapping intervals should be read as parity.`,
      "The full coded dataset ships with this study — every number in this deck can be recomputed from it.",
      ...(isBeta
        ? ["AI narrative (beta): the italic 'AI reading' captions were machine-written under a hard rule — every figure is substituted from the study's verified fact registry, and any sentence carrying an unsourced number is deleted before publication."]
        : []),
    ];
    limits.forEach((t, i) => {
      s.addText(
        [
          { text: "—  ", options: { bold: true, color: SLATE } },
          { text: t, options: { color: INK2 } },
        ],
        { x: 0.7, y: 1.75 + i * 0.95, w: 11.9, h: 0.9, fontSize: 13, fontFace: FONT, valign: "top" }
      );
    });
  }
  {
    pageNo += 1;
    const s = pptx.addSlide();
    s.background = { color: SLATE };
    s.addText("Data made decisive.", { x: 0.8, y: 3.1, w: 11.7, h: 0.8, fontSize: 32, bold: true, color: PAPER, fontFace: FONT });
    s.addText("Answerpoll by Resondex · answerpoll.vercel.app", { x: 0.8, y: 4.0, w: 11.7, h: 0.4, fontSize: 14, color: "DCE6EC", fontFace: FONT });
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}
