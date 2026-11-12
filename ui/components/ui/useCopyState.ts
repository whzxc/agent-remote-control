import { useEffect, useRef, useState } from 'react';
import { copyText } from '../../platform';
import { t } from '../../i18n';

/** One confirmation and error state for every copy control. */
export function useCopyState() {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (value: string) => {
    clearTimeout(timer.current); setError('');
    try { await copyText(value); setCopied(true); timer.current = setTimeout(() => setCopied(false), 2000); return true; }
    catch { setCopied(false); setError(t('copyFailedSelectAndCopyTheTextManually')); return false; }
  };
  return { copied, error, copy };
}
