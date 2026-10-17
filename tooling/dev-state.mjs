import path from 'node:path';
import { homedir } from 'node:os';

// Both the desktop process and Vite resolve the same persistent development owner.
export const devStateDir = path.resolve(process.env.ARC_STATE_DIR || path.join(
  process.platform === 'win32' ? process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local') : process.platform === 'linux' ? process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state') : path.join(homedir(), '.local/state'),
  'agent-remote-control-dev',
));
