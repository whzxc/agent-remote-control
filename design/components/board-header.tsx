import { Frame } from "sdg";
const forms = [
  { name: "active", summary: "2 进行中" },
  { name: "idle", summary: "" },
];
const example = { date: "1月1日 · 周四", time: "08:00", title: "公示牌" };
export function BoardHeader({
  date,
  time,
  title,
  summary,
  dateTime,
  clockLabel,
  openLabel,
}: {
  date: string;
  time: string;
  title: string;
  summary?: string;
  dateTime?: string;
  clockLabel?: string;
  activityLabel?: string;
  openLabel?: string;
}) {
  return (
    <header class="flex w-60 flex-col items-center text-text">
      <span class="text-small leading-5 text-text-secondary">{date}</span>
      <time
        datetime={dateTime}
        title={clockLabel}
        class="text-display leading-[38px] font-[650] tabular-nums"
      >
        {time}
      </time>
      <button
        aria-label={openLabel}
        class="flex items-center justify-center h-[30px] text-body font-semibold"
      >
        {summary || title}
      </button>
    </header>
  );
}
export default () =>
  forms.map(({ name, summary }) => (
    <Frame name={name}>
      <BoardHeader {...example} summary={summary} />
    </Frame>
  ));
