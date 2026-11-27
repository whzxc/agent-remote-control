import { Frame } from "adg";
import { Globe, Link, Shield, type LucideIcon } from "lucide-react";
import {
  ConnectionCardView,
  ConnectionFactsView,
  ConnectionsListView,
} from "@/components/ConnectionCardView";
import { PrivacyProvider } from "@/components/kit";
import { LocaleProvider } from "@/i18n/react";
import SourceArt from "../art/source.svg";
import {
  connectionCopy,
  connectionExamples,
} from "../fixtures/connection-management";

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

const iconMap: Record<string, LucideIcon> = {
  link: Link,
  shield: Shield,
};

function cleanDetail(detail: string): string {
  return detail.replace(/\s*·\s*$/, "").trim();
}

export function ConnectionFacts({
  connection: c,
}: {
  connection: ManagedConnection;
}) {
  return (
    <ConnectionFactsView
      providerLabel={connectionCopy.provider}
      providerValue={c.provider}
      methodLabel={connectionCopy.method}
      methodValue={c.method}
      workerVersion={c.version}
    />
  );
}

export function ConnectionCard({
  connection: c,
}: {
  connection: ManagedConnection;
}) {
  const IconComponent = iconMap[c.icon] ?? Globe;
  return (
    <LocaleProvider locale="zh-CN">
      <PrivacyProvider hidden>
        <ConnectionCardView
          title={c.title}
          online
          statusLabel={cleanDetail(c.detail)}
          icon={IconComponent}
          iconTone={c.address ? "accent" : "command"}
          sources={
            c.account
              ? [
                  {
                    id: "account",
                    label: c.account,
                    icon: (
                      <SourceArt
                        data-brand
                        width={16}
                        height={16}
                        className="text-role-source"
                      />
                    ),
                  },
                ]
              : []
          }
          address={c.address}
          providerLabel={connectionCopy.provider}
          providerValue={c.provider}
          methodLabel={connectionCopy.method}
          methodValue={c.method}
          workerVersion={c.version}
          canEdit={!c.address}
          editLabel={connectionCopy.editTunnel}
          removeLabel={connectionCopy.deletePrefix + c.title}
        />
      </PrivacyProvider>
    </LocaleProvider>
  );
}

export function ConnectionList({
  connections,
}: {
  connections: ManagedConnection[];
}) {
  return (
    <ConnectionsListView>
      {connections.map((connection) => (
        <ConnectionCard key={connection.title} connection={connection} />
      ))}
    </ConnectionsListView>
  );
}

export default () => [
  <Frame key="connection-card-relay" name="connection-card-relay" width={632}>
    <div className="w-full bg-surface-raised">
      <ConnectionCard connection={connectionExamples[0]} />
    </div>
  </Frame>,
  <Frame key="connection-card-tunnel" name="connection-card-tunnel" width={632}>
    <div className="w-full bg-surface-raised">
      <ConnectionCard connection={connectionExamples[1]} />
    </div>
  </Frame>,
  <Frame key="connection-facts" name="connection-facts" width={600}>
    <div className="w-full bg-surface-subtle pt-[2px]">
      <ConnectionFacts connection={connectionExamples[0]} />
    </div>
  </Frame>,
  <Frame key="connection-list" name="connection-list" width={632}>
    <div className="w-full bg-surface-raised">
      <ConnectionList connections={connectionExamples} />
    </div>
  </Frame>,
];
