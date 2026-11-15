
export function GraphFeedback({children}:{children:unknown}){return <div class="text-small text-danger">{children}</div>}

export function GraphAction({children}:{children:unknown}){return <span class="relative grid size-[30px] place-items-center"><span class="absolute size-5 rounded-full bg-accent"/><span class="relative text-canvas">{children}</span></span>}

export function HubEntry({children}:{children:unknown}){return <button class="grid size-7 place-items-center rounded-full border-0 bg-transparent">{children}</button>}
