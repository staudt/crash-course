import type { TrackDef } from '../race/TrackPath';
import { CROSSOVER, DUNE_LOOP } from '../race/tracks';

/** The levels picked from the start menu. Each builds its own world and director in Game. */
export type LevelId = 'dune-loop' | 'crossover' | 'bowl';

export interface LevelDef {
  id: LevelId;
  name: string;
  /** race = laps against rivals (RaceDirector); derby = last car running (DerbyDirector). */
  kind: 'race' | 'derby';
  /** One line for the menu card. */
  blurb: string;
  /** Menu card pictogram. */
  icon: 'loop' | 'eight' | 'bowl';
  /** The circuit (races). */
  track?: TrackDef;
}

export const LEVELS: readonly LevelDef[] = [
  { id: 'dune-loop', name: 'Dune Loop', kind: 'race', blurb: '7 km circuit · 2 laps against 5 rivals', icon: 'loop', track: DUNE_LOOP },
  { id: 'crossover', name: 'Crossover', kind: 'race', blurb: 'Walled asphalt figure 8 · the straights cross · 5 laps against 5 rivals', icon: 'eight', track: CROSSOVER },
  { id: 'bowl', name: 'Destruction Bowl', kind: 'derby', blurb: 'Mud arena · 10 cars · last car running wins', icon: 'bowl' },
];

const LEVEL_KEY = 'desert.level';

export function levelById(id: string | null | undefined): LevelDef | undefined {
  return LEVELS.find((l) => l.id === id);
}

/** The level picked last time (the menu's default), or the first one. */
export function loadLevel(): LevelId {
  try {
    return levelById(localStorage.getItem(LEVEL_KEY))?.id ?? LEVELS[0]!.id;
  } catch {
    return LEVELS[0]!.id;
  }
}

export function saveLevel(id: LevelId): void {
  try {
    localStorage.setItem(LEVEL_KEY, id);
  } catch {
    // Storage unavailable: the menu just starts on the first level next time.
  }
}
