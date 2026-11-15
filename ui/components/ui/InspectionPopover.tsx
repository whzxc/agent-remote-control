import {Popover} from 'radix-ui';
import type {ComponentProps} from 'react';
import './InspectionPopover.css';
export function InspectionPopover({variant,className='',...props}:ComponentProps<typeof Popover.Content>&{variant:'pet'|'studio'|'tuning'}){return <Popover.Content {...props} className={{pet:'pet-picker',studio:'studio-settings',tuning:'topology-tuner'}[variant]+' '+className}/>;}
