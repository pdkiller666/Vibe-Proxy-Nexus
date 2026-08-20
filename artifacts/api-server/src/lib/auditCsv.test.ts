import { describe, expect, it } from "vitest";
import {
  AUDIT_CSV_MAX_ROWS,
  getAuditCsvExportMetadata,
  limitAuditCsvRows,
  serializeAuditCsvCell,
} from "./auditCsv";
import { getAuditActionForRoute, sanitizeAuditBody } from "./auditLog";

describe("audit CSV helpers", () => {
  it("writes dates as clean ISO UTC strings without embedded quotes", () => {
    expect(serializeAuditCsvCell(new Date("2026-08-20T12:46:34.864Z"))).toBe(
      "2026-08-20T12:46:34.864Z",
    );
  });

  it("keeps JSON readable and quotes a CSV cell with punctuation", () => {
    expect(serializeAuditCsvCell({ note: 'Привет, "мир"' })).toBe(
      '"{""note"":""Привет, \\""мир\\""""}"',
    );
  });

  it("quotes carriage returns and newlines in plain text values", () => {
    expect(serializeAuditCsvCell("первая строка\r\nвторая строка")).toBe(
      '"первая строка\r\nвторая строка"',
    );
  });

  it("prevents spreadsheet formulas while retaining the visible value as text", () => {
    expect(serializeAuditCsvCell('=HYPERLINK("https://example.test")')).toBe(
      `"'=HYPERLINK(""https://example.test"")"`,
    );
    expect(serializeAuditCsvCell(" +SUM(A1:A2)")).toBe("' +SUM(A1:A2)");
  });

  it("reports and trims an export that exceeds the supported row count", () => {
    const values = Array.from({ length: AUDIT_CSV_MAX_ROWS + 1 }, (_, i) => i);
    const result = limitAuditCsvRows(values);
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(AUDIT_CSV_MAX_ROWS);
    expect(result.rows.at(-1)).toBe(AUDIT_CSV_MAX_ROWS - 1);
    expect(getAuditCsvExportMetadata(result.truncated)).toEqual({
      "X-Audit-Export-Truncated": "true",
      "X-Audit-Export-Row-Limit": String(AUDIT_CSV_MAX_ROWS),
    });
  });
});

describe("audit action and redaction helpers", () => {
  it("classifies acknowledge-all as a named action", () => {
    expect(
      getAuditActionForRoute("POST", "/admin/system-events/acknowledge-all"),
    ).toBe("acknowledge_all_system_events");
  });

  it("redacts sensitive values recursively, including values in arrays", () => {
    expect(
      sanitizeAuditBody({
        settings: {
          managementApiSecret: "keep-me-out",
          children: [{ token: "also-hidden", name: "safe" }],
        },
      }),
    ).toEqual({
      settings: {
        managementApiSecret: "[REDACTED]",
        children: [{ token: "[REDACTED]", name: "safe" }],
      },
    });
  });
});