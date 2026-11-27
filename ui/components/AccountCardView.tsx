import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { ComponentType, FormEvent, HTMLAttributes, ReactNode } from 'react';
import { Notice } from './kit/alert';
import { Badge } from './kit/badge';
import { Button, IconButton } from './kit/button';
import { Card } from './kit/card';
import { DialogSurface } from './kit/dialog';
import { Field } from './kit/field';
import { Input } from './kit/input';

type AccountCardWrapperProps = HTMLAttributes<HTMLElement> & {
  variant?: 'default' | 'reply';
  padded?: boolean;
};

export function AccountCardView({
  CardWrapper, accountId, alias, emailNode, isDefault = false, defaultLabel,
  signedIn, readOnly = false, canRemove = false, refreshing = false, error,
  editButtonId, removeButtonId, editLabel, refreshLabel, removeLabel,
  statusLabel, reauthLabel, quotaSlot, onSelect, onEdit, onRefresh, onRemove, onReauth,
}: {
  CardWrapper?: ComponentType<AccountCardWrapperProps>;
  accountId?: string; alias: string; emailNode?: ReactNode; isDefault?: boolean;
  defaultLabel?: string; signedIn: boolean; readOnly?: boolean; canRemove?: boolean;
  refreshing?: boolean; error?: string; editButtonId?: string; removeButtonId?: string;
  editLabel: string; refreshLabel: string; removeLabel: string; statusLabel: string;
  reauthLabel?: string; quotaSlot?: ReactNode;
  onSelect?: () => void; onEdit?: () => void; onRefresh?: () => void;
  onRemove?: () => void; onReauth?: () => void;
}) {
  const inner = (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="m-0 flex min-w-0">
              <Button variant="link" onClick={onSelect} className="max-w-full justify-start text-foreground hover:text-accent-text">
                <span className="truncate">{alias}</span>
              </Button>
            </h3>
            {isDefault && defaultLabel && <Badge size="sm" tone="neutral">{defaultLabel}</Badge>}
          </div>
          {emailNode && <div className="truncate text-meta leading-4 text-text-secondary">{emailNode}</div>}
        </div>
        {!readOnly && (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton id={editButtonId} compact icon={Pencil} label={editLabel} onClick={onEdit} />
            {signedIn && <IconButton compact icon={RefreshCw} label={refreshLabel} busy={refreshing} onClick={onRefresh} />}
            {canRemove && <IconButton id={removeButtonId} compact icon={Trash2} label={removeLabel} onClick={onRemove} />}
          </div>
        )}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {quotaSlot ? quotaSlot : (
        <div className="flex min-h-(--kit-control-height) items-center justify-between gap-2 text-meta leading-4">
          <span data-signed-out={!signedIn || undefined} className={signedIn ? 'text-text-secondary' : 'text-danger'}>
            {statusLabel}
          </span>
          {!signedIn && reauthLabel && (
            <Button size="sm" variant="outline" data-account-reauth={accountId} onClick={onReauth}>
              {reauthLabel}
            </Button>
          )}
        </div>
      )}
    </>
  );

  const cardClass = 'gap-3 rounded-kit-card border border-border bg-surface p-4';
  if (CardWrapper) {
    return (
      <CardWrapper variant="reply" padded className={cardClass} role="region" aria-label={alias}>
        {inner}
      </CardWrapper>
    );
  }
  return (
    <Card padded className={cardClass} role="region" aria-label={alias}>
      {inner}
    </Card>
  );
}

export function EditAccountAliasFormView({
  formId, inputId, aliasLabel, alias, invalidError, error, onAliasChange, onSubmit,
}: {
  formId?: string; inputId?: string; aliasLabel: string; alias: string;
  invalidError?: string; error?: string;
  onAliasChange?: (value: string) => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form id={formId} className="agent-account-add-form flex flex-col gap-4" onSubmit={onSubmit}>
      {error && <Notice tone="danger">{error}</Notice>}
      <Field id={inputId} label={aliasLabel} error={invalidError}>
        <Input
          id={inputId}
          value={alias}
          readOnly={!onAliasChange}
          onChange={onAliasChange ? (event) => onAliasChange(event.target.value) : undefined}
          aria-invalid={Boolean(invalidError) || undefined}
          aria-describedby={invalidError && inputId ? `${inputId}-error` : undefined}
        />
      </Field>
    </form>
  );
}

export function RemoveAccountFormView({
  formId, consequence, error, onSubmit,
}: {
  formId?: string; consequence: string; error?: string;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form id={formId} className="agent-account-add-form flex flex-col gap-4" onSubmit={onSubmit}>
      {error && <Notice tone="danger">{error}</Notice>}
      <p className="m-0 text-small leading-5 text-text-secondary">{consequence}</p>
    </form>
  );
}

export function EditAccountAliasSurface({
  title, aliasLabel, alias, saveLabel, closeLabel,
}: {
  title: string; aliasLabel: string; alias: string; saveLabel: string; closeLabel?: string;
}) {
  return (
    <DialogSurface size="md" title={title} closeLabel={closeLabel} footer={<Button variant="primary">{saveLabel}</Button>}>
      <EditAccountAliasFormView aliasLabel={aliasLabel} alias={alias} />
    </DialogSurface>
  );
}

export function RemoveAccountSurface({
  title, consequence, removeLabel, closeLabel,
}: {
  title: string; consequence: string; removeLabel: string; closeLabel?: string;
}) {
  return (
    <DialogSurface size="md" title={title} closeLabel={closeLabel} footer={<Button variant="danger">{removeLabel}</Button>}>
      <RemoveAccountFormView consequence={consequence} />
    </DialogSurface>
  );
}
