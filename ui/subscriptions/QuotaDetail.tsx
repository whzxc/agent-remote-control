import type { ComponentProps } from 'react';
import { PopoverPrimitive } from '../components/kit/popover';
import { HoverScope } from '../components/ui/index';
import './QuotaDetail.css';

export function QuotaDetail(props: ComponentProps<'div'>) {
  return <div {...props} className="history-detail" />;
}
export function QuotaPopover(props: ComponentProps<typeof PopoverPrimitive.Popup>) {
  return <PopoverPrimitive.Popup {...props} className="history-popover" />;
}
export function QuotaHistory(props: ComponentProps<typeof HoverScope>) {
  return <HoverScope {...props} className="usage-history" />;
}
export function QuotaPeriod(props: ComponentProps<'div'>) {
  return <div {...props} className={'history-period ' + (props.className ?? '')} />;
}
export function QuotaCredit(props: ComponentProps<'span'>) {
  return <span {...props} className="credit-number" />;
}
export function QuotaOverview(props: ComponentProps<'section'>) {
  return <section {...props} className="usage-overview" />;
}
export function QuotaBreakdown(props: ComponentProps<'div'>) {
  return <div {...props} className="product-usage" />;
}
