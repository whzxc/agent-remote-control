import { useContext } from 'react';
import { CloseContext } from '../ui/LayerPortals';
export function useDialogClose() { return useContext(CloseContext)?.close; }
