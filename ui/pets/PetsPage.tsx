import { useEffect, useRef, useState } from 'react';
import { PawPrint } from 'lucide-react';
import { t } from '../i18n';
import { Button, Field, Input, Notice, SingleChoice, Switch, Icon } from '../components/ui';
import { connector, orderedSources } from '../state/connector';
import { agents, name } from '../state/agents';
import { petBrand, recommendations, type PetBrand, type PetPackage, type Participant } from './model';
import { assignPet, installPet, petAsset, petAssets, petAssignments, petLibrary, refreshPets, showPets } from './state';
import PetSprite from './PetSprite';
import { usePetMotion } from './usePetMotion';
export function PetsSwitch() { const checked = showPets.use(); return <Switch label={t('pets.show')} checked={checked} onChange={showPets.set} />; }
function Preview({ pet }: { pet: PetPackage }) {
  const assets = petAssets.use(), motion = usePetMotion();
  useEffect(() => { void petAsset(pet.key).catch(() => {}); }, [pet.key]);
  return assets[pet.key] ? <PetSprite pet={pet} url={assets[pet.key]} animate={motion.animate} slow /> : <Icon icon={PawPrint} size={20} />;
}
export default function PetsPage() {
  const library = petLibrary.use(), assignments = petAssignments.use();
  const agentState = agents.use(); connector.use();
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { void refreshPets(); }, []);
  const participants: Participant[] = [
    ...orderedSources().filter(s => s.state !== 'revoked').map(s => ({ id: `source:${s.id}`, nativeId: s.id, name: s.label, kind: 'source' as const, brand: petBrand(s.product) })),
    ...agentState.items.map(a => ({ id: `agent:${a.agent}`, nativeId: a.agent, name: name(a), kind: 'agent' as const, brand: petBrand(a.agent) })),
  ];
  async function install(input: { url: string } | File) {
    setBusy(true); setError('');
    try {
      if (input instanceof File) {
        if (input.size > 25 * 1024 * 1024) throw new Error(t('pets.sizeLimit'));
        const bytes = new Uint8Array(await input.arrayBuffer());
        let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        await installPet({ zip: btoa(binary) });
      } else await installPet(input);
    } catch (e) { setError(String(e)); document.getElementById('pet-link')?.focus(); }
    finally { setBusy(false); if (file.current) file.current.value = ''; }
  }
  const options = [{ value: '', label: t('pets.brandDefault') }, ...library.packages.map(p => ({ value: p.key, label: `${p.name} · ${p.origin === 'codex' ? 'Codex' : 'ARC'}` }))];
  const metadata = (pet?: PetPackage) => <dl className="pet-metadata">
    <dt>{t('pets.author')}</dt><dd>{pet?.source.author || t('pets.notProvided')}</dd>
    <dt>{t('pets.license')}</dt><dd>{pet?.source.license || t('pets.notProvided')}</dd>
    {pet?.source.attribution && <><dt>{t('pets.attribution')}</dt><dd>{pet.source.attribution}</dd></>}
  </dl>;
  return <div className="pets-page">
    {error && <Notice tone="danger">{error}</Notice>}
    {library.error && <Notice tone="danger">{library.error}<Button onClick={() => void refreshPets()}>{t('retry')}</Button></Notice>}
    <form onSubmit={e => { e.preventDefault(); void install({ url }); }}>
      <Field id="pet-link" label={t('pets.link')}><Input id="pet-link" value={url} onChange={e => setUrl(e.target.value)} type="url" required aria-invalid={!!error} aria-describedby={error ? 'pets-import-error' : undefined} /></Field>
      {error && <span id="pets-import-error" role="alert">{error}</span>}
      <div className="pet-actions"><Button type="submit" busy={busy} disabled={!url}>{t('pets.install')}</Button><Button disabled={busy} onClick={() => file.current?.click()}>{t('pets.chooseZip')}</Button></div>
      <input hidden ref={file} type="file" accept=".zip,application/zip" onChange={e => { const selected = e.target.files?.[0]; if (selected) void install(selected); }} />
    </form>
    {(['claude', 'codex', 'other'] as PetBrand[]).map(brand => <section key={brand} className="pet-group">
      <h2>{t(`pets.${brand}`)}</h2>
      <SingleChoice label={t('pets.defaultPet')} value={assignments[`brand:${brand}`] ?? ''} options={options} onChange={key => assignPet(`brand:${brand}`, key)} />
      <div className="pet-catalog">{recommendations.filter(r => r.brand === brand).map(rec => {
        const installed = library.packages.find(p => p.id === rec.id);
        return <article key={rec.id} className="pet-package">
          <div className="pet-preview">{installed ? <Preview pet={installed} /> : <Icon icon={PawPrint} size={20} />}</div>
          <div><h3>{rec.name}{rec.selected && <span className="pet-default">{t('pets.recommendedDefault')}</span>}</h3>
            <a href={rec.url} target="_blank" rel="noreferrer">{new URL(rec.url).hostname} · {t('pets.originalPage')}</a>
            {metadata(installed)}<Button busy={busy} disabled={!!installed} onClick={() => void install({ url: rec.url })}>{t(installed ? 'pets.installed' : 'pets.install')}</Button></div>
        </article>;
      })}</div>
    </section>)}
    <section className="pet-group"><h2>{t('pets.installed')}</h2>{!library.packages.length && <p>{t(library.loading ? 'pets.loading' : 'pets.empty')}</p>}
      <div className="pet-catalog">{library.packages.map(p => <article className="pet-package" key={p.key}><div className="pet-preview"><Preview pet={p} /></div><div><h3>{p.name}</h3><p>{p.source.site} · {p.origin === 'codex' ? t('pets.readOnly') : 'ARC'}</p>{metadata(p)}{p.source.pageUrl && <a href={p.source.pageUrl} target="_blank" rel="noreferrer">{t('pets.originalPage')}</a>}</div></article>)}</div>
      {library.errors.map(e => <Notice key={e.key} tone="danger">{e.error}</Notice>)}
    </section>
    <section className="pet-group"><h2>{t('pets.participants')}</h2>{participants.map(p => <Field key={p.id} label={p.name}><SingleChoice label={p.name} value={assignments[p.id] ?? ''} options={options} onChange={key => assignPet(p.id, key)} /></Field>)}</section>
    <nav className="pet-actions" aria-label={t('pets.community')}>{['codex-pets.net', 'codexpet.top', 'openpets.dev'].map(site => <a key={site} href={`https://${site}`} target="_blank" rel="noreferrer">{site}</a>)}</nav>
    <footer>{t('pets.rights')}</footer>
  </div>;
}
