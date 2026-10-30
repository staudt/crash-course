import { saveLevel, type LevelDef, type LevelId } from '../game/levels';

const FONT = '"Arial Black", "Helvetica Neue", Impact, system-ui, sans-serif';
const SHADOW = '0 2px 4px rgba(0,0,0,0.6), 0 0 10px rgba(0,0,0,0.35)';

const CSS = `
.lm-root{position:absolute;inset:0;z-index:50;box-sizing:border-box;overflow:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:24px 16px;color:#fff;font-family:${FONT};text-shadow:${SHADOW};user-select:none;background:linear-gradient(180deg,#5fb8f0 0%,#9fd3ee 28%,#e57c3e 62%,#a9461d 100%);transition:opacity .5s;}
.lm-title{font-size:clamp(48px,12vw,104px);font-weight:900;letter-spacing:.08em;line-height:1;margin:0;}
.lm-sub{font-size:clamp(14px,3vw,22px);letter-spacing:.2em;text-transform:uppercase;margin:0;opacity:.95;}
.lm-cards{display:flex;flex-direction:row;flex-wrap:wrap;gap:16px;justify-content:center;width:100%;max-width:880px;}
.lm-card{flex:1 1 200px;min-width:0;box-sizing:border-box;padding:16px;border-radius:14px;background:rgba(0,0,0,0.35);border:3px solid rgba(255,255,255,0.25);cursor:pointer;text-align:center;transition:transform .15s,border-color .15s,box-shadow .15s,background .15s;}
.lm-card.sel{transform:scale(1.04);border-color:#ffd23f;background:rgba(0,0,0,0.5);box-shadow:0 0 24px rgba(255,210,63,0.55);}
.lm-name{font-size:clamp(20px,4vw,30px);font-weight:900;margin:8px 0 6px;}
.lm-blurb{font-size:clamp(12px,2.4vw,15px);line-height:1.35;opacity:.92;}
.lm-key{font-size:12px;opacity:.7;margin-top:8px;}
.lm-svg{width:120px;height:90px;display:block;margin:0 auto;}
.lm-loading{font-size:clamp(20px,5vw,34px);font-weight:900;letter-spacing:.1em;color:#ffd23f;text-align:center;}
.lm-hint{font-size:clamp(11px,2.6vw,14px);opacity:.85;text-align:center;}
@media (max-width:640px){.lm-cards{flex-direction:column;}.lm-svg{width:90px;height:64px;}}
`;

/** Pure: index after a ←/→ (or A/D) press, wrapping. */
export function stepChoice(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

const NS = 'http://www.w3.org/2000/svg';

function pictogram(icon: LevelDef['icon']): string {
  const stroke = 'stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"';
  if (icon === 'loop') {
    return `<svg class="lm-svg" viewBox="0 0 120 90" xmlns="${NS}"><path d="M20 62 C8 48 22 30 38 38 C52 45 56 20 76 16 C100 12 112 34 98 48 C88 58 96 74 76 76 C58 78 52 62 40 70 C32 75 26 70 20 62 Z" ${stroke}/><circle cx="20" cy="62" r="4" fill="#ffd23f"/></svg>`;
  }
  if (icon === 'eight') {
    // Lobes r 16 at (34,45) and (86,45); the straights are tangent to both and cross at (60,45).
    return `<svg class="lm-svg" viewBox="0 0 120 90" xmlns="${NS}"><path d="M43.9 32.4 L76.1 57.6 A16 16 0 1 0 76.1 32.4 L43.9 57.6 A16 16 0 1 1 43.9 32.4 Z" ${stroke}/><circle cx="68.2" cy="51.3" r="4" fill="#ffd23f"/></svg>`;
  }
  if (icon === 'city') {
    // A skyline over a long, thin street loop.
    const towers = [
      [14, 40, 12, 30],
      [28, 22, 14, 48],
      [44, 34, 10, 36],
      [56, 12, 14, 58],
      [72, 30, 12, 40],
      [86, 20, 12, 50],
      [100, 38, 8, 32],
    ]
      .map(([x, y, w, h]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(255,255,255,0.85)"/>`)
      .join('');
    return `<svg class="lm-svg" viewBox="0 0 120 90" xmlns="${NS}">${towers}<rect x="8" y="72" width="104" height="12" rx="3" ${stroke}/><circle cx="96" cy="72" r="4" fill="#ffd23f"/></svg>`;
  }
  const cx = 60;
  const cy = 45;
  const r = 34;
  let dots = '';
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    const deg = (a * 180) / Math.PI + 180; // pointing at the centre
    dots += `<rect x="-6" y="-3.5" width="12" height="7" rx="2" fill="#ffd23f" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${deg.toFixed(1)})"/>`;
  }
  return `<svg class="lm-svg" viewBox="0 0 120 90" xmlns="${NS}"><circle cx="${cx}" cy="${cy}" r="${r}" ${stroke}/>${dots}</svg>`;
}

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => requestAnimationFrame(() => (left <= 1 ? resolve() : step(left - 1)));
    step(n);
  });
}

