import { useState } from "react";
import { controlSource, controlSources } from "../controlSources";
import { t } from "../i18n";
import { SourceProductChoiceView } from "./connectivity/SourceProductChoiceView";

const common = ["claude", "chatgpt", "gemini", "grok"];

export default function SourceProductChoice({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [more, setMore] = useState(false);
  const overflow = more || !common.includes(value);
  const overflowSources = [
    ...controlSources.filter((source) => source.id !== "local-cli"),
    ...(!controlSource(value) ? [{ id: value, shortName: value }] : []),
  ];

  return (
    <SourceProductChoiceView
      label={t("source.product")}
      moreLabel={t("source.moreProducts")}
      primaryValue={overflow ? "more" : value}
      primaryOptions={[
        ...common.map((id) => ({
          value: id,
          label: controlSource(id)!.shortName,
        })),
        { value: "more", label: t("source.moreProducts") },
      ]}
      onPrimaryChange={(next) => {
        setMore(next === "more");
        if (next !== "more") onChange(next);
      }}
      showOverflow={overflow}
      overflowValue={value}
      overflowOptions={overflowSources.map((source) => ({
        value: source.id,
        label: source.id === "custom" ? t("connect.other") : source.shortName,
      }))}
      onOverflowChange={onChange}
      disabled={disabled}
    />
  );
}
