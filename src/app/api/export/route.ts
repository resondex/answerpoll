import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { requireAuth } from "@/lib/auth";

/** Turn a table the workbench is already showing into a styled .xlsx.
 * The client posts exactly what's on screen, so the file and the view can
 * never disagree. */
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;
  const body = (await req.json()) as {
    sheet?: string;
    header?: string[];
    rows?: (string | number | null)[][];
  };
  const header = body.header ?? [];
  const rows = body.rows ?? [];
  if (header.length === 0) {
    return NextResponse.json({ error: "header required" }, { status: 400 });
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = "Procerno";
  const ws = wb.addWorksheet((body.sheet ?? "Data").slice(0, 28));
  ws.addRow(header);
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
  head.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF5B7E92" },
  };
  head.alignment = { vertical: "middle" };
  head.height = 20;
  for (const r of rows) ws.addRow(r);
  ws.columns.forEach((col, i) => {
    const widest = Math.max(
      String(header[i] ?? "").length,
      ...rows.map((r) => String(r[i] ?? "").length)
    );
    col.width = Math.min(Math.max(widest + 3, 10), 52);
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: header.length },
  };
  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${(body.sheet ?? "export").replace(/[^a-z0-9_]+/gi, "_")}.xlsx"`,
    },
  });
}
