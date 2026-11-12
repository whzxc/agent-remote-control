import { useState } from 'react';

/** A submitted draft becomes the baseline; edits after that attempt are dirty again. */
export function useSubmittedDirty<T>(draft: T, edited: boolean) {
  const snapshot = JSON.stringify(draft);
  const [submitted, setSubmitted] = useState<string>();
  return { dirty: submitted === undefined ? edited : snapshot !== submitted,
    submit: (value: T = draft) => setSubmitted(JSON.stringify(value)) };
}
