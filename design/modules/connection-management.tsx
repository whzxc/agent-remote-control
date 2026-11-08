import { Frame } from "sdg";
import { IconButton } from "../components/icon-button";
import { CopyField } from "../components/copy-field";
import { Tile } from "../components/tile";
import SourceArt from "../art/source.svg";
import { connectionExamples, connectionCopy } from "../fixtures/connection-management";

export type ManagedConnection = {
  title: string;
  detail: string;
  account?: string;
  address?: string;
  provider: string;
  method: string;
  version?: string;
  icon: string;
};

export function ConnectionFacts({ connection: c }: { connection: ManagedConnection }) {
  return (
    <div
      class={`grid grid-cols-2 gap-3 ${c.address ? "-mt-[2px]" : ""}`}
    >
      {[
        { label: connectionCopy.provider, value: c.provider },
        { label: connectionCopy.method, value: c.method },
      ].map((item) => (
        <div class="flex flex-col gap-2">
          <span class="text-meta leading-4 text-text-secondary">
            {item.label}
          </span>
          <span class="text-small leading-4">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

export function ConnectionCard({ connection: c }: { connection: ManagedConnection }) {
  return (
    <article
      class={`flex flex-col gap-5 rounded-card bg-surface-subtle px-4 pt-4 ${c.address ? "pb-[14px]" : "pb-[18px]"}`}
    >
      <header class="flex h-10 items-center gap-3">
        <Tile icon={c.icon} tone={c.address ? "accent" : "command"} />
        <div class="flex flex-1 flex-col gap-1 pt-[6px]">
          <strong class="text-body leading-[18px] font-[650]">
            {c.title}
          </strong>
          <div class="flex items-center gap-[6px] text-meta leading-4 text-text-secondary">
            <span class="size-[6px] rounded-full bg-success" />
            <span class="text-success">{c.detail}</span>
            {c.account && (
              <>
                <SourceArt
                  data-brand
                  width={18}
                  height={18}
                  class="text-role-source"
                />
                <span>{c.account}</span>
              </>
            )}
          </div>
        </div>
        {!c.address && <IconButton icon="pencil" label={connectionCopy.editTunnel} />}
        <IconButton icon="trash-2" label={connectionCopy.deletePrefix + c.title} />
      </header>
      {c.address && (
        <div class="-mt-1">
          <CopyField value={c.address} masked />
        </div>
      )}
      <ConnectionFacts connection={c} />
      {c.version && (
        <span class="-mt-[10px] text-meta leading-4 text-text-tertiary">
          {c.version}
        </span>
      )}
    </article>
  );
}

export function ConnectionList({ connections }: { connections: ManagedConnection[] }) {
  return (
    <div class="flex flex-col gap-4">
      {connections.map(connection => <ConnectionCard connection={connection} />)}
    </div>
  );
}

export default () => [
    <Frame name="connection-card-relay" width={632}>
      <div class="w-full bg-surface-raised"><ConnectionCard connection={connectionExamples[0]} /></div>
    </Frame>,
    <Frame name="connection-card-tunnel" width={632}>
      <div class="w-full bg-surface-raised"><ConnectionCard connection={connectionExamples[1]} /></div>
    </Frame>,
    <Frame name="connection-facts" width={600}>
      <div class="w-full bg-surface-subtle pt-[2px]"><ConnectionFacts connection={connectionExamples[0]} /></div>
    </Frame>,
    <Frame name="connection-list" width={632}>
      <div class="w-full bg-surface-raised"><ConnectionList connections={connectionExamples} /></div>
    </Frame>,
];
