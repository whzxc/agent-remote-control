import { Copy } from 'lucide-react';
import type { FormEvent } from 'react';
import { Notice } from './kit/alert';
import { Button } from './kit/button';
import { DialogSurface } from './kit/dialog';
import { Field } from './kit/field';
import { Input } from './kit/input';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from './kit/select';
import { cn } from './kit/utils';

export interface BrowserChoiceOption {
  value: string;
  label: string;
}

export function AgentAccountFormView({
  formId,
  codeId,
  active = false,
  expired = false,
  codeEntry = false,
  busy = false,
  notice,
  waitingStatus,
  codeLabel,
  codePlaceholder,
  code = '',
  onCodeChange,
  browserLabel,
  browserValue,
  browserOptions,
  onBrowserChange,
  onSubmit,
}: {
  formId?: string;
  codeId?: string;
  active?: boolean;
  expired?: boolean;
  codeEntry?: boolean;
  busy?: boolean;
  notice?: string;
  waitingStatus?: string;
  codeLabel: string;
  codePlaceholder: string;
  code?: string;
  onCodeChange?: (value: string) => void;
  browserLabel: string;
  browserValue: string;
  browserOptions: readonly BrowserChoiceOption[];
  onBrowserChange?: (value: string) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const selectedBrowser =
    browserOptions.find((option) => option.value === browserValue)?.label ??
    browserOptions[0]?.label ??
    browserValue;

  return (
    <form
      id={formId}
      className={cn('agent-account-add-form flex flex-col', active ? 'gap-4' : 'gap-5')}
      data-waiting={active || undefined}
      onSubmit={onSubmit}
    >
      {notice && <Notice tone="danger">{notice}</Notice>}

      {active ? (
        <>
          {waitingStatus && (
            <p role="status" className="m-0 text-small font-medium leading-5 text-foreground">
              {waitingStatus}
            </p>
          )}
          {codeEntry && (
            <Field id={codeId} label={codeLabel}>
              <Input
                id={codeId}
                value={code}
                readOnly={!onCodeChange}
                onChange={onCodeChange ? (event) => onCodeChange(event.target.value) : undefined}
                placeholder={codePlaceholder}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
        </>
      ) : (
        !expired && (
          <Field label={browserLabel}>
            <Select
              value={browserValue}
              onValueChange={(next) => {
                if (typeof next === 'string') onBrowserChange?.(next);
              }}
              disabled={busy}
            >
              <SelectTrigger aria-label={browserLabel} className="w-full">
                <SelectValue>{selectedBrowser}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {browserOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
        )
      )}
    </form>
  );
}

export function AgentAccountFooterView({
  formId,
  active = false,
  codeEntry = false,
  busy = false,
  canCopyLink = false,
  copyLinkLabel,
  showCopyIcon = false,
  onCopyLink,
  submitCodeLabel,
  submitCodeDisabled = false,
  primaryLabel,
}: {
  formId?: string;
  active?: boolean;
  codeEntry?: boolean;
  busy?: boolean;
  canCopyLink?: boolean;
  copyLinkLabel: string;
  showCopyIcon?: boolean;
  onCopyLink?: () => void;
  submitCodeLabel: string;
  submitCodeDisabled?: boolean;
  primaryLabel: string;
}) {
  return (
    <div className="flex items-center justify-end gap-2.5">
      {active && canCopyLink && (
        <Button variant="outline" onClick={onCopyLink}>
          {showCopyIcon && (
            <Copy size={14} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
          )}
          {copyLinkLabel}
        </Button>
      )}
      {codeEntry && (
        <Button
          form={formId}
          type="submit"
          variant="primary"
          busy={busy}
          disabled={submitCodeDisabled}
        >
          {submitCodeLabel}
        </Button>
      )}
      {!active && (
        <Button form={formId} type="submit" variant="primary" busy={busy}>
          {primaryLabel}
        </Button>
      )}
    </div>
  );
}

export function AgentAccountDialogView({
  title,
  closeLabel,
  active = false,
  expired = false,
  codeEntry = false,
  notice,
  waitingStatus,
  codeLabel,
  codePlaceholder,
  browserLabel,
  browserValue,
  browserOptions,
  copyLinkLabel,
  submitCodeLabel,
  primaryLabel,
}: {
  title: string;
  closeLabel?: string;
  active?: boolean;
  expired?: boolean;
  codeEntry?: boolean;
  notice?: string;
  waitingStatus?: string;
  codeLabel: string;
  codePlaceholder: string;
  browserLabel: string;
  browserValue: string;
  browserOptions: readonly BrowserChoiceOption[];
  copyLinkLabel: string;
  submitCodeLabel: string;
  primaryLabel: string;
}) {
  return (
    <DialogSurface
      size="md"
      title={title}
      closeLabel={closeLabel}
      footer={
        <AgentAccountFooterView
          active={active}
          codeEntry={codeEntry}
          canCopyLink={active}
          copyLinkLabel={copyLinkLabel}
          showCopyIcon
          submitCodeLabel={submitCodeLabel}
          primaryLabel={primaryLabel}
        />
      }
    >
      <AgentAccountFormView
        active={active}
        expired={expired}
        codeEntry={codeEntry}
        notice={notice}
        waitingStatus={waitingStatus}
        codeLabel={codeLabel}
        codePlaceholder={codePlaceholder}
        browserLabel={browserLabel}
        browserValue={browserValue}
        browserOptions={browserOptions}
      />
    </DialogSurface>
  );
}
