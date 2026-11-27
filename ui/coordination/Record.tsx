import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import {
  RecordCardView,
  RecordHeadingView,
  RecordMetaView,
  RecordRowView,
} from './RecordView';
import './Record.css';

export function RecordCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <RecordCardView className={className}>{children}</RecordCardView>;
}

export function RecordRow(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <RecordRowView {...props} />;
}

export function RecordMeta(
  props: HTMLAttributes<HTMLElement> & { as?: 'span' | 'div' },
) {
  return <RecordMetaView {...props} />;
}

export function RecordHeading({
  count,
  children,
  attention,
  note,
  className,
}: {
  count?: number;
  children: ReactNode;
  attention?: boolean;
  note?: ReactNode;
  className?: string;
}) {
  return (
    <RecordHeadingView
      count={count}
      attention={attention}
      note={note}
      className={className}
    >
      {children}
    </RecordHeadingView>
  );
}
