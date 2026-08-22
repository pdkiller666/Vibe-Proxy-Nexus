// Shared utilities for admin page modules

export const ADMIN_PAGE_SIZE = 20;

export function formatDate(iso: string) {
  return new Date(iso).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" });
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exp;
  return `${value.toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

export function PaginationBar({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / ADMIN_PAGE_SIZE));
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between pt-3 border-t border-border">
      <button
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
        className="text-sm px-3 py-1.5 border border-border disabled:opacity-30 hover:bg-muted transition-colors"
      >
        ← Назад
      </button>
      <span className="text-xs text-muted-foreground font-mono">
        Стр. {page} / {totalPages} · Всего: {total}
      </span>
      <button
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
        className="text-sm px-3 py-1.5 border border-border disabled:opacity-30 hover:bg-muted transition-colors"
      >
        Вперёд →
      </button>
    </div>
  );
}
