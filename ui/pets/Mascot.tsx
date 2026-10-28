import { useId, type CSSProperties } from 'react';
import type { PetAction } from './behavior';
import type { PetSize } from './geometry';
import type { MascotKind, Point } from './model';
import { mascotRig, type MascotContact } from './mascotGeometry';
import './mascots.css';

const cloud = 'M9.064 3.344a4.578 4.578 0 012.285-.312c1 .115 1.891.54 2.673 1.275.01.01.024.017.037.021a.09.09 0 00.043 0 4.55 4.55 0 013.046.275l.047.022.116.057a4.581 4.581 0 012.188 2.399c.209.51.313 1.041.315 1.595a4.24 4.24 0 01-.134 1.223.123.123 0 00.03.115c.594.607.988 1.33 1.183 2.17.289 1.425-.007 2.71-.887 3.854l-.136.166a4.548 4.548 0 01-2.201 1.388.123.123 0 00-.081.076c-.191.551-.383 1.023-.74 1.494-.9 1.187-2.222 1.846-3.711 1.838-1.187-.006-2.239-.44-3.157-1.302a.107.107 0 00-.105-.024c-.388.125-.78.143-1.204.138a4.441 4.441 0 01-1.945-.466 4.544 4.544 0 01-1.61-1.335c-.152-.202-.303-.392-.414-.617a5.81 5.81 0 01-.37-.961 4.582 4.582 0 01-.014-2.298.124.124 0 00.006-.056.085.085 0 00-.027-.048 4.467 4.467 0 01-1.034-1.651 3.896 3.896 0 01-.251-1.192 5.189 5.189 0 01.141-1.6c.337-1.112.982-1.985 1.933-2.618.212-.141.413-.251.601-.33.215-.089.43-.164.646-.227a.098.098 0 00.065-.066 4.51 4.51 0 01.829-1.615 4.535 4.535 0 011.837-1.388z';
const path = (joints: Point[]) => joints.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ');
export default function Mascot({ kind, size, action = 'idle', contact, facing = 1, walking = false, animate = false, slow = false, tempo = 1, delay = 0 }: {
  kind: MascotKind; size: PetSize; action?: PetAction; contact?: MascotContact; facing?: -1 | 1; walking?: boolean; animate?: boolean; slow?: boolean; tempo?: number; delay?: number;
}) {
  const id = useId().replaceAll(':', ''), rig = mascotRig(kind, action, contact, facing), square = kind === 'clawd';
  const fill = square ? '#d97757' : '#8187f5', edge = square ? '#bc6046' : '#6570de';
  const arm = (points: Point[], side: 'left' | 'right') => <g className={`mascot-arm mascot-arm-${side}`}>
    <path d={path(points)} fill="none" stroke={edge} strokeWidth={square ? 15 : 14} strokeLinejoin={square ? 'miter' : 'round'} strokeLinecap={square ? 'square' : 'round'} />
    <path d={path(points)} fill="none" stroke={fill} strokeWidth={square ? 11 : 10} strokeLinejoin={square ? 'miter' : 'round'} strokeLinecap={square ? 'square' : 'round'} />
    {square ? <path d={`M${points[2].x - 8} ${points[2].y - 7}h16v15h-16z`} fill="#e48b67" /> : <circle cx={points[2].x} cy={points[2].y} r="8" fill="#a7afff" stroke={edge} strokeWidth="1.5" />}
  </g>;
  const sitting = contact === 'sit', hanging = contact === 'swing';
  const leg = (x: number, side: 'left' | 'right', index = 0) => {
    const sign = side === 'left' ? -1 : 1, hip = square ? 153 : 148;
    const points = sitting ? [pt(x, hip), pt(x + sign * 7, hip + 17), pt(x + sign * 18, hip + 18)]
      : hanging ? [pt(x, hip), pt(x + sign * (index ? 4 : 9), 162), pt(x + sign * (index ? 2 : 7), 178)]
      : [pt(x, hip), pt(x, 162), pt(x + sign * 4, 175)];
    const end = points[2];
    return <g key={`${side}-${index}`} className={`mascot-leg mascot-leg-${side}`} style={{ '--leg-delay': `${index * -.24}s` } as CSSProperties}>
      <path d={path(points)} fill="none" stroke={edge} strokeWidth={square ? 9 : 11} strokeLinejoin={square ? 'miter' : 'round'} strokeLinecap={square ? 'square' : 'round'} />
      {square ? <path d={`M${end.x - 6} ${end.y - 4}h12v8h-12z`} fill={fill} /> : <rect x={end.x - 11} y={end.y - 5} width="22" height="11" rx="5.5" fill="#929cff" stroke={edge} strokeWidth="1.5" />}
    </g>;
  };
  return <svg className="pet-mascot" data-kind={kind} data-action={action} data-contact={contact} data-facing={facing} data-walking={walking || undefined} data-motion={animate || undefined}
    aria-hidden="true" viewBox="0 0 192 208" width={size.width} height={size.height} style={{ '--mascot-tempo': `${tempo * (slow ? 1.3 : 1)}s`, '--mascot-delay': `${delay}ms` } as CSSProperties}>
    <defs><linearGradient id={`${id}-cloud`} x1="0" x2=".2" y1="0" y2="1"><stop stopColor="#c0b1ff" /><stop offset=".48" stopColor="#8a9bff" /><stop offset="1" stopColor="#5860ef" /></linearGradient></defs>
    <g className="mascot-rig">
      <g className="mascot-legs">{square ? <>{leg(61, 'left')}{leg(78, 'left', 1)}{leg(114, 'right', 1)}{leg(131, 'right')}</> : <>{leg(72, 'left')}{leg(120, 'right')}</>}</g>
      {arm(rig.left, 'left')}
      <g className="mascot-body">
        {square ? <>
          <path d="M42 83h108v72H42z" fill="#d97757" />
          <path d="M42 83h108v6H42z" fill="#efa17d" /><path d="M42 149h108v6H42z" fill="#c86b4e" />
          <g className="mascot-eyes" style={{ transform: `translateX(${facing * 2}px)` }}>
            <path className="mascot-eye-open" d={action === 'tired' ? 'M66 109h8v5h-8zm52 0h8v5h-8z' : 'M66 100h8v15h-8zm52 0h8v15h-8z'} fill="#422a22" />
            <path className="mascot-eye-closed" d="M65 109h10v4H65zm52 0h10v4h-10z" fill="#422a22" />
          </g>
        </> : <>
          <path d={cloud} transform="translate(29 39) scale(5.6)" fill={`url(#${id}-cloud)`} stroke="#7280ed" strokeWidth=".28" />
          <path d="M81 96l12 17-12 17" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
          <path className="mascot-cursor" d="M105 130h22" fill="none" stroke="#fff" strokeWidth="7" strokeLinecap="round" />
          <path d="M63 81c6-10 14-13 22-12" fill="none" stroke="#eeedff" strokeOpacity=".5" strokeWidth="3" strokeLinecap="round" />
        </>}
      </g>
      {arm(rig.right, 'right')}
      {action === 'work' && <g className="mascot-work-sparks" fill={square ? '#f6b078' : '#c3d6ff'}><path d="M66 143h4v5h-4zm28-8h4v5h-4zm28 8h4v5h-4z" /></g>}
    </g>
  </svg>;
}
function pt(x: number, y: number) { return { x, y }; }
