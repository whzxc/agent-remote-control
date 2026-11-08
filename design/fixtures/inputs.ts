export const fieldForms = [
  { name: "default", label: "服务器名称", value: "docs" },
  {
    name: "error",
    label: "地址",
    value: "tools.example",
    error: "需要完整的 HTTPS 地址",
  },
];

export const copyFieldExample = {
  value: "teatnsestonon.ssthssr.oshranr",
  masked: true,
};

export const searchInputExample = { placeholder: "搜索服务器和工具" };

export const switchForms = [
  { name: "on", checked: true, label: "on" },
  { name: "off", checked: false, label: "off" },
] as const;
