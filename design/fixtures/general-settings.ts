export const behavior = [
  {
    title: "Wake control sources",
    description: [
      "Send task status notifications to bound control sources.",
      "Inboxes remain available when disabled.",
    ],
    checked: false,
  },
  {
    title: "Automatically open Codex tasks",
    description: ["When enabled, new tasks open automatically in Codex."],
    checked: true,
  },
  {
    title: "Task approval mode",
    description: [
      "Task requests require local confirmation by default.",
      "Cloud requests can explicitly bypass confirmation.",
    ],
    checked: true,
  },
];
export const palettes = ["default", "blue", "purple", "orange", "green"].map(value => [value]);

export const copy = {
  "text1": "Settings",
  "text2": "Expand",
  "text3": "Behavior",
  "text4": "Request routing delay (0–300 s)",
  "text5": "15",
  "text6": "General",
  "text7": "Start automatically at sign-in",
  "text8": "Start automatically at sign-in",
  "text9": "Language",
  "text10": "Language",
  "text12": "English",
  "text13": "Appearance",
  "text14": "Theme",
  "text15": "Theme",
  "text17": "Light",
  "text18": "Theme color",
  "text19": "Theme color",
  "text20": "default",
  "text21": "Topology layout",
  "text22": "Topology layout",
  "text24": "Privacy mode",
  "text25": "Privacy mode",
  "text26": "masked",
  "text28": "Network",
  "text29": "Proxy",
  "text31": "Proxy",
  "text33": "About",
  "text34": "ARC fixture",
  "text35": "Check for updates",
  "text36": "whzxc/agent-remote-control",
  "text38": "Experimental",
  "updateHistory": "Update history"
};
export const samples = {
  "sample11": [
    "System",
    "English",
    "简体中文"
  ],
  "sample16": [
    "System",
    "Light",
    "Dark"
  ],
  "sample23": [
    "Tree",
    "Flat"
  ],
  "sample27": [
    {
      "value": "visible",
      "label": "Visible",
      "icon": "eye"
    },
    {
      "value": "masked",
      "label": "Masked",
      "icon": "eye-off"
    }
  ],
  "sample30": [
    "Use the system proxy or configure",
    "a proxy just for ARC."
  ],
  "sample32": [
    "System proxy",
    "No proxy",
    "Custom"
  ]
};
