import path from 'node:path';
import { homedir } from 'node:os';

// Development and installed runtimes share the same explicitly selected state.
const defaultState = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local'), 'agent-remote-control')
  : path.join(homedir(), '.agent-remote-control');
export const stateDir = path.resolve(process.env.ARC_STATE_DIR || defaultState);
