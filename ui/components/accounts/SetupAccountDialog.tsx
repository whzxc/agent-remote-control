import '../onboarding/SetupAppearance.css';
import type { ComponentProps } from "react";

import { Dialog } from "../ui/index";
import "../ui/SetupFlow.css";
export function SetupAccountDialog(props:ComponentProps<typeof Dialog>){return <Dialog {...props} className="agent-account-add"/>;}
