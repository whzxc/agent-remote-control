import type { ReactNode } from "react";
import { Frame } from "adg";
import { Activity } from "lucide-react";
import { LocaleProvider } from "@/i18n/react";
import {
  RecordCardView,
  RecordDisclosureView,
  RecordEventView,
  RecordFooterView,
  RecordHeadingView,
  RecordListRowView,
  RecordMetaView,
  RecordRowView,
} from "@/coordination/RecordView";
import { BoardRowGlyph } from "@/coordination/BoardRecordView";

export function RecordListRow({ children }: { children: ReactNode }) {
  return <RecordListRowView as="span">{children}</RecordListRowView>;
}

export function RecordFooter({ children }: { children: ReactNode }) {
  return <RecordFooterView>{children}</RecordFooterView>;
}

export function RecordDisclosure({ children }: { children: ReactNode }) {
  return <RecordDisclosureView>{children}</RecordDisclosureView>;
}

export function RecordEvent({ children }: { children: ReactNode }) {
  return <RecordEventView>{children}</RecordEventView>;
}

export function RecordRow({ children }: { children: ReactNode }) {
  return <RecordRowView>{children}</RecordRowView>;
}

export function RecordCard({ children }: { children: ReactNode }) {
  return <RecordCardView>{children}</RecordCardView>;
}

export function RecordMeta({ children }: { children: ReactNode }) {
  return <RecordMetaView>{children}</RecordMetaView>;
}

export function RecordHeading({
  children,
  count,
  attention = false,
}: {
  children: ReactNode;
  count?: number;
  attention?: boolean;
}) {
  return (
    <RecordHeadingView count={count} attention={attention}>
      {children}
    </RecordHeadingView>
  );
}

export default () => (
  <Frame name="record" width={560}>
    <LocaleProvider locale="en">
      <div className="w-full">
        <RecordHeading count={1}>Activity</RecordHeading>
        <RecordRow>
          <BoardRowGlyph icon={Activity} tone="neutral" />
          <div className="min-w-0 flex-1">
            <strong className="text-small leading-5 font-semibold text-foreground">
              Review changes
            </strong>
            <RecordMeta>Completed · Today</RecordMeta>
          </div>
        </RecordRow>
      </div>
    </LocaleProvider>
  </Frame>
);
