# Model-facing terminology

Model-facing text and maintainer documentation MUST use English only.
Product UI and end-user documentation remain localized.
User input and upstream content retain their original language, including Chinese.

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.
Use one rule per sentence.

| Term | Meaning |
| --- | --- |
| turn | One native execution cycle within a task or thread. A continuation starts a new turn. |
| task | A unit of work tracked by ARC or an Agent. |
| thread | A native conversation containing turns. |
| revisit | A scheduled return to the control-source conversation. |
| segmented wait | Repeated bounded waits using the same task identifiers and snapshot hash. |
| reachability | Verified receipt in the target conversation, independent of transport availability. |
| control source | The model-facing client that reads ARC tools and chooses work. |
| dispatch | Submission of work to an Agent. |
| review | The control source's assessment of a completed turn, recorded as pass or rework. |
| effort | A model's reasoning effort setting. |
| receipt | The durable result of an ARC write request, addressed by requestId. |
| ingress | An ARC connection endpoint with its own authorization and control-source settings. |
| notification | The frozen MCP event name or a delivered ARC task update. |
| doorbell | A pushed notification that carries only the ARC header and glyph counts. |
| glyph | A fixed symbol plus keyword, such as `✓ done`, declared in the notify guide. |
| quota pool | A shared upstream usage allowance. |
| observed duration | Time from submission to the first terminal observation, including observation delay. |
| terminal | Completed, failed, or interrupted native execution. |

Protocol identifiers remain verbatim even when their spelling differs from prose.
Native names, paths, model IDs, user input, and quoted upstream evidence are data.
