import type { ReactNode } from "react";

export function GraphFeedback({children}:{children:ReactNode}){return <div className="text-small text-danger">{children}</div>}

export function GraphAction({children}:{children:ReactNode}){return <span className="relative grid size-[30px] place-items-center"><span className="absolute size-5 rounded-full bg-accent"/><span className="relative text-canvas">{children}</span></span>}

export function HubEntry({children}:{children:ReactNode}){return <button className="grid size-7 place-items-center rounded-full border-0 bg-transparent">{children}</button>}
