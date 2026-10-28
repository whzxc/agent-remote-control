import type { ToolPolicy } from "../toolPolicy";
import type { CoreSnapshot } from "../types";
export interface Config {
  proxyMode: "system" | "direct" | "custom";
  proxyUrl: string;
  connectionMode: "tunnel" | "https";
  httpsProvider: "cloudflare" | "ngrok" | "pinggy" | "localxpose" | "custom";
  hasNgrokAuthtoken: boolean;
  ngrokMode: "quick" | "named";
  ngrokEndpoint: string;
  pinggyMode: "quick" | "named";
  hasPinggyToken: boolean;
  localxposeMode: "quick" | "named";
  hasLocalxposeAccessToken: boolean;
  localxposeRegion: "us" | "eu" | "ap";
  cloudflareMode: "quick" | "named";
  hasCloudflareToken: boolean;
  cloudflareAuth: "token" | "login";
  cloudflareTunnelId: string;
  httpsUrl: string;
  httpsHost: string;
  httpsPort: number;
  configured: boolean;
  tunnelId: string;
  tunnelBinary: string;
  codexBinary: string;
  autoStart: boolean;
  hasApiKey: boolean;
}
export type ControlSource = { authorizationFacts?: { email?: string; orgName?: string; accountId?: string }; retiredIngressIds?: string[]; switchSourceId?: string; connectionRemoved?: boolean; connectionName?: string; pendingSwitch?: { ingressId: string; expiresAt: number; requestId?: string }; id: string; ingressId: string; credential: { type: "oauth-grant" | "ingress" | "local"; grantId?: string; clientId?: string }; product: string; platform: string; label: string; createdAt: string; connectedAt: number | null; lastSeenAt: number | null; state: "connected" | "disconnected" | "revoked" };
export type OAuthRequest = { switchSourceId?: string; sourceId?: string; product?: string; sourceCandidates?: ControlSource[]; id: string; status: string; clientName: string; redirectUri: string; resource: string; pairingCode?: string; expiresAt?: number };
export type OAuthGrant = { id: string; clientName: string; clientId: string; connectedAt: number | null; registeredAt: number | null };
export interface Ingress {
  sources?: ControlSource[];
  oauth?: { pending: OAuthRequest[]; grants: OAuthGrant[] };
  toolPolicy?: ToolPolicy;
  discoveredUrls?: string[];
  id: string;
  name: string;
  controlSource: string;
  transport: string;
  state: string;
  running: boolean;
  error: string;
  enabled: boolean;
  auth: string;
  config: Config;
  url: string;
  verification?: { verifiedAt?: string; challengeVerifiedAt?: string };
}
export interface Status {
  diagnostics: { findings: { code: string; severity: string; scope: { kind: string; id: string }; summary: string }[] };
  ingresses: Ingress[];
  ingressSummary: { running: number; ready: number; total: number };
  taskApprovalEnabled: boolean;
  requestRoutingDelaySeconds?: number;
  autoOpenCodex: boolean;
  notificationsEnabled: boolean;
  core: CoreSnapshot;
  connection?: { running: boolean; updateAvailable: boolean; mcpUrl: string };
  deviceName: string;
  platform: string;
  version: string;
  connector: { state: string; error?: string };
  tunnel: { state: string; error?: string };
  config: Config;
  logs: string[];
  chatgptUrl?: string;
}
export interface Login {
  state: string;
  message?: string;
  userCode?: string;
  verificationUrl?: string;
}
export interface Service {
  supported: boolean;
  enabled: boolean;
  message?: string;
}
export interface Diagnostics {
  checks: { name: string; status: string; message?: string }[];
  summary?: string;
}
