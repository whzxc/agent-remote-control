import { Image as NativeImage } from "@tauri-apps/api/image";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";

// Read the already-rendered rows so exports follow the same display preferences,
// estimates and quota calculations as the panel, without exporting hover details.
export async function renderShareCard(
  card: HTMLElement,
  iconUrl?: string,
): Promise<HTMLCanvasElement> {
  await document.fonts.ready;
  const text = (selector: string, root: Element = card) =>
    root.querySelector(selector)?.textContent?.trim() ?? "";
  const ink = getComputedStyle(card).color;
  const muted = getComputedStyle(
    card.querySelector(".reading-meta>span:last-child") ?? card,
  ).color;
  const background = getComputedStyle(card).backgroundColor;
  const readings = [...card.querySelectorAll(".bubble-reading")].map((row) => ({
    title: text(".reading-title>span:first-child", row),
    estimate: text(".quota-estimate", row),
    pace: text(".pace-warning", row),
    remaining: text(".reading-meta>span:first-child", row),
    reset: text(".reading-meta>span:last-child", row),
    color: getComputedStyle(row.querySelector(".reading-track div")!)
      .backgroundColor,
    track: getComputedStyle(row.querySelector(".reading-track")!)
      .backgroundColor,
    percent:
      parseFloat(
        (row.querySelector(".reading-track div") as HTMLElement).style.width,
      ) || 0,
  }));
  const history = [
    ...card.querySelectorAll(".usage-history>.history-period"),
  ].map((row) => ({
    label: text(":scope>span", row),
    value: text(".history-toggle", row),
  }));
  const canvas = document.createElement("canvas");
  const width = 380,
    padding = 24,
    inner = width - padding * 2;
  const height = 86 + readings.length * 94 + history.length * 30 + 48;
  canvas.width = width * 4;
  canvas.height = height * 4;
  const ctx = canvas.getContext("2d")!;
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.scale(4, 4);
  ctx.textBaseline = "middle";
  ctx.fillStyle = background;
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, 22);
  ctx.fill();
  function label(
    value: string,
    x: number,
    y: number,
    size = 12,
    color = ink,
    weight = 400,
    max = inner,
    align: CanvasTextAlign = "left",
  ) {
    ctx.font = `${weight} ${size}px ${getComputedStyle(card).fontFamily}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    let output = value;
    while (output.length && ctx.measureText(output).width > max)
      output = output.slice(0, -1);
    if (output !== value) output = output.slice(0, -1) + "…";
    ctx.fillText(output, x, y);
  }
  if (iconUrl) {
    const icon = new Image();
    icon.src = iconUrl;
    await icon.decode();
    const mask = document.createElement("canvas");
    mask.width = 96;
    mask.height = 96;
    const m = mask.getContext("2d")!;
    m.drawImage(icon, 0, 0, 96, 96);
    m.globalCompositeOperation = "source-in";
    m.fillStyle = ink;
    m.fillRect(0, 0, 96, 96);
    ctx.drawImage(mask, padding, 27, 24, 24);
  }
  label(
    text(".subscription-link") || text(".subscription-heading>strong"),
    padding + 34,
    39,
    16,
    ink,
    600,
    inner - 34,
  );
  const plan = text(".provider-plan");
  if (plan) label(plan, padding + 34, 60, 11, muted);
  // Keep the warning visible without exposing account/error details in a share image.
  const warning = card.querySelector(".subscription-notice svg");
  if (warning) {
    const svg = warning.cloneNode(true) as SVGElement;
    svg.setAttribute("stroke", muted);
    const icon = new Image();
    icon.src =
      "data:image/svg+xml," +
      encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await icon.decode();
    ctx.drawImage(icon, width - padding - 16, 52, 16, 16);
  }
  let y = 88;
  for (const row of readings) {
    label(row.title, padding, y, 13, ink, 600);
    if (row.estimate)
      label(
        row.estimate,
        width - padding,
        y,
        11,
        muted,
        400,
        inner * 0.58,
        "right",
      );
    if (row.pace)
      label(row.pace, width - padding, y + 20, 11, muted, 400, inner, "right");
    ctx.fillStyle = row.track;
    ctx.beginPath();
    ctx.roundRect(padding, y + 33, inner, 6, 3);
    ctx.fill();
    const filled = (Math.max(0, Math.min(100, row.percent)) / 100) * inner;
    if (filled) {
      ctx.fillStyle = row.color;
      ctx.beginPath();
      ctx.roundRect(padding, y + 33, filled, 6, Math.min(3, filled / 2));
      ctx.fill();
    }
    label(row.remaining, padding, y + 55);
    label(
      row.reset,
      width - padding,
      y + 55,
      12,
      muted,
      400,
      inner / 2,
      "right",
    );
    y += 94;
  }
  for (const row of history) {
    label(row.label, padding, y);
    label(row.value, width - padding, y, 12, ink, 400, inner * 0.74, "right");
    y += 30;
  }
  label(
    "ARC",
    width / 2,
    height - 24,
    11,
    muted,
    500,
    inner,
    "center",
  );
  return canvas;
}

export async function copyShareCard(card: HTMLElement, iconUrl?: string) {
  const canvas = await renderShareCard(card, iconUrl);
  const rgba = canvas
    .getContext("2d")!
    .getImageData(0, 0, canvas.width, canvas.height).data;
  const image = await NativeImage.new(
    new Uint8Array(rgba.buffer),
    canvas.width,
    canvas.height,
  );
  try {
    await writeImage(image);
  } finally {
    await image.close();
  }
}
