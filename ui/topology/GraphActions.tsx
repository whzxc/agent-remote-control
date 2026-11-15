import './GraphActions.css';
import type { ComponentProps } from 'react';
import { IconButton } from '../components/ui/index';
import '../components/ui/GraphNode.css';





export function GraphAction(props:ComponentProps<typeof IconButton>){return <IconButton {...props} className="arc-action-button"/>}

export function HubEntry(props:ComponentProps<'button'>){return <button type="button" {...props} className={'hub-entry '+(props.className??'')}/>;}
