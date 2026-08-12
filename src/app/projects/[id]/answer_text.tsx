"use client";

/**
 * Assistant answers arrive as markdown — headings, bold, bullets, tables.
 * Rendering them raw shows the syntax; this turns the common constructs
 * into plain typography so a sampled answer reads like an answer. It is a
 * deliberately small subset: anything unrecognized falls through as text,
 * and nothing is ever treated as HTML.
 */
function highlightBrand(node: string, terms: string[], key: string) {
  const live = terms.filter(Boolean);
  if (live.length === 0) return node;
  const pattern = new RegExp(
    `(${live.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi"
  );
  const parts = node.split(pattern);
  if (parts.length === 1) return node;
  return parts.map((part, i) =>
    live.some((t) => t.toLowerCase() === part.toLowerCase()) ? (
      <mark key={`${key}-h-${i}`} className="rounded bg-primary-soft px-0.5 text-primary">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

function inline(text: string, key: string, highlight: string[] = []) {
  // **bold**, *italic*, `code`, and bare [n] citation markers.
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.filter(Boolean).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={`${key}-${i}`} className="font-semibold text-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={`${key}-${i}`}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={`${key}-${i}`} className="rounded bg-primary-soft/50 px-1 text-[0.92em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return (
      <span key={`${key}-${i}`}>{highlightBrand(part, highlight, `${key}-${i}`)}</span>
    );
  });
}

export default function AnswerText({
  text,
  highlight = [],
}: {
  text: string;
  /** Brand names to mark in the prose — the reason you opened the answer. */
  highlight?: string[];
}) {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  const flushList = (key: string) => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul-${key}`} className="my-1.5 grid gap-1 pl-4">
        {list.map((item, i) => (
          <li key={i} className="list-disc text-sm leading-relaxed text-ink-2">
            {inline(item, `${key}-${i}`, highlight)}
          </li>
        ))}
      </ul>
    );
    list = [];
  };

  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const key = String(i);
    // Table rows and separators read as noise without a table; keep the
    // cells, drop the pipes.
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)) return;
    if (line.trim().startsWith("|")) {
      flushList(key);
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length > 0) {
        blocks.push(
          <p key={key} className="text-sm leading-relaxed text-ink-2">
            {inline(cells.join(" · "), key, highlight)}
          </p>
        );
      }
      return;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList(key);
      blocks.push(
        <p key={key} className="mt-2.5 text-sm font-semibold text-ink">
          {inline(heading[2], key, highlight)}
        </p>
      );
      return;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      list.push(bullet[1]);
      return;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      list.push(numbered[1]);
      return;
    }
    flushList(key);
    if (line.trim() === "") return;
    blocks.push(
      <p key={key} className="my-1 text-sm leading-relaxed text-ink-2">
        {inline(line, key, highlight)}
      </p>
    );
  });
  flushList("end");
  return <div>{blocks}</div>;
}
