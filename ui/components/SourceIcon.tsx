import { controlSource, sourcePlatforms } from "../controlSources";
import { Plus, Plug } from "lucide-react";
import { sourceImages, sourceVectors } from "../assets/brand-reserve/control-sources";
import { BrandMark, Icon, type IconSize } from "./ui";
export default function SourceIcon({
  platform,
  add = false,
  panelVisual = false,
  size,
}: {
  platform: string;
  add?: boolean;
  panelVisual?: boolean;
  size?: IconSize;
}) {
  const icon = sourcePlatforms.find(p => p.id === platform)?.icon || controlSource(platform)?.icon || platform;
  const raw = sourceVectors[icon], image = sourceImages[icon];
  if (size !== undefined) {
    if (add) return <Icon icon={Plus} size={size} />;
    if (raw) return <BrandMark markup={raw} size={size} />;
    if (image) return <img src={image} alt="" draggable={false} style={{ width: size, height: size, objectFit: 'contain' }} />;
    return <Icon icon={Plug} size={size} />;
  }
  return (
    <span className="source-icon" data-panel-visual={panelVisual || undefined} aria-hidden="true">
      {add ? (
        <Icon icon={Plus} size={20} />
      ) : raw ? (
        <span dangerouslySetInnerHTML={{ __html: raw }} />
      ) : image ? (
        <img src={image} alt="" draggable={false} />
      ) : (
        <Icon icon={Plug} size={20} />
      )}
    </span>
  );
}
