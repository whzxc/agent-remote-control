import { useContext } from 'react';
import { CloseContext } from '../ui/Dialog';
export function useDialogClose() { return useContext(CloseContext)?.close; }
