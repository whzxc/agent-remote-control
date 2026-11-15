import '../onboarding/SetupAppearance.css';
import type { ComponentProps } from "react";

import "../ui/SetupFlow.css";
export function SetupApproval(props:ComponentProps<'form'>){return <form {...props} className={'pairing-card '+(props.className??'')}/>;}
