import type { ManagedConnection } from "../modules/connection-management";

export const connectionExamples: ManagedConnection[] = [
  {
    title: "My relay",
    detail: "在线 · ",
    account: "Claude · Personal",
    address: "teatnsestonon.ssthssr.oshranr",
    provider: "Cloudflare Workers",
    method: "中继链接",
    version: "Worker 版本 · fixture",
    icon: "link",
  },
  {
    title: "ChatGPT tunnel",
    detail: "在线",
    provider: "OpenAI Secure Tunnel",
    method: "OpenAI Secure Tunnel",
    icon: "shield",
  },
];
export const connectionCopy = {
  title: "连接",
  add: "添加连接",
  editTunnel: "Edit tunnel",
  deletePrefix: "Delete ",
  provider: "服务提供商",
  method: "连接方式",
};
