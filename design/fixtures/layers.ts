export const dismissalCopy = {
  title: "Edit connection", field: "Name", value: "Studio",
  discard: "Discard your changes?", discardAction: "Discard", keep: "Keep editing",
  cancellable: "Saving connection… This dialog will close when the work finishes.",
  stop: "Stop and close", keepOpen: "Keep open",
  running: "Saving connection… This dialog will close when the work finishes.",
};
export const dismissalForms = [
  { name: "dialog-discard", state: "discard", note: "Footer actions are replaced; Keep editing is focused and primary." },
  { name: "dialog-running-cancellable", state: "cancellable",
    note: "Close is pending. Keep open is focused and primary. Stop and close cancels the work." },
  { name: "dialog-running", state: "running", note: "Close is pending. Keep open is focused and primary and withdraws the pending close." },
] as const;
