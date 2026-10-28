export interface PetSnapshot { petCount: number; animatedPetCount: number; taskPetCount: number; movingCardCount: number }
let current: PetSnapshot = { petCount: 0, animatedPetCount: 0, taskPetCount: 0, movingCardCount: 0 };
export function setPetSnapshot(value: PetSnapshot) { current = value; }
export function petSnapshot() { return current; }
