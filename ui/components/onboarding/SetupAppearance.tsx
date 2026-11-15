import './SetupAppearance.css';
import type { ComponentProps } from "react";

import "../ui/SetupFlow.css";
export function SetupWelcome(props:ComponentProps<'section'>){return <section {...props} className="welcome-page"/>;}

export function SetupImpact(props:ComponentProps<'p'>){return <p {...props} className="hub-recovery-impact"/>;}
