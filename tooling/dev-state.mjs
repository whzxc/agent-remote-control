import path from 'node:path';
import { homedir } from 'node:os';

const stateBase = process.platform === 'win32'
  ? process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local')
  : process.platform === 'linux'
    ? process.env.XDG_STATE_HOME || path.join(homedir(), '.local/state')
    : path.join(homedir(), '.local/state');

// Desktop development stays isolated and passes its directory to the Vite child.
export const devStateDir = path.resolve(process.env.ARC_STATE_DIR || path.join(stateBase, 'agent-remote-control-dev'));
// Standalone Dev Web uses the installed app unless an instance is explicitly selected.
export const webStateDir = path.resolve(process.env.ARC_STATE_DIR || path.join(stateBase, 'agent-remote-control'));
