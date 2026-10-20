import { createStore } from "./store";
export type Page = "overview" | "tasks" | "logs" | "permissions" | "settings";
export const navigation = createStore<{
  providerId?: string;
  ingressEdit?: { id: string; field: string };
}>({});
