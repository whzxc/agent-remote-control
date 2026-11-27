import type { ReactElement, ReactNode } from "react";
import { useI18n } from "../../i18n/react";

export interface ReleaseNoteBullet {
  text: string;
  version?: string;
}

export interface ReleaseNoteEntry {
  version: string;
  markdown: string;
}

export interface ReleaseNoteGroup {
  title: string;
  bullets?: readonly ReleaseNoteBullet[];
  entries?: readonly ReleaseNoteEntry[];
}

export function ReleaseNoteGroupsView({
  groups,
  showVersions = false,
  headingLevel = "h3",
  renderMarkdown,
}: {
  groups: readonly ReleaseNoteGroup[];
  showVersions?: boolean;
  headingLevel?: "h3" | "h4";
  renderMarkdown?: (text: string, inline?: boolean) => ReactNode;
}): ReactElement {
  const { t } = useI18n();
  const Heading = headingLevel;

  if (!groups.length) {
    return (
      <p className="m-0 text-small leading-5 text-text-secondary">
        {t("updates.noNotes")}
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {groups.map((group) => (
        <section key={group.title} className="flex min-w-0 flex-col gap-1.5">
          <Heading className="m-0 text-small font-semibold leading-4 text-foreground">
            {group.title}
          </Heading>
          {group.bullets ? (
            <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-small leading-5 text-text-secondary">
              {group.bullets.map((bullet, index) => (
                <li key={`${group.title}-${index}`} className="wrap-anywhere">
                  {renderMarkdown
                    ? renderMarkdown(bullet.text, true)
                    : bullet.text}
                  {showVersions && bullet.version && (
                    <span className="ml-2 whitespace-nowrap font-mono text-meta text-text-tertiary">
                      {bullet.version}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col gap-1.5 text-small leading-5 text-text-secondary">
              {(group.entries ?? []).map((entry) => (
                <div
                  key={`${entry.version}:${entry.markdown}`}
                  className="flex flex-col gap-1 wrap-anywhere"
                >
                  {showVersions && (
                    <p className="m-0 font-mono text-meta text-text-tertiary">
                      {entry.version}
                    </p>
                  )}
                  {renderMarkdown ? (
                    renderMarkdown(entry.markdown, false)
                  ) : (
                    <p className="m-0">{entry.markdown}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
