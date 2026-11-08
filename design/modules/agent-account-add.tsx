import { Frame } from 'sdg';
import { Panel } from '../components/panel';
import { Button } from '../components/button';
import { Field, Input } from '../components/field';
import { SingleChoice } from '../components/single-choice';
import { accountAdd as copy } from '../fixtures/agent-account-add';

type Method = 'oauth' | 'import';
type Owner = 'codex' | 'none' | 'external';
export function AgentAccountAdd({ method = 'oauth', owner = 'codex' }: { method?: Method; owner?: Owner }) {
  return <Panel width={560} title={copy.title} footer={<div class="flex justify-end gap-3"><Button>{copy.cancel}</Button><Button variant="primary">{method === 'oauth' ? copy.login : copy.import}</Button></div>}>
    <div class="flex flex-col gap-5">
      <SingleChoice label="添加方式" value={method} options={copy.methods} fill />
      {method === 'oauth' ? <Field label={copy.browser}><SingleChoice label={copy.browser} value="default" options={copy.browsers} dropdown fill /></Field> : <>
        <Field label={copy.credentials}><Input class="h-32! items-start! py-3 font-mono text-small" placeholder={copy.credentialPlaceholder} /></Field>
        <Field label={copy.refresh}><SingleChoice label={copy.refresh} value={owner} options={copy.owners} fill /></Field>
        {owner === 'external' && <>
          <Field label={copy.program}><Input placeholder={copy.programPlaceholder} /></Field>
          <Field label={copy.args}><Input placeholder={copy.argsPlaceholder} class="font-mono text-small" /></Field>
        </>}
      </>}
    </div>
  </Panel>;
}
export default () => [
  <Frame name="oauth" fixture="codex-account-add-oauth-light" capture={{ selector: ".agent-account-add", viewport: "1280x800" }}><AgentAccountAdd /></Frame>,
  <Frame name="import" fixture="codex-account-add-import-light" capture={{ selector: ".agent-account-add", viewport: "1280x800" }}><AgentAccountAdd method="import" /></Frame>,
  <Frame name="external" fixture="codex-account-add-external-light" capture={{ selector: ".agent-account-add", viewport: "1280x800" }}><AgentAccountAdd method="import" owner="external" /></Frame>,
];
