import type { CSSProperties, ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Icon } from "./index";
import { locale, t } from "../../i18n";
import "./DataTable.css";

interface Column<T> {
  key: string;
  title?: ReactNode;
  width: number;
  align?: "right";
  render: (row: T) => ReactNode;
}

export function DataTable<T extends { id: string }>({ rows, columns, onOpen, empty }: {
  rows: T[];
  columns: Column<T>[];
  onOpen: (row: T) => void;
  empty: ReactNode;
}) {
  return (
    <div className="data-table-container">
      <table className="data-table" style={{ "--data-table-width": `${columns.reduce((sum, column) => sum + column.width, 0)}px` } as CSSProperties}>
        <thead>
          <tr>
            {columns.map(column => <th scope="col" key={column.key} style={{ width: column.width, textAlign: column.align }}>{column.title}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => <tr key={row.id} className="data-table-row" tabIndex={-1} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onOpen(row); }}>
            {columns.map(column => <td key={column.key} style={{ textAlign: column.align }}>{column.render(row)}</td>)}
          </tr>)}
          {!rows.length && <tr><td colSpan={columns.length}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ current, total, pageSize, disabled, onChange }: {
  current: number;
  total: number;
  pageSize: number;
  disabled?: boolean;
  onChange: (page: number) => void;
}) {
  locale.use();
  const last = Math.max(1, Math.ceil(total / pageSize));
  if (last === 1) return null;
  const pages = Array.from(new Set([1, ...Array.from({ length: 5 }, (_, i) => Math.min(Math.max(current - 2, 1), Math.max(last - 4, 1)) + i).filter(page => page <= last), last])).sort((a, b) => a - b);
  return <nav className="data-pagination" aria-label={t("pagination")}>
    <Button variant="ghost" disabled={disabled || current <= 1} aria-label={t("previousPage")} onClick={() => onChange(current - 1)}><Icon icon={ChevronLeft} /></Button>
    {pages.map((page, index) => <span className="data-pagination-item" key={page}>
      {index > 0 && page - pages[index - 1] > 1 && <span className="data-pagination-gap" aria-hidden="true">…</span>}
      <Button variant="ghost" disabled={disabled} aria-current={page === current ? "page" : undefined} onClick={() => onChange(page)}>{page}</Button>
    </span>)}
    <Button variant="ghost" disabled={disabled || current >= last} aria-label={t("nextPage")} onClick={() => onChange(current + 1)}><Icon icon={ChevronRight} /></Button>
  </nav>;
}
