import descriptor from '../native/src/ingress/config.json';
import type { Config } from './state/types';
import type { ConnectionForm } from './state/connectionForm';

export type SecretField = Extract<keyof ConnectionForm, 'apiKey' | 'cloudflareToken' | 'ngrokAuthtoken' | 'pinggyToken' | 'localxposeAccessToken'>;
type SavedFlag = Extract<keyof Config, `has${string}`>;
type ModeField = 'cloudflareMode' | 'ngrokMode' | 'pinggyMode' | 'localxposeMode';
interface Provider {
  label: string;
  mode: ModeField | null;
  modes: ('named' | 'quick')[];
  credential: SecretField | null;
  tokenRequired: 'always' | 'named' | 'never';
  credentialLabel: string;
  help: string;
}
export const providers = descriptor.providers as Record<Config['httpsProvider'], Provider>;
export const secretFields = Object.entries(descriptor.fields).flatMap(([key, field]) =>
  'savedFlag' in field ? [{ key: key as SecretField, savedFlag: field.savedFlag as SavedFlag }] : []);
export const configDefaults = Object.fromEntries(Object.entries(descriptor.fields).map(([key, field]) => [key, field.default])) as Record<keyof Config, string | number | boolean>;
export function fixedDomain(form: ConnectionForm): boolean {
  const provider = providers[form.httpsProvider];
  return form.connectionMode === 'https' && (!provider.mode || form[provider.mode] === 'named');
}
export function needsCredential(form: ConnectionForm): boolean {
  if (form.httpsProvider === "cloudflare" && form.cloudflareAuth === "login") return false;
  const provider = providers[form.httpsProvider];
  return provider.tokenRequired === 'always' || provider.tokenRequired === 'named' && fixedDomain(form);
}
export function credentialSaved(config: Config | undefined, key: SecretField): boolean {
  const flag = secretFields.find(field => field.key === key)!.savedFlag;
  return !!config?.[flag];
}
export function clearCredentials(form: ConnectionForm): void {
  for (const { key } of secretFields) form[key] = '';
}
