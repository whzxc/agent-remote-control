import type { ReactNode } from "react";
export function SetupAccountDialog({children}:{children:ReactNode}){return <div className="text-small leading-[18px]">{children}</div>}
import { Frame } from 'adg';
import { Dialog } from '../components/panel';
import { Button } from '../components/button';
import { Field, Input } from '../components/field';
import { SingleChoice } from '../components/single-choice';
import { accountSignIn as signIn } from '../fixtures/agent-accounts';
import { Notice } from '../components/notice';

type Flow = 'claude-add' | 'reauth' | 'waiting' | 'expired';
export function AgentAccountAdd({
  flow = 'claude-add',
}: { flow?: Flow }) {
  const title = flow === 'claude-add' ? signIn.add : signIn.reauth;
  const waiting = flow === 'waiting', expired = flow === 'expired';
  const footer = (
    <div className="flex justify-end gap-3">
      {waiting && <Button icon="copy">{signIn.copyLink}</Button>}
      <Button variant="primary">{waiting ? signIn.submit : expired ? signIn.retry : signIn.start}</Button>
    </div>
  );
  return (
    <Dialog title={title} footer={footer}>
      {waiting ? (
        <div className="flex flex-col gap-4">
          <p className="text-small font-medium" role="status">{signIn.waiting} · {signIn.browsers[1].label}</p>
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
export default () => [
  ...([
    ['claude-add', 'claude-add'],
    ['reauth-waiting', 'waiting'],
    ['reauth-expired', 'expired'],
  ] as const).map(([name, flow]) => (
    <Frame name={name} width={592} fixture={`agent-account-${name}`} capture={{ selector: ".dialog.agent-account-add", viewport: "1280x800" }}>
      <AgentAccountAdd flow={flow} />
    </Frame>
  )),
];
