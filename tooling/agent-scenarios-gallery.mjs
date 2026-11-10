import { diffJSON, expandJSON } from './agent-scenarios-lib.mjs';

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const json = value => `<pre>${escape(JSON.stringify(value, null, 2))}</pre>`;

// A generated acceptance report, independent of the product renderer and design assets.
export function gallery({ capabilities, scenarios, current, approved, report, sizes = {} }) {
  const link = scenario => `<a href="#scenario-${escape(scenario.id)}">${escape(scenario.id)} · ${escape(scenario.title)} <small>${report.status(scenario.id)}</small></a>`;
  const navigation = capabilities.map(cap => {
    const row = report.rows.find(r => r.id === cap.id);
    const opTree = cap.ops.map(op => {
      const matching = scenarios.filter(s => s.ops.includes(op));
      return `<li><details${matching.length ? ' open' : ''}><summary>${escape(op)} · ${matching.length || 'missing'}</summary><ul>${matching.map(s => `<li>${link(s)}</li>`).join('')}</ul></details></li>`;
    }).join('');
    const extra = scenarios.filter(s => s.capability === cap.id && !s.ops.length).map(s => `<li><details open><summary>${escape(s.call.arguments?.op ?? s.call.name)} · invalid op</summary><ul><li>${link(s)}</li></ul></details></li>`).join('');
    const events = (cap.notificationKinds ?? []).map(kind => {
      const matching = scenarios.filter(s => s.notificationKinds?.includes(kind));
      return `<li><code>kind: ${escape(kind)}</code> · ${matching.length || 'missing'}<ul>${matching.map(s => `<li>${link(s)}</li>`).join('')}</ul></li>`;
    }).join('');
    return `<details open><summary>${escape(cap.label)} · ${row.coveredOps}/${row.ops} ops</summary><p>${escape(cap.description)}</p><p>Approved ${row.approved} · Pending ${row.pending} · Missing captures ${row.missing}</p><ul>${opTree}${extra}${events}</ul></details>`;
  }).join('');
  const cards = scenarios.map(s => {
    const capture = current[s.id], baseline = approved[s.id];
    const changes = capture && baseline ? diffJSON(expandJSON(baseline), expandJSON(capture)) : [];
    const text = capture?.response?.content?.find(block => block.type === 'text')?.text;
    const chars = sizes[s.id]?.characters ?? text?.length ?? 0;
    return `<article id="scenario-${escape(s.id)}"><h2>${escape(s.id)} · ${escape(s.title)}</h2><p>${report.status(s.id)} · ${chars.toLocaleString('en-US')} characters · ≈${Math.ceil(chars / 4).toLocaleString('en-US')} tokens</p>
<ul>${s.conclusions.map(value => `<li>${escape(value)}</li>`).join('')}</ul>
${s.fixtureArtifacts?.map(value => `<p class="warning">Fixture artifact: ${escape(value)}</p>`).join('') ?? ''}
<details><summary>Setup MCP calls</summary>${json(s.setup)}</details><h3>Call</h3>${json(capture?.call ?? s.call)}
<h3>Agent response</h3>${text === undefined ? '<p>Missing capture</p>' : json(expandJSON(text))}
<details><summary>Complete tools/call result</summary>${json(capture?.response ?? null)}</details>
<h3>Approval diff</h3>${!baseline ? '<p>Pending user approval · no approved response</p>' : !capture ? '<p>Missing current capture</p>' : changes.length ? json(changes) : '<p>Matches approved response</p>'}
</article>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ARC Agent 场景目录</title>
<style>
:root{color-scheme:light dark;--bg:#faf9f6;--surface:#fff;--fg:#272725;--muted:#62625e;--line:#deded7;--link:#225c86;--warning:#865617}
@media(prefers-color-scheme:dark){:root{--bg:#1b1b19;--surface:#242421;--fg:#edede5;--muted:#b3b3a8;--line:#45453e;--link:#9ccbf0;--warning:#efc27c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,sans-serif}header{padding:20px 28px;border-bottom:1px solid var(--line)}h1{margin:0;font-size:24px}h2{font-size:21px}h3{font-size:16px}main{display:grid;grid-template-columns:minmax(280px,360px) minmax(0,1fr)}nav{padding:22px;max-height:calc(100vh - 80px);overflow:auto;position:sticky;top:0;border-right:1px solid var(--line)}nav p{font-size:12px;color:var(--muted)}summary{cursor:pointer;overflow-wrap:anywhere}ul{padding-left:20px}nav li{margin:8px 0}a{color:var(--link);overflow-wrap:anywhere}small{color:var(--muted)}section{padding:0 28px;min-width:0}article{padding:12px 0 28px;border-bottom:1px solid var(--line);scroll-margin-top:16px}pre{padding:16px;background:var(--surface);border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 ui-monospace,monospace;tab-size:2}.warning{color:var(--warning)}:focus-visible{outline:2px solid var(--link);outline-offset:3px}@media(max-width:800px){main{display:block}nav{position:static;max-height:none;border-right:0;border-bottom:1px solid var(--line)}section{padding:0 18px}}
</style><header><h1>ARC Agent 场景目录</h1></header><main><nav aria-label="能力与操作">${navigation}</nav><section>${cards}</section></main></html>`;
}
