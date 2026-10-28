import { useEffect, useState } from "react";
import { api } from "../api";
import { isTaskId } from "./taskProjection";

export interface TaskReview { verdict: "pass" | "rework"; requestId: string; reviewedAt: string; note?: string; reviewer?: { controlSource?: string }; }

export function useTaskReview(id: string, turnId: string | undefined, enabled: boolean) {
  const [review, setReview] = useState<TaskReview>(), [reviewError, setReviewError] = useState("");
  const [reviewLoading, setReviewLoading] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    setReview(undefined); setReviewError(""); setReviewLoading(false);
    if (!turnId || !enabled || !isTaskId(id)) return;
    setReviewLoading(true);
    void api<{ reviews: { turnId: string; review: TaskReview }[] }>("tasks/reviews", "POST", { id })
      .then(response => { if (!stopped) setReview(response.reviews.find(row => row.turnId === turnId)?.review); })
      .catch(error => { if (!stopped) setReviewError(String(error)); })
      .finally(() => { if (!stopped) setReviewLoading(false); });
    return () => { stopped = true; };
  }, [id, turnId, enabled, attempt]);
  return { review, reviewError, reviewLoading, reloadReview: () => setAttempt(old => old + 1) };
}
