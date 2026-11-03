import { readOnlyBrowser } from "../browserMode";
import { Children, createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { t } from "../i18n";
import { openUrl } from "../platform";
import { timelineLink, timelineUrl } from "../state/timelineLinks";
import { Icon } from "./ui";

const ResourceContext = createContext({ agent: "", id: "" });
export function TimelineResources({ agent, id, children }: { agent: string; id: string; children: ReactNode }) {
  const value = useMemo(() => ({ agent, id }), [agent, id]);
  return <ResourceContext.Provider value={value}>{children}</ResourceContext.Provider>;
}
function headingText(children: ReactNode): string {
  return Children.toArray(children).map(child => isValidElement<{ children?: ReactNode }>(child)
    ? headingText(child.props.children) : typeof child === "string" || typeof child === "number" ? String(child) : "").join("");
}
function heading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return function Heading({ children }: { children?: ReactNode }) {
    const id = headingText(children).toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
    return <Tag id={id}>{children}</Tag>;
  };
}
const headings = { h1: heading("h1"), h2: heading("h2"), h3: heading("h3"), h4: heading("h4"), h5: heading("h5"), h6: heading("h6") };
function TimelineImage({ src = "", alt }: { src?: string; alt?: string }) {
  const { agent, id } = useContext(ResourceContext);
  const link = timelineLink(src);
  const [local, setLocal] = useState<{ source: string; url: string }>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    if (link?.kind !== "file") return;
    let stopped = false;
    void api<{ src: string }>("agents/resources", "POST", { agent, id, path: link.target, action: "image" })
      .then(result => { if (!stopped) setLocal({ source: src, url: result.src }); })
      .catch(() => { if (!stopped) setFailed(src); });
    return () => { stopped = true; };
  }, [agent, id, src]);
  const url = link?.kind === "image" || link?.kind === "external" && /^https?:\/\//i.test(link.target)
    ? link.target : local?.source === src ? local.url : undefined;
  if (!url || failed === src) return <span className="timeline-image-placeholder" role="img" aria-label={alt || t("timeline.imageUnavailable")} title={alt || t("timeline.imageUnavailable")}><Icon icon={Image} /></span>;
  return <img src={url} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(src)} />;
}
export default memo(function TimelineMarkdown({ text }: { text: string }) {
  const { agent, id } = useContext(ResourceContext);
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  return <div ref={root} className="markdown timeline-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={timelineUrl} components={{
    ...headings,
    a: ({ href = "", children }) => {
      const link = timelineLink(href);
      if (!link || link.kind === "image" || readOnlyBrowser && link.kind === "file") return <span>{children}</span>;
      return <a href={href} title={link.kind === "file" ? t("timeline.revealFile", { path: link.target }) : undefined} onClick={event => {
        event.preventDefault();
        setError("");
        if (link.kind === "fragment") {
          let anchor: string;
          try { anchor = decodeURIComponent(link.target); } catch { return; }
          root.current?.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: "nearest" });
          return;
        }
        void (link.kind === "file"
          ? api("agents/resources", "POST", { agent, id, path: link.target, action: "reveal" })
          : openUrl(link.target)).catch(reason => setError(String(reason)));
      }}>{children}</a>;
    },
    img: ({ src, alt }) => <TimelineImage src={src} alt={alt} />,
    table: ({ children }) => <div className="timeline-table"><table>{children}</table></div>,
  }}>{text}</ReactMarkdown>{error && <span className="timeline-link-error" role="alert">{error}</span>}</div>;
});
