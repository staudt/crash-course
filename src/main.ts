import { initPhysics } from './core/Physics';
import { Tuning } from './debug/Tuning';
import { Game } from './game/Game';

await initPhysics();
const game = new Game(document.getElementById('app')!);
new Tuning(game);
if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
