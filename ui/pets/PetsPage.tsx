import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { t } from '../i18n';
import { openUrl } from '../platform';
import { Button, Field, Input, Notice, Switch } from '../components/ui';
import { assignPet, installPet, removePet, petAssignments, petLibrary, refreshPets, showPets } from './state';
import PetPreview from './PetPreview';
export function PetsSwitch() { const checked = showPets.use(); return <Switch label={t('pets.show')} checked={checked} onChange={showPets.set} />; }
export default function PetsPage() {
  const library = petLibrary.use(), assignments = petAssignments.use();
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { void refreshPets(); }, []);
  async function install(input: { url: string } | File) {
    setBusy(true); setError('');
    try {
      if (input instanceof File) {
        if (input.size > 25 * 1024 * 1024) throw new Error(t('pets.sizeLimit'));
        const bytes = new Uint8Array(await input.arrayBuffer());
        let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await installPet({ zip: btoa(binary) });
      } else { await installPet(input); setUrl(''); }
    } catch (e) { setError(String(e)); document.getElementById('pet-link')?.focus(); }
    finally { setBusy(false); if (file.current) file.current.value = ''; }
  }
  async function remove(key: string) {
    setBusy(true); setError('');
    try { await removePet(key); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  function visit(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault(); void openUrl(event.currentTarget.href).catch(error => setError(String(error)));
  }
  return <div className="pets-page">
    <section className="pet-import">
      <nav className="pet-actions" aria-label={t('pets.community')}>{['codex-pets.net', 'codexpet.top', 'openpets.dev'].map(site => <a onClick={visit} key={site} href={`https://${site}`} target="_blank" rel="noreferrer">{site}</a>)}</nav>
      <form onSubmit={e => { e.preventDefault(); void install({ url }); }}>
        <Field id="pet-link" label={t('pets.link')}><Input id="pet-link" placeholder={t('pets.linkPlaceholder')} value={url} onChange={e => setUrl(e.target.value)} readOnly={busy} type="url" required aria-invalid={!!error} aria-describedby={error ? 'pets-import-error' : undefined} /></Field>
        <div className="pet-actions"><Button type="submit" busy={busy} disabled={!url.trim()}>{t('pets.install')}</Button><Button disabled={busy} onClick={() => file.current?.click()}>{t('pets.chooseZip')}</Button></div>
        <input hidden ref={file} type="file" accept=".zip,application/zip" onChange={e => { const selected = e.target.files?.[0]; if (selected) void install(selected); }} />
      </form>
      {error && <div id="pets-import-error" role="alert"><Notice tone="danger">{error}</Notice></div>}
    </section>
    {library.error && <Notice tone="danger">{library.error}<Button onClick={() => void refreshPets()}>{t('retry')}</Button></Notice>}
    <section className="pet-group"><h2>{t('pets.installed')}</h2>{!library.packages.length && <p>{t(library.loading ? 'pets.loading' : 'pets.empty')}</p>}
      <div className="pet-catalog">{library.packages.map(p => <article className="pet-package" key={p.key}>
        <PetPreview pet={p} />
        <div className="pet-package-content">
          <h3 title={p.name}>{p.name}</h3>
          <p className="pet-description" title={p.description ?? undefined}>
            {p.origin === 'builtin' ? t('pets.builtIn') : p.origin === 'codex' ? t('pets.readOnly') : p.source.pageUrl ? <a onClick={visit} href={p.source.pageUrl} target="_blank" rel="noreferrer">{p.source.site}</a>
              : p.source.site === 'zip' ? t('pets.localZip') : p.description || p.source.site}
          </p>
          <div className="pet-actions">
            <Button disabled={busy || assignments.default === p.key} onClick={() => assignPet('default', p.key)}>{t(assignments.default === p.key ? 'pets.defaultPet' : 'pets.setDefault')}</Button>
            {p.origin === 'arc' && <Button variant="danger-outline" disabled={busy} aria-label={t('pets.remove', { name: p.name })} onClick={() => void remove(p.key)}>{t('remove')}</Button>}
          </div>
        </div>
      </article>)}</div>
      {library.errors.map(e => <Notice key={e.key} tone="danger">{e.error}</Notice>)}
    </section>
    <footer>{t('pets.rights')}</footer>
  </div>;
}
