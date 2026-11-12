import { Frame } from 'adg';
import { Dialog } from '../components/panel';
import { Button } from '../components/button';
import { Field, Input } from '../components/field';
import { SingleChoice } from '../components/single-choice';
import { accountAdd as copy } from '../fixtures/agent-account-add';
import { accountSignIn as signIn } from '../fixtures/agent-accounts';
import { Notice } from '../components/notice';

type Method = 'oauth' | 'import';
type Owner = 'codex' | 'none' | 'external';
type Flow = 'codex-add' | 'claude-add' | 'reauth' | 'waiting' | 'expired';
export function AgentAccountAdd({
  method = 'oauth', owner = 'codex', flow = 'codex-add',
}: { method?: Method; owner?: Owner; flow?: Flow }) {
  if (flow !== 'codex-add') {
    const title = flow === 'claude-add' ? signIn.add : signIn.reauth;
    const waiting = flow === 'waiting', expired = flow === 'expired';
    const footer = (
      <div class="flex justify-end gap-3">
        {waiting && <Button icon="copy">{signIn.copyLink}</Button>}
        <Button variant="primary">{waiting ? signIn.submit : expired ? signIn.retry : signIn.start}</Button>
      </div>
    );
    return (
      <Dialog title={title} footer={footer}>
        {waiting ? (
          <div class="flex flex-col gap-4">
            <p class="text-small font-medium" role="status">{signIn.waiting} · {signIn.browsers[1].label}</p>
            <Field label={signIn.code}><Input placeholder={signIn.codePlaceholder} /></Field>
          </div>
        ) : expired ? (
          <Notice title={signIn.failure} />
        ) : (
          <Field label={signIn.browser}>
            <SingleChoice label={signIn.browser} value="chrome-profile" options={signIn.browsers} dropdown fill />
          </Field>
        )}
      </Dialog>
    );
  }
  return <Dialog title={copy.title} footer={<div class="flex justify-end gap-3"><Button>{copy.cancel}</Button><Button variant="primary">{method === 'oauth' ? copy.login : copy.import}</Button></div>}>
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
  </Dialog>;
}
export default () => [
  <Frame name="oauth" fixture="codex-account-add-oauth-light" capture={{ selector: ".agent-account-add", viewport: "1280x800" }}><AgentAccountAdd /></Frame>,
  <Frame name="import" fixture="codex-account-add-import-light" capture={{ selector: ".agent-account-add", viewport: "1280x800" }}><AgentAccountAdd method="import" /></Frame>,
  <Frame name="external" fixture="codex-account-add-external-light" capture={{ selector: ".agent-account-add", viewport: "1280x800" }}><AgentAccountAdd method="import" owner="external" /></Frame>,
  ...([
    ['claude-add', 'claude-add'],
    ['reauth', 'reauth'],
    ['reauth-waiting', 'waiting'],
    ['reauth-expired', 'expired'],
  ] as const).map(([name, flow]) => (
    <Frame name={name} fixture={`agent-account-${name}`} capture={{ selector: ".dialog.agent-account-add", viewport: "1280x800" }}>
      <AgentAccountAdd flow={flow} />
    </Frame>
  )),
];
