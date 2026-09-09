// The toolbar. It floats rather than filling an edge, it can be dragged to any
// of the four sides, and when it stops fitting it sheds whole sections into an
// overflow menu instead of squeezing what is left — so every tool is always
// reachable, just sometimes one click further away.

export type DockSide = 'top' | 'right' | 'bottom' | 'left';

export const DOCK_SIDES: DockSide[] = ['top', 'right', 'bottom', 'left'];

export function isDockSide(v: unknown): v is DockSide {
  return typeof v === 'string' && (DOCK_SIDES as string[]).includes(v);
}

export interface DockParts {
  dock: HTMLElement;
  main: HTMLElement;
  more: HTMLElement;
  grip: HTMLElement;
  overflow: HTMLElement;
}

export interface DockOpts extends DockParts {
  // Sections named here are given up first when space runs out; anything not
  // listed is never collapsed. The order is the order they go.
  shedOrder: string[];
  onSide: (side: DockSide) => void;
  onLayout: () => void;
  closeOverflow: () => void;
  // Anything parked against the dock that should travel with it when it moves.
  travelling?: () => HTMLElement[];
}

export interface Dock {
  side: DockSide;
  setSide(side: DockSide): void;
  relayout(): void;
  /** How much room the dock takes on each edge, for panels keeping clear. */
  pads(): { top: number; right: number; bottom: number; left: number };
}

export function createDock(opts: DockOpts): Dock {
  const { dock, main, more, grip, overflow } = opts;
  const sections = [...main.querySelectorAll<HTMLElement>('.dock-sec')];
  const order = new Map(sections.map((el, i) => [el, i]));
  let side: DockSide = (dock.dataset.side as DockSide) ?? 'top';

  const vertical = () => side === 'left' || side === 'right';

  // Puts everything back in the bar, then hands sections to the overflow menu
  // one at a time — cheapest thing that lands on the right answer, and it runs
  // only on resize, a dock move, or a panel opening.
  function relayout(): void {
    // Whatever the overflow menu was showing is about to be moved out from
    // under it, so it cannot survive its own contents being rearranged.
    opts.closeOverflow();
    for (const el of [...sections].sort((a, b) => order.get(a)! - order.get(b)!)) {
      main.appendChild(el);
    }
    overflow.textContent = '';
    more.classList.add('hidden');

    const shed = opts.shedOrder
      .map((name) => sections.find((el) => el.dataset.sec === name))
      .filter((el): el is HTMLElement => !!el);

    for (const el of shed) {
      if (!overflows()) break;
      overflow.appendChild(el);
      more.classList.remove('hidden');
    }
    // Everything shed and still too tall: the bar scrolls rather than being
    // clipped, which is not pretty but is never a dead end.
    main.style.overflowY = vertical() && overflows() ? 'auto' : '';
    opts.onLayout();
  }

  function overflows(): boolean {
    return vertical() ? main.scrollHeight > main.clientHeight + 1 : main.scrollWidth > main.clientWidth + 1;
  }

  function setSide(next: DockSide): void {
    if (side === next) return;
    // Where everything was, before anything is allowed to move.
    const moving = [dock, ...(opts.travelling?.() ?? [])];
    const from = moving.map((el) => el.getBoundingClientRect());

    side = next;
    dock.dataset.side = next;
    // Told before anything is laid out: relayout's onLayout hook places panels
    // against the dock, and it has to be placing them against the new edge.
    opts.onSide(next);
    relayout();

    // Everything is already in its final place; the offsets below put it back
    // where it was for one frame and then let it travel. Doing it this way
    // round rather than animating the layout means nothing downstream — pads,
    // the settings strip, the popovers — ever measures a half-finished move.
    slide(moving, from);
  }

  function slide(els: HTMLElement[], from: DOMRect[]): void {
    const offsets = els.map((el, i) => {
      const to = el.getBoundingClientRect();
      return { dx: from[i].left - to.left, dy: from[i].top - to.top };
    });
    for (const [i, el] of els.entries()) {
      el.classList.remove('moving');
      el.style.transform = `translate(${offsets[i].dx}px, ${offsets[i].dy}px)`;
    }
    void dock.offsetWidth; // one reflow, so the offset above is a real start state
    for (const el of els) {
      el.classList.add('moving');
      el.style.transform = '';
      el.addEventListener('transitionend', () => el.classList.remove('moving'), { once: true });
    }
  }

  // Measured from the edge the dock is on to its far side, so a panel reading
  // these clears the real thing rather than an assumed offset. Only ever asked
  // for while the dock is sitting still: mid-slide the rectangle is a lie.
  function pads(): { top: number; right: number; bottom: number; left: number } {
    const r = dock.getBoundingClientRect();
    const out = { top: 0, right: 0, bottom: 0, left: 0 };
    if (side === 'top') out.top = r.bottom + 10;
    else if (side === 'bottom') out.bottom = window.innerHeight - r.top + 10;
    else if (side === 'left') out.left = r.right + 10;
    else out.right = window.innerWidth - r.left + 10;
    return out;
  }

  // Dragging snaps live: the bar jumps to whichever edge the pointer is nearest
  // as it crosses, so you can see the result before letting go instead of
  // guessing from a drop shadow.
  let dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dock.classList.add('dragging');
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setSide(nearestSide(e.clientX, e.clientY));
  });
  const stop = (): void => {
    if (!dragging) return;
    dragging = false;
    dock.classList.remove('dragging');
  };
  grip.addEventListener('pointerup', stop);
  grip.addEventListener('pointercancel', stop);

  window.addEventListener('resize', relayout);

  return {
    get side() {
      return side;
    },
    setSide,
    relayout,
    pads,
  };
}

// Which edge a point belongs to, measured as a fraction of the window so a wide
// window does not make the side edges unreachable.
export function nearestSide(x: number, y: number, width = window.innerWidth, height = window.innerHeight): DockSide {
  const d: [DockSide, number][] = [
    ['left', x / width],
    ['right', (width - x) / width],
    ['top', y / height],
    ['bottom', (height - y) / height],
  ];
  d.sort((a, b) => a[1] - b[1]);
  return d[0][0];
}
