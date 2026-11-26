export const mygoUpdatePublicKey = 'vun1OHjcZYD/xOgFtgjmkjvUF+cM6yV/9KX2N+TNqKo=';

export function resolveMygoUpdatePublicKey(env, development = false, fixture = false) {
  if (development && !fixture) return '';
  return env.ARC_MYGO_UPDATE_PUBLIC_KEY?.trim() || (development ? '' : mygoUpdatePublicKey);
}
