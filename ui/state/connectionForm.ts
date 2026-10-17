import { configDefaults } from "../ingressConfig";
import type { Config } from "./types";
export type ConnectionForm = Pick<
  Config,
  | "connectionMode"
  | "httpsProvider"
  | "cloudflareMode"
  | "cloudflareAuth"
  | "httpsHost"
  | "httpsPort"
  | "tunnelId"
  | "ngrokMode"
  | "pinggyMode"
  | "localxposeMode"
  | "localxposeRegion"
> & {
  domain: string;
  apiKey: string;
  cloudflareToken: string;
  ngrokAuthtoken: string;
  pinggyToken: string;
  localxposeAccessToken: string;
};
export function connectionForm(config?: Config): ConnectionForm {
  const address =
    config?.httpsProvider === "ngrok" ? config.ngrokEndpoint : config?.httpsUrl;
  const domain = address
    ? new URL(address.includes("://") ? address : `https://${address}`).hostname
    : "";
  return {
    domain,
    connectionMode: config?.connectionMode || "tunnel",
    httpsProvider: config?.httpsProvider || "ngrok",
    cloudflareAuth: config?.cloudflareAuth || "token",
    cloudflareMode: config?.cloudflareMode || "quick",
    httpsHost: config?.httpsHost || String(configDefaults.httpsHost),
    httpsPort: config?.httpsPort || Number(configDefaults.httpsPort),
    tunnelId: config?.tunnelId || "",
    apiKey: "",
    cloudflareToken: "",
    ngrokAuthtoken: "",
    pinggyToken: "",
    localxposeAccessToken: "",
    pinggyMode: config?.pinggyMode || "quick",
    localxposeMode: "named",
    localxposeRegion: config?.localxposeRegion || "us",
    ngrokMode: config?.ngrokMode || "named",
  };
}
