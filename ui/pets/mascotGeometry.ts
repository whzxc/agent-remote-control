import type { PetAction } from './behavior';
import type { MascotKind, Point } from './model';

export type MascotContact = 'sit' | 'swing' | 'pull';
export interface MascotRig { left: [Point, Point, Point]; right: [Point, Point, Point]; hand: Point; grip: Point; seat: Point; feet: Point }
const pt = (x: number, y: number): Point => ({ x, y });
export function mascotActionForRow(row: number): PetAction {
  return row === 3 || row === 4 ? 'celebrate' : row === 5 ? 'tired' : row === 6 ? 'wait' : row === 7 ? 'work' : row === 8 ? 'think' : 'idle';
}

// Joints use the same 192 × 208 stage as imported atlases. The body and terminal
// mark never mirror; only reach direction changes, so Codex stays readable.
export function mascotRig(kind: MascotKind, action: PetAction = 'idle', contact?: MascotContact, facing: -1 | 1 = 1): MascotRig {
  let left: [Point, Point, Point] = [pt(51, 111), pt(39, 118), pt(33, 132)];
  let right: [Point, Point, Point] = [pt(141, 111), pt(153, 118), pt(159, 132)];
  let hand = right[2], grip = pt(96, 49);
  const seat = pt(96, kind === 'clawd' ? 155 : 153), feet = pt(96, 177);
  if (contact === 'swing') {
    left = [pt(53, 110), pt(63, 70), pt(85, 49)]; right = [pt(139, 110), pt(129, 70), pt(107, 49)]; hand = grip;
  } else if (contact === 'pull') {
    left = [pt(53, 112), pt(106, 125), pt(164, 116)]; right = [pt(139, 112), pt(151, 105), pt(170, 111)];
    grip = pt(167, 113); hand = grip;
  } else if (action === 'give') {
    left = [pt(53, 112), pt(45, 124), pt(54, 137)]; right = [pt(139, 108), pt(153, 101), pt(171, 105)]; hand = right[2];
  } else if (action === 'catch') {
    left = [pt(53, 112), pt(108, 124), pt(158, 125)]; right = [pt(139, 108), pt(154, 92), pt(171, 102)]; hand = pt(166, 114);
  } else if (action === 'carry' || action === 'work') {
    left = [pt(53, 112), pt(54, 137), pt(75, 148)]; right = [pt(139, 112), pt(138, 137), pt(117, 148)]; hand = pt(96, 148);
  } else if (action === 'think') {
    right = [pt(139, 112), pt(153, 97), pt(139, 83)]; hand = right[2];
  } else if (action === 'wait') {
    left = [pt(53, 112), pt(39, 119), pt(29, 104)]; right = [pt(139, 112), pt(153, 119), pt(163, 104)]; hand = right[2];
  } else if (action === 'celebrate') {
    left = [pt(53, 107), pt(35, 90), pt(31, 68)]; right = [pt(139, 107), pt(157, 90), pt(161, 68)]; hand = right[2];
  } else if (action === 'tired') {
    left = [pt(53, 118), pt(42, 132), pt(47, 147)]; right = [pt(139, 118), pt(150, 132), pt(145, 147)]; hand = right[2];
  } else if (contact === 'sit') {
    left = [pt(53, 112), pt(48, 129), pt(57, 141)]; right = [pt(139, 112), pt(144, 129), pt(135, 141)]; hand = right[2];
  }
  if (facing === -1) {
    const mirror = (point: Point) => pt(192 - point.x, point.y);
    [left, right] = [right.map(mirror) as typeof left, left.map(mirror) as typeof right];
    hand = mirror(hand); grip = mirror(grip);
  }
  return { left, right, hand, grip, seat, feet };
}

export function mascotAnchors(kind: MascotKind, action: PetAction = 'idle', contact?: MascotContact, facing: -1 | 1 = 1) {
  const rig = mascotRig(kind, action, contact, facing);
  const unit = (point: Point) => ({ x: point.x / 192, y: point.y / 208 });
  return { hand: unit(rig.hand), seat: unit(rig.seat), grip: unit(rig.grip), feet: unit(rig.feet) };
}
