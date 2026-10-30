import { initPhysics } from './core/Physics';
import { Tuning } from './debug/Tuning';
import { Game } from './game/Game';
import { levelById, LEVELS, loadLevel } from './game/levels';
import { chooseLevel } from './ui/LevelMenu';

const app = document.getElementById('app')!;
const [, menu] = await Promise.all([initPhysics(), chooseLevel(app, LEVELS, loadLevel())]);
const level = levelById(menu.id)!;
const game = new Game(app, level, await level.city?.());
menu.hide();
new Tuning(game);
if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
