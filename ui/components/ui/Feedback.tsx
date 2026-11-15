


import "./Feedback.css";

export function LoadingIndicator({ label }: { label: string }) {
  return <span className="ui-loading" role="status" aria-label={label}>
    <span className="ui-spinner" aria-hidden="true" />
  </span>;
}
