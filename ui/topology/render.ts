import type { Side } from './geometry';
export type WireState = "normal" | "connecting" | "error" | "inactive";
export interface PaintNode { id: string; side: Side; parent?: string; state: WireState; attention: boolean; selected: boolean; label?: string }
