import type { TaskSnapshotData } from '../components/task-card';
export const layerSettings = [
  {
    "title": "Behavior",
    "rows": [
      {
        "label": "Request routing delay (0–300 s)",
        "options": [],
        "input": "15"
      },
      {
        "label": "Wake control sources",
        "description": "Send task status notifications to bound control sources.\nInboxes remain available when disabled.",
        "options": [],
        "toggle": "false"
      },
      {
        "label": "Automatically open Codex tasks",
        "description": "When enabled, new tasks open automatically in Codex.",
        "options": [],
        "toggle": "true"
      },
      {
        "label": "Task approval mode",
        "description": "Task requests require local confirmation by default.\nCloud requests can explicitly bypass confirmation.",
        "options": [],
        "toggle": "true"
      }
    ]
  },
  {
    "title": "General",
    "rows": [
      {
        "label": "Start automatically at sign-in",
        "options": [],
        "toggle": "false"
      },
      {
        "label": "Language",
        "options": [
          {
            "value": "auto",
            "label": "System",
            "selected": false
          },
          {
            "value": "en",
            "label": "English",
            "selected": true
          },
          {
            "value": "zh-CN",
            "label": "简体中文",
            "selected": false
          }
        ]
      }
    ]
  },
  {
    "title": "Appearance",
    "rows": [
      {
        "label": "Theme",
        "options": [
          {
            "value": "system",
            "label": "System",
            "selected": false
          },
          {
            "value": "light",
            "label": "Light",
            "selected": true
          },
          {
            "value": "dark",
            "label": "Dark",
            "selected": false
          }
        ]
      },
      {
        "label": "Theme color",
        "options": [
          {
            "value": "arc",
            "label": "ARC",
            "selected": true
          },
          {
            "value": "blue",
            "label": "Cyan / Blue",
            "selected": false
          },
          {
            "value": "purple",
            "label": "Pink / Purple",
            "selected": false
          },
          {
            "value": "orange",
            "label": "Red / Orange",
            "selected": false
          },
          {
            "value": "green",
            "label": "Yellow / Green",
            "selected": false
          }
        ]
      },
      {
        "label": "Topology layout",
        "options": [
          {
            "value": "tree",
            "label": "Tree",
            "selected": true
          },
          {
            "value": "flat",
            "label": "Flat",
            "selected": false
          }
        ]
      },
      {
        "label": "Privacy mode",
        "options": [
          {
            "value": "visible",
            "label": "Show sensitive information",
            "selected": false
          },
          {
            "value": "hidden",
            "label": "Hide sensitive information",
            "selected": true
          }
        ]
      }
    ]
  },
  {
    "title": "Network",
    "rows": [
      {
        "label": "Proxy",
        "description": "Use the system proxy or configure\na proxy just for ARC.",
        "options": [
          {
            "value": "system",
            "label": "System proxy",
            "selected": true
          },
          {
            "value": "direct",
            "label": "No proxy",
            "selected": false
          },
          {
            "value": "custom",
            "label": "Custom",
            "selected": false
          }
        ]
      }
    ]
  },
  {
    "title": "About",
    "rows": [
      {
        "label": "ARC fixture",
        "options": []
      },
      {
        "label": "Update history",
        "options": []
      }
    ]
  }
];
export const layerTask: TaskSnapshotData = {id:'history',node:'codex',title:'Review project change 1',group:'recent',state:'Completed',detail:'',icon:'check',origin:[{brand:'codex',label:'Codex'}],project:{name:'acceptance'},prompt:'Review project change 1',activity:'The project changes have been reviewed.'};
