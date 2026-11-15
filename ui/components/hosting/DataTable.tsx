import type { CSSProperties, ReactNode } from "react";

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
  onOpen?: (row: T) => void;
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
          {rows.map(row => <tr key={row.id} className={onOpen ? "data-table-row" : undefined} tabIndex={onOpen ? -1 : undefined} onClick={onOpen ? event => { event.currentTarget.focus({ preventScroll: true }); onOpen(row); } : undefined}>
            {columns.map(column => <td key={column.key} style={{ textAlign: column.align }}>{column.render(row)}</td>)}
          </tr>)}
          {!rows.length && <tr><td colSpan={columns.length}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
