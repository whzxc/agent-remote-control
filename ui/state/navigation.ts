import { createStore } from "./store";
export type Page = "overview" | "tasks" | "logs" | "accounts" | "remote" | "permissions" | "settings";
export const navigation = createStore<{
  accountId?: string;
  addAccount?: boolean;
  settingsExtras?: boolean;
  remoteSourceId?: string;
  remoteConnectionId?: string;
  page?: Page;
  recordsSource?: string;
  providerId?: string;
  ingressEdit?: { id: string; field: string };
}>({});
