import { createStore } from "./store";
export type Page = "overview" | "accounts" | "permissions" | "settings" | "pets";
export const navigation = createStore<{
  connectionsOpen?: boolean;
  platformId?: string;
  settingsExtras?: boolean;
  remoteSourceId?: string;
  remoteConnectionId?: string;
  page?: Page;
  providerId?: string;
  ingressEdit?: { id: string; field: string };
}>({});

export function openConnections() {
  navigation.set(old => ({ ...old, page: 'overview', connectionsOpen: true, remoteConnectionId: undefined }));
}
