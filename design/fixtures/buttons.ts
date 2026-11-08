export const buttonForms = [
  { name: "primary", variant: "primary", icon: "plus", text: "添加服务器" },
  {
    name: "secondary",
    variant: "secondary",
    icon: "rotate-cw",
    text: "重新连接",
  },
  { name: "ghost", variant: "ghost", text: "取消" },
  { name: "danger", variant: "danger", text: "删除" },
  { name: "pending", variant: "primary", busy: true, text: "正在安装" },
] as const;

export const iconButtonForms = [
  { name: "regular", compact: false, icon: "rotate-cw", label: "rotate-cw" },
  { name: "compact", compact: true, icon: "trash-2", label: "trash-2" },
] as const;