/** Shows the menu over `container`, resolves with the chosen level once the player confirms, after showing a "loading" line and waiting two animation frames so it paints before the (synchronous, ~1 s) world build. The caller calls `hide()` on the returned handle once the game is running. */
export function chooseLevel(
  container: HTMLElement,
  levels: readonly LevelDef[],
  initial: LevelId,
): Promise<{ id: LevelId; hide: () => void }> {
  return new Promise((resolve) => {
    const style = document.createElement('style');
    style.textContent = CSS;
    const root = document.createElement('div');
    root.className = 'lm-root';
    root.appendChild(style);

    const mk = (parent: HTMLElement, cls: string, text?: string): HTMLElement => {
      const el = document.createElement('div');
      el.className = cls;
      if (text !== undefined) el.textContent = text;
      parent.appendChild(el);
      return el;
    };
    mk(root, 'lm-title', 'DESERT');
    mk(root, 'lm-sub', 'choose your arena');
    const cardsBox = mk(root, 'lm-cards');
    const hint = mk(root, 'lm-hint', '← → choose · Enter start · in game: Esc back to this menu');

    let index = Math.max(0, levels.findIndex((l) => l.id === initial));
    const cards: HTMLElement[] = levels.map((lvl, i) => {
      const card = mk(cardsBox, 'lm-card');
      const pic = document.createElement('div');
      pic.innerHTML = pictogram(lvl.icon);
      card.appendChild(pic);
      mk(card, 'lm-name', lvl.name);
      mk(card, 'lm-blurb', lvl.blurb);
      mk(card, 'lm-key', String(i + 1));
      card.addEventListener('mouseenter', () => select(i));
      card.addEventListener('click', () => confirm(i));
      return card;
    });

    function select(i: number): void {
      index = i;
      cards.forEach((c, k) => c.classList.toggle('sel', k === i));
    }

    let done = false;
    function confirm(i: number): void {
      if (done) return;
      done = true;
      select(i);
      window.removeEventListener('keydown', onKey);
      const lvl = levels[i]!;
      saveLevel(lvl.id);
      cardsBox.remove();
      hint.remove();
      mk(root, 'lm-loading', `BUILDING ${lvl.name.toUpperCase()}…`);
      void nextFrames(2).then(() => {
        resolve({
          id: lvl.id,
          hide: () => {
            root.style.pointerEvents = 'none';
            root.style.opacity = '0';
            setTimeout(() => root.remove(), 550);
          },
        });
      });
    }

    function onKey(e: KeyboardEvent): void {
      if (e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'a') select(stepChoice(index, -1, levels.length));
      else if (k === 'arrowright' || k === 'd') select(stepChoice(index, 1, levels.length));
      else if (k === 'enter' || k === ' ') confirm(index);
      else if (/^[1-9]$/.test(k) && Number(k) <= levels.length) confirm(Number(k) - 1);
      else return;
      e.preventDefault();
    }

    select(index);
    window.addEventListener('keydown', onKey);
    container.appendChild(root);
  });
}
