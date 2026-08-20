export const AUDIT_CSV_MAX_ROWS = 10_000;

const SPREADSHEET_FORMULA_PREFIX = /^[\t\r ]*[=+\-@]/;

/**
 * Converts a stored audit value into a CSV cell safe for spreadsheet software.
 * Dates are serialized as plain UTC ISO strings; objects remain readable JSON.
 */
export function serializeAuditCsvCell(value: unknown): string {
  if (value == null) return "";

  const raw =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  // A leading apostrophe forces Excel and similar programs to keep a cell as text.
  const spreadsheetSafe = SPREADSHEET_FORMULA_PREFIX.test(raw)
    ? `'${raw}`
    : raw;

  return /[",\r\n]/.test(spreadsheetSafe)
    ? `"${spreadsheetSafe.replace(/"/g, '""')}"`
    : spreadsheetSafe;
}

export function limitAuditCsvRows<T>(rows: T[]): {
  rows: T[];
  truncated: boolean;
} {
  return {
    rows: rows.slice(0, AUDIT_CSV_MAX_ROWS),
    truncated: rows.length > AUDIT_CSV_MAX_ROWS,
  };
}

export function getAuditCsvExportMetadata(truncated: boolean): Record<string, string> {
  return {
    "X-Audit-Export-Truncated": String(truncated),
    "X-Audit-Export-Row-Limit": String(AUDIT_CSV_MAX_ROWS),
  };
}