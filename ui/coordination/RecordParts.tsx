import type { HTMLAttributes } from 'react';
import {
  RecordDisclosureView,
  RecordEventView,
  RecordFooterView,
  RecordListRowView,
} from './RecordView';
import '../components/ui/RecordDetail.css';
import './RecordParts.css';

type BlockProps = HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'span' | 'section' | 'footer' | 'details' | 'li';
  variant?: 'record' | 'issue';
};

export function RecordListRow(props: BlockProps) {
  return <RecordListRowView {...props} />;
}

export function RecordFooter(props: BlockProps) {
  return <RecordFooterView {...props} />;
}

export function RecordDisclosure(props: HTMLAttributes<HTMLDetailsElement>) {
  return <RecordDisclosureView {...props} />;
}

export function RecordEvent(props: HTMLAttributes<HTMLLIElement>) {
  return <RecordEventView {...props} />;
}
