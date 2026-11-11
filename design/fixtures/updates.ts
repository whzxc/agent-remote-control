export const installedVersion = "0.9.48";
export const targetVersion = "0.9.50";

export const releases = [
  {
    version: targetVersion,
    sections: [
      { title: "修复", items: ["修复概览面板的位置偏移。"] },
    ],
  },
  {
    version: "0.9.49",
    sections: [
      { title: "改进", items: ["概览面板的高度随内容调整。"] },
      {
        title: "修复",
        items: ["恢复旧 Codex 会话续跑时的任务气泡。", "修复打开任务详情时偶发的加载报错。"],
      },
    ],
  },
] as const;

export const frames = [
  { name: "available", note: "Proposed ready state. The current fixture uses plain-text release notes." },
  { name: "downloading", note: "Proposed progress layout. A matching browser fixture follows adoption." },
  { name: "download-failed", note: "Proposed retry layout. A matching browser fixture follows adoption." },
  { name: "installing", note: "Proposed pending state. The current fixture uses the existing update panel." },
] as const;

export const download = { percent: 58, amount: "18.3 / 31.6 MB" };

export const copy = {
  title: `更新 ARC 至 ${targetVersion}`,
  fromVersion: `当前版本 ${installedVersion}`,
  ready: "已下载",
  downloading: "正在下载",
  downloadFailed: "下载连接已中断。",
  restartEffect: "重启期间，ARC 连接会短暂断开。",
  later: "稍后",
  restart: "重启并更新",
  retry: "重试下载",
  installing: "正在安装并重启…",
  history: "更新记录",
  allReleases: "所有版本",
  about: "关于",
  appVersion: `ARC ${targetVersion}`,
  check: "检查更新",
  repository: "whzxc/agent-remote-control",
  experimental: "实验性功能",
};
