import { Monitor } from 'lucide-react';
import { Button, Icon } from '../components/ui';
import { t } from '../i18n';
import { navigation } from '../state/navigation';
import { deviceLinkEnabled, deviceSnapshot, pairedDevices } from './state';

export default function DeviceSummary() {
  const enabled = deviceLinkEnabled.use(), snapshot = deviceSnapshot.use();
  if (!enabled || !snapshot) return null;
  const devices = pairedDevices(snapshot);
  return <Button onClick={() => navigation.set(old => ({ ...old, page: 'devices' }))}><Icon icon={Monitor} />{t('device.topologySummary', { count: devices.length, online: devices.filter(device => device.state === 'online').length })}</Button>;
}
