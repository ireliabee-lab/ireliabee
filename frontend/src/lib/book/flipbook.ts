import type { PageSpec } from './book';
import {
  clamp,
  clipPolygon,
  computeFold,
  constrainPointer,
  distance,
  easeInOutSine,
  easeOutCubic,
  flipProgress,
  lerp,
  lerpVec,
  maxFoldDistance,
  mirrorXMatrix,
  multiply,
  rectPolygon,
  reflectionMatrix,
  reflectPoint,
  vec,
  type Fold,
  type Vec,
} from './geometry';
import { COLORS, darkPaper, PAGE_H, PAGE_W, paintPage, type PageRect } from './pages';

export type Direction = 1 | -1;

export interface FlipBookOptions {
  readonly canvas: HTMLCanvasElement;
  readonly pages: readonly PageSpec[];
  /** Milliseconds for a full automatic page turn. */
  readonly duration?: number;
  /** Skip animation: turns land instantly and drags track the pointer 1:1. */
  readonly reducedMotion?: boolean;
  readonly onChange?: (spread: number) => void;
  /** Fired when a turn is committed (a good moment for a sound). */
  readonly onTurn?: (direction: Direction) => void;
  readonly paint?: (ctx: CanvasRenderingContext2D, spec: PageSpec, index: number) => void;
  /** Called for taps when `tapToTurn` is off (e.g. to place a text cursor). */
  readonly onTap?: (hit: PageHit) => void;
  /**
   * Presses away from the page edges when `tapToTurn` is off: down, move, up.
   * Used for placing a cursor and selecting text on the page itself.
   */
  readonly onPress?: (phase: 'down' | 'move' | 'up', hit: PageHit | null) => void;
  /** On narrow portrait screens, show one page at a time (zoomed) instead of the spread. */
  readonly singlePageWhenNarrow?: boolean;
}

/** A text cursor and selection drawn on the pages (logical page units). */
export interface TextOverlay {
  readonly caret?: { readonly page: number; readonly x: number; readonly y: number; readonly h: number } | null;
  readonly selection?: readonly PageMarker[];
}

export type Side = 'left' | 'right';

/** A point on a page, in logical page units. */
export interface PageHit {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

export interface PageMarker extends PageRect {
  readonly page: number;
}

type Phase = 'peek' | 'drag' | 'settle';

interface Animation {
  readonly from: Vec;
  readonly to: Vec;
  readonly start: number;
  readonly duration: number;
  /** Height of the lift arc for automatic turns (0 for a straight glide). */
  readonly arc: number;
  readonly easing: (t: number) => number;
}

interface Turn {
  readonly dir: Direction;
  readonly hard: boolean;
  readonly corner: Vec;
  readonly target: Vec;
  pointer: Vec;
  desired: Vec;
  phase: Phase;
  /** Where the drag began, for edge grabs that move relative to it. */
  grab?: Vec;
  /** Corner grabs track the pointer directly; edge grabs track its offset. */
  followsPointer?: boolean;
  releasing?: boolean;
  commit?: boolean;
  anim?: Animation;
}

interface QueuedTurn {
  readonly dir: Direction;
  readonly durationScale: number;
}

const FOLLOW = 0.32;
const CLICK_SLOP = 6;
const CLICK_MS = 350;
const FLICK_SPEED = 0.55; // px per ms
const MAX_QUEUE = 24;

export class FlipBook {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private pages: readonly PageSpec[];
  private readonly duration: number;
  private readonly reducedMotion: boolean;
  private readonly onChange?: (spread: number) => void;
  private readonly onTurn?: (direction: Direction) => void;
  private readonly paint: (ctx: CanvasRenderingContext2D, spec: PageSpec, index: number) => void;
  private readonly onTap?: (hit: PageHit) => void;
  private readonly onPress?: (phase: 'down' | 'move' | 'up', hit: PageHit | null) => void;
  private readonly singlePageWhenNarrow: boolean;

  /** When false, a tap reports its position through onTap instead of turning. */
  tapToTurn = true;
  /** When false the book ignores the reader entirely (e.g. while locked). */
  interactive = true;
  /** Fraction of a page's width, from its outer edge, where presses turn pages when `tapToTurn` is off. */
  grabZone = 1;

  private spreadIndex = 0;
  private turn: Turn | null = null;
  private queue: QueuedTurn[] = [];
  private textures = new Map<number, HTMLCanvasElement>();
  /** Textures whose page content changed; repainted in place on next use. */
  private dirty = new Set<number>();
  private pending: { pages: readonly PageSpec[]; changed: Set<number> } | null = null;
  private marker: PageMarker | null = null;
  private overlay: TextOverlay | null = null;
  private caretOn = true;
  private blinkTimer: ReturnType<typeof setTimeout> | null = null;
  private pressing = false;
  private single = false;
  private fill = false;
  private side: Side = 'right';
  private pendingSide: Side | null = null;
  /** Camera pan (CSS px), eased towards its target. */
  private pan = { x: 0, y: 0 };
  private panTarget = { x: 0, y: 0 };
  private focusY: number | null = null;
  private warmHandle: number | null = null;
  private frame = 0;
  private destroyed = false;

  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private W = 0;
  private H = 0;
  private padY = 0;

  private down: { t: number; x: number; y: number } | null = null;
  private trail: { t: number; p: Vec }[] = [];

  constructor(options: FlipBookOptions) {
    assertEvenPages(options.pages);
    this.canvas = options.canvas;
    this.ctx = options.canvas.getContext('2d');
    this.pages = options.pages;
    this.duration = options.duration ?? 950;
    this.reducedMotion = options.reducedMotion ?? false;
    this.onChange = options.onChange;
    this.onTurn = options.onTurn;
    this.paint = options.paint ?? paintPage;
    this.onTap = options.onTap;
    this.onPress = options.onPress;
    this.singlePageWhenNarrow = options.singlePageWhenNarrow ?? false;

    this.canvas.addEventListener('pointerdown', this.handleDown);
    this.canvas.addEventListener('pointermove', this.handleMove);
    this.canvas.addEventListener('pointerup', this.handleUp);
    this.canvas.addEventListener('pointercancel', this.handleCancel);
    this.canvas.addEventListener('pointerleave', this.handleLeave);
    this.canvas.style.touchAction = 'none';
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get spread(): number {
    return this.spreadIndex;
  }

  get lastSpread(): number {
    return this.pages.length / 2;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** True when showing one zoomed page instead of the spread. */
  get isSinglePage(): boolean {
    return this.single;
  }

  /** Which page of the spread is in view in single-page mode. */
  get visibleSide(): Side {
    return this.side;
  }

  get isTurning(): boolean {
    return this.turn !== null && this.turn.phase !== 'peek';
  }

  /** Physical page indices showing on the current spread (null when empty). */
  visiblePages(spread = this.spreadIndex): { left: number | null; right: number | null } {
    const left = 2 * spread - 1;
    const right = 2 * spread;
    return { left: this.hasPage(left) ? left : null, right: this.hasPage(right) ? right : null };
  }

  canTurn(dir: Direction, spread = this.spreadIndex): boolean {
    return dir === 1 ? spread < this.lastSpread : spread > 0;
  }

  next(): boolean {
    if (this.single && this.interactive && !this.turn && this.side === 'left' && this.visiblePages().right !== null) {
      this.showSide('right');
      return true;
    }
    return this.request(1, 1);
  }

  prev(): boolean {
    if (this.single && this.interactive && !this.turn && this.side === 'right' && this.visiblePages().left !== null) {
      this.showSide('left');
      return true;
    }
    return this.request(-1, 1);
  }

  /** In single-page mode, pans to one page of the spread. */
  showSide(side: Side): void {
    if (this.side === side) return;
    this.side = side;
    this.updatePanTarget();
    this.requestFrame();
  }

  /** Brings a page into view: turning to its spread (animated if adjacent) and panning to it. */
  reveal(pageIndex: number, animate = true): void {
    if (!this.hasPage(pageIndex)) return;
    const spread = pageIndex % 2 === 0 ? pageIndex / 2 : (pageIndex + 1) / 2;
    const side: Side = pageIndex % 2 === 0 ? 'right' : 'left';
    if (spread !== this.spreadIndex) {
      if (this.turn) return;
      this.pendingSide = side;
      if (animate && !this.reducedMotion && Math.abs(spread - this.spreadIndex) === 1) this.goTo(spread);
      else this.jumpTo(spread);
      return;
    }
    this.showSide(side);
  }

  /** Zooms a single page to the full width (for writing on small screens). */
  setFillWidth(on: boolean): void {
    if (this.fill === on) return;
    this.fill = on;
    if (this.cssW > 1) this.resize(this.cssW, this.cssH, this.dpr);
  }

  /** Keeps a vertical position (book px) comfortably in view when the page is taller than the screen. */
  setFocusY(y: number | null): void {
    this.focusY = y;
    this.updatePanTarget();
    this.requestFrame();
  }

  /** Draws a text cursor or selection on the pages; null removes it. */
  /**
   * Where a rectangle on a page (page units) is drawn, in CSS pixels from the canvas's top left;
   * null when that page is not showing. For placing things beside the text, like the Explain card.
   */
  cssRect(page: number, r: { x: number; y: number; w: number; h: number }): { x: number; y: number; w: number; h: number } | null {
    const { left, right } = this.visiblePages();
    if (page !== left && page !== right) return null;
    const k = this.W / PAGE_W;
    return { x: this.originX() + this.rectFor(page).x + r.x * k, y: this.originY() + r.y * k, w: r.w * k, h: r.h * k };
  }

  setOverlay(overlay: TextOverlay | null): void {
    this.overlay = overlay;
    this.caretOn = true;
    this.restartBlink();
    if (!this.turn) this.render();
  }

  private restartBlink(): void {
    if (this.blinkTimer) clearTimeout(this.blinkTimer);
    this.blinkTimer = null;
    if (!this.overlay?.caret || this.destroyed) return;
    this.blinkTimer = setTimeout(() => {
      this.caretOn = !this.caretOn;
      if (!this.turn) this.render();
      this.restartBlink();
    }, 530);
  }

  /** Turns page by page to the requested spread. */
  goTo(spread: number): void {
    const target = clamp(Math.round(spread), 0, this.lastSpread);
    const planned = this.plannedSpread();
    const dir: Direction = target > planned ? 1 : -1;
    for (let i = 0; i < Math.abs(target - planned); i++) this.request(dir, 0.42);
  }

  /** Moves straight to a spread without animating, cancelling any turn in flight. */
  jumpTo(spread: number): void {
    const target = clamp(Math.round(spread), 0, this.lastSpread);
    this.turn = null;
    this.queue = [];
    this.applyPending();
    const changed = target !== this.spreadIndex;
    this.spreadIndex = target;
    this.settleSide(this.pendingSide ?? 'right');
    this.snapPan();
    if (changed) this.onChange?.(target);
    this.render();
  }

  /** Picks a side that exists on the current spread, preferring `wanted`. */
  private settleSide(wanted: Side): void {
    this.pendingSide = null;
    const { left, right } = this.visiblePages();
    this.side = wanted === 'left' ? (left !== null ? 'left' : 'right') : right !== null ? 'right' : 'left';
    this.updatePanTarget();
  }

  /**
   * Swaps in new page content. Only the listed indices are repainted (in place,
   * reusing their bitmaps); everything else keeps its texture. Updates arriving
   * mid-turn are held until the leaf lands so the turn never changes under you.
   */
  setPages(pages: readonly PageSpec[], changed?: Iterable<number>): void {
    assertEvenPages(pages);
    const indices = new Set(changed ?? pages.map((_, i) => i));
    if (this.turn && this.turn.phase !== 'peek') {
      const merged = this.pending?.changed ?? new Set<number>();
      indices.forEach((i) => merged.add(i));
      this.pending = { pages, changed: merged };
      return;
    }
    this.applyPages(pages, indices);
  }

  /** Drops every rendered page bitmap (e.g. so locked content doesn't linger in memory). */
  purge(): void {
    this.cancelWarm();
    for (const c of this.textures.values()) {
      c.width = 0;
      c.height = 0;
    }
    this.textures.clear();
    this.dirty.clear();
    this.marker = null;
    this.render();
  }

  /** Highlights a line (logical page units) while the book is at rest; null clears it. */
  setMarker(marker: PageMarker | null): void {
    const same =
      marker && this.marker
        ? marker.page === this.marker.page && marker.y === this.marker.y && marker.x === this.marker.x
        : marker === this.marker;
    this.marker = marker;
    if (!same && !this.turn) this.render();
  }

  /** The page and logical position under a client point, if any. */
  hitTest(clientX: number, clientY: number): PageHit | null {
    const p = this.toBook({ clientX, clientY });
    if (p.y < 0 || p.y > this.H || p.x < 0 || p.x > 2 * this.W) return null;
    const index = p.x >= this.W ? 2 * this.spreadIndex : 2 * this.spreadIndex - 1;
    if (!this.hasPage(index)) return null;
    const left = this.rectFor(index).x;
    return { index, x: ((p.x - left) * PAGE_W) / this.W, y: (p.y * PAGE_H) / this.H };
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio = globalThis.devicePixelRatio || 1): void {
    this.cssW = Math.max(1, cssWidth);
    this.cssH = Math.max(1, cssHeight);
    // Paint at the canvas's size on screen, not its layout size: with the app zoomed (Settings, CSS zoom on the
    // root) the canvas shows smaller or larger than it is laid out, and a bitmap made for the layout size was
    // resampled to fit, softening every letter.
    const shown = this.canvas.offsetWidth > 0 ? this.canvas.getBoundingClientRect().width / this.canvas.offsetWidth : 1;
    this.dpr = Math.min(3, Math.max(0.5, devicePixelRatio * (shown > 0 ? shown : 1)));
    const ratio = PAGE_W / PAGE_H;
    this.single = this.singlePageWhenNarrow && this.cssW < this.cssH * 0.95;
    if (this.single) {
      const byWidth = this.cssW * 0.94;
      this.W = Math.max(40, this.fill ? byWidth : Math.min(byWidth, (this.cssH / 1.08) * ratio));
    } else {
      this.W = Math.max(40, Math.min((this.cssW * 0.96) / 2, (this.cssH / 1.18) * ratio));
    }
    // Whole device pixels: a page 700.32 wide put the right page, and every letter on it, between pixels.
    this.W = Math.round(this.W * this.dpr) / this.dpr;
    this.H = Math.round((this.W / ratio) * this.dpr) / this.dpr;
    this.padY = (this.cssH - this.H) / 2;
    this.canvas.width = Math.round(this.cssW * this.dpr);
    this.canvas.height = Math.round(this.cssH * this.dpr);
    this.textures.clear();
    this.settleSide(this.side);
    this.snapPan();
    this.render();
  }

  /** Pixel size of one page, useful for layout around the book. */
  get pageSize(): { width: number; height: number } {
    return { width: this.W, height: this.H };
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    this.cancelWarm();
    if (this.blinkTimer) clearTimeout(this.blinkTimer);
    this.canvas.removeEventListener('pointerdown', this.handleDown);
    this.canvas.removeEventListener('pointermove', this.handleMove);
    this.canvas.removeEventListener('pointerup', this.handleUp);
    this.canvas.removeEventListener('pointercancel', this.handleCancel);
    this.canvas.removeEventListener('pointerleave', this.handleLeave);
    this.textures.clear();
  }

  // ── Turn orchestration ────────────────────────────────────────────────────

  private plannedSpread(): number {
    let s = this.spreadIndex;
    if (this.turn?.phase === 'settle' && this.turn.commit) s += this.turn.dir;
    for (const q of this.queue) s += q.dir;
    return s;
  }

  private request(dir: Direction, durationScale: number): boolean {
    if (!this.interactive) return false;
    if (!this.canTurn(dir, this.plannedSpread())) return false;
    if (this.turn && this.turn.phase !== 'peek') {
      if (this.queue.length < MAX_QUEUE) this.queue.push({ dir, durationScale });
      return true;
    }
    this.startAutoTurn(dir, durationScale);
    return true;
  }

  private isHardLeaf(dir: Direction): boolean {
    const flipping = dir === 1 ? 2 * this.spreadIndex : 2 * this.spreadIndex - 1;
    const leaf = Math.floor(flipping / 2);
    return leaf === 0 || leaf === this.pages.length / 2 - 1;
  }

  private createTurn(dir: Direction, cornerY: number, phase: Phase): Turn {
    const outer = dir === 1 ? 2 * this.W : 0;
    const corner = vec(outer, cornerY);
    const target = vec(2 * this.W - outer, cornerY);
    return { dir, hard: this.isHardLeaf(dir), corner, target, pointer: corner, desired: corner, phase };
  }

  private startAutoTurn(dir: Direction, durationScale: number): void {
    const existing = this.turn;
    const turn =
      existing && existing.phase === 'peek' && existing.dir === dir ? existing : this.createTurn(dir, this.H, 'settle');
    turn.phase = 'settle';
    turn.commit = true;
    turn.releasing = false;
    turn.anim = {
      from: turn.pointer,
      to: turn.target,
      start: now(),
      duration: this.duration * durationScale,
      arc: turn.hard ? 0 : this.H * 0.14 * (turn.corner.y > this.H / 2 ? 1 : -1),
      easing: easeInOutSine,
    };
    this.turn = turn;
    this.onTurn?.(dir);
    this.advance(now());
  }

  private settle(turn: Turn, commit: boolean, durationScale: number): void {
    turn.phase = 'settle';
    turn.commit = commit;
    const to = commit ? turn.target : turn.corner;
    const span = Math.max(1, distance(turn.corner, turn.target));
    const remaining = distance(turn.pointer, to) / span;
    turn.anim = {
      from: turn.pointer,
      to,
      start: now(),
      duration: this.duration * durationScale * clamp(remaining, 0.3, 1),
      arc: 0,
      easing: easeOutCubic,
    };
    if (commit) this.onTurn?.(turn.dir);
    this.advance(now());
  }

  private finishTurn(turn: Turn): void {
    // Clear the turn first so onChange handlers can start new turns cleanly.
    this.turn = null;
    if (turn.commit) {
      this.spreadIndex += turn.dir;
      // Forward: continue on the page you just turned over. Back: the page before.
      this.settleSide(this.pendingSide ?? (turn.dir === 1 ? 'left' : 'right'));
    }
    this.applyPending();
    if (turn.commit) this.onChange?.(this.spreadIndex);
    if (this.turn) return; // a handler already started the next turn
    const queued = this.queue.shift();
    if (queued && this.canTurn(queued.dir)) this.startAutoTurn(queued.dir, queued.durationScale);
  }

  /** Steps the active turn to time `t`; returns true while more frames are needed. */
  private step(t: number): boolean {
    const turn = this.turn;
    if (!turn) return false;
    const constrain = (p: Vec): Vec =>
      constrainPointer(p, turn.corner, vec(this.W, 0), vec(this.W, this.H));

    if (turn.phase === 'settle' && turn.anim) {
      const a = turn.anim;
      const k = a.duration <= 0 || this.reducedMotion ? 1 : clamp((t - a.start) / a.duration, 0, 1);
      const e = a.easing(k);
      const p = lerpVec(a.from, a.to, e);
      turn.pointer = constrain(vec(p.x, p.y - Math.sin(Math.PI * e) * a.arc));
      if (k >= 1) {
        this.finishTurn(turn);
        return this.turn !== null;
      }
      return true;
    }

    const follow = this.reducedMotion ? 1 : FOLLOW;
    turn.pointer = constrain(lerpVec(turn.pointer, turn.desired, follow));
    if (turn.phase === 'peek' && turn.releasing && distance(turn.pointer, turn.corner) < 0.5) {
      this.turn = null;
      return false;
    }
    return distance(turn.pointer, turn.desired) > 0.1 || turn.phase === 'drag';
  }

  private advance(t: number): void {
    const more = this.step(t);
    const panning = this.stepPan();
    this.render();
    if (more || panning) this.requestFrame();
  }

  private requestFrame(): void {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame((t) => {
      this.frame = 0;
      this.advance(t);
    });
  }

  private applyPending(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    this.applyPages(pending.pages, pending.changed);
  }

  private applyPages(pages: readonly PageSpec[], changed: Set<number>): void {
    this.pages = pages;
    changed.forEach((i) => {
      if (this.textures.has(i)) this.dirty.add(i);
    });
    for (const i of [...this.textures.keys()]) {
      if (i >= pages.length) {
        this.textures.delete(i);
        this.dirty.delete(i);
      }
    }
    if (this.spreadIndex > this.lastSpread) {
      this.spreadIndex = this.lastSpread;
      this.onChange?.(this.spreadIndex);
    }
    if (this.marker && this.marker.page >= pages.length) this.marker = null;
    this.render();
  }

  /** Paints neighbouring spreads during idle time so the next turn starts instantly. */
  private scheduleWarm(): void {
    if (this.warmHandle !== null || this.destroyed || this.W === 0) return;
    const run = (): void => {
      this.warmHandle = null;
      if (this.destroyed || this.turn) return;
      const s = this.spreadIndex;
      for (let i = 2 * s - 3; i <= 2 * s + 2; i++) {
        if (this.hasPage(i) && (!this.textures.has(i) || this.dirty.has(i))) {
          this.texture(i);
          this.scheduleWarm();
          return;
        }
      }
    };
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    this.warmHandle = idle ? idle(run, { timeout: 500 }) : (setTimeout(run, 40) as unknown as number);
  }

  private cancelWarm(): void {
    if (this.warmHandle === null) return;
    const cancelIdle = (globalThis as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
    if (cancelIdle) cancelIdle(this.warmHandle);
    clearTimeout(this.warmHandle);
    this.warmHandle = null;
  }

  // ── Pointer handling ──────────────────────────────────────────────────────

  private offsetFor(spread: number): number {
    if (this.single) return 0;
    if (spread <= 0) return -this.W / 2;
    if (spread >= this.lastSpread) return this.W / 2;
    return 0;
  }

  private progress(): number {
    const t = this.turn;
    return t ? flipProgress(t.corner, t.pointer, t.target) : 0;
  }

  private bookOffset(): number {
    const base = this.offsetFor(this.spreadIndex);
    const t = this.turn;
    if (!t) return base;
    return lerp(base, this.offsetFor(this.spreadIndex + t.dir), easeInOutSine(this.progress()));
  }

  /** Snapped to a device pixel, so resting pages are drawn pixel for pixel, sharp. */
  private snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
  }

  private originX(): number {
    return this.snap((this.cssW - 2 * this.W) / 2 + this.bookOffset() + this.pan.x);
  }

  private originY(): number {
    return this.snap(this.padY + this.pan.y);
  }

  private updatePanTarget(): void {
    const x = this.single ? (this.side === 'right' ? -this.W / 2 : this.W / 2) : 0;
    let y = 0;
    if (this.H > this.cssH && this.focusY !== null) {
      const margin = 16;
      const maxY = margin - this.padY; // page top at the top margin
      const minY = this.cssH - margin - (this.padY + this.H); // page bottom at the bottom margin
      const screenY = this.padY + this.panTarget.y + this.focusY;
      y = this.panTarget.y;
      // Only scroll when the focus leaves the middle band, like a text editor.
      if (screenY < this.cssH * 0.22 || screenY > this.cssH * 0.62) y = this.cssH * 0.4 - this.padY - this.focusY;
      y = clamp(y, minY, maxY);
    }
    this.panTarget = { x, y };
  }

  private snapPan(): void {
    this.pan = { ...this.panTarget };
  }

  /** Eases the camera towards its target; true while still moving. */
  private stepPan(): boolean {
    const dx = this.panTarget.x - this.pan.x;
    const dy = this.panTarget.y - this.pan.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      this.pan = { ...this.panTarget };
      return false;
    }
    const k = this.reducedMotion ? 1 : 0.22;
    this.pan = { x: this.pan.x + dx * k, y: this.pan.y + dy * k };
    return true;
  }

  private toBook(e: { clientX: number; clientY: number }): Vec {
    const rect = this.canvas.getBoundingClientRect();
    // The app can be zoomed (Settings, CSS zoom on the root): the pointer and the canvas's rect are in screen
    // pixels, the book lays out in the canvas's own CSS pixels. Unscaled, a click at 92% landed about a line
    // above where it was made, and further off the lower and further right it was.
    const scale = this.canvas.offsetWidth > 0 && rect.width > 0 ? rect.width / this.canvas.offsetWidth : 1;
    return vec((e.clientX - rect.left) / scale - this.originX(), (e.clientY - rect.top) / scale - this.originY());
  }

  private pageUnder(p: Vec): Direction | null {
    if (p.y < 0 || p.y > this.H) return null;
    if (p.x >= this.W && p.x <= 2 * this.W && this.canTurn(1)) return 1;
    if (p.x >= 0 && p.x < this.W && this.canTurn(-1)) return -1;
    return null;
  }

  private readonly handleDown = (e: PointerEvent): void => {
    if (!this.interactive) return;
    if (e.button !== undefined && e.button > 0) return;
    // Presses for writing still count while a page is settling (e.g. tapping as the cover opens).
    if (!this.tapToTurn && this.onPress) {
      const hit = this.hitTest(e.clientX, e.clientY);
      if (hit) {
        const fromOuter = hit.index % 2 === 0 ? PAGE_W - hit.x : hit.x;
        if (fromOuter > this.grabZone * PAGE_W) {
          e.preventDefault(); // keep keyboard focus where the writing is
          if (this.turn?.phase === 'peek') {
            this.turn = null;
            this.render();
          }
          this.pressing = true;
          try {
            this.canvas.setPointerCapture?.(e.pointerId);
          } catch {
            /* capture is best-effort */
          }
          this.onPress('down', hit);
          return;
        }
      }
    }
    if (this.turn && this.turn.phase === 'settle') return;
    const p = this.toBook(e);
    const dir = this.pageUnder(p);
    if (!dir) return;

    const edge = this.H * 0.22;
    const cornerY = p.y < edge ? 0 : p.y > this.H - edge ? this.H : p.y;
    const peek = this.turn;
    const turn =
      peek && peek.phase === 'peek' && peek.dir === dir && peek.corner.y === cornerY
        ? peek
        : this.createTurn(dir, cornerY, 'drag');
    turn.phase = 'drag';
    turn.releasing = false;
    turn.grab = p;
    turn.followsPointer = cornerY === 0 || cornerY === this.H;
    turn.desired = turn.followsPointer ? p : turn.corner;
    this.turn = turn;

    this.down = { t: now(), x: e.clientX, y: e.clientY };
    this.trail = [{ t: now(), p }];
    try {
      this.canvas.setPointerCapture?.(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    this.requestFrame();
  };

  private readonly handleMove = (e: PointerEvent): void => {
    if (!this.interactive) return;
    if (this.pressing) {
      this.onPress?.('move', this.hitTest(e.clientX, e.clientY));
      return;
    }
    const p = this.toBook(e);
    const turn = this.turn;

    if (turn && turn.phase === 'drag') {
      const grab = turn.grab ?? turn.corner;
      turn.desired = turn.followsPointer ? p : vec(turn.corner.x + p.x - grab.x, turn.corner.y + p.y - grab.y);
      const t = now();
      this.trail.push({ t, p });
      this.trail = this.trail.filter((s) => t - s.t < 120);
      this.requestFrame();
      return;
    }
    if (turn && turn.phase === 'settle') return;
    this.updatePeek(p);
  };

  private updatePeek(p: Vec): void {
    const radius = Math.min(90, this.W * 0.24);
    const candidates: { dir: Direction; corner: Vec }[] = [];
    if (this.canTurn(1)) candidates.push({ dir: 1, corner: vec(2 * this.W, 0) }, { dir: 1, corner: vec(2 * this.W, this.H) });
    if (this.canTurn(-1)) candidates.push({ dir: -1, corner: vec(0, 0) }, { dir: -1, corner: vec(0, this.H) });
    const hit = candidates.find((c) => distance(c.corner, p) < radius);
    const turn = this.turn;

    if (!hit) {
      if (turn?.phase === 'peek') {
        turn.releasing = true;
        turn.desired = turn.corner;
        this.requestFrame();
      }
      return;
    }
    const same = turn?.phase === 'peek' && turn.dir === hit.dir && turn.corner.y === hit.corner.y;
    const peek = same && turn ? turn : this.createTurn(hit.dir, hit.corner.y, 'peek');
    const inwardX = hit.dir === 1 ? -1 : 1;
    const inwardY = hit.corner.y === 0 ? 1 : -1;
    const lift = this.W * (peek.hard ? 0.1 : 0.13);
    peek.releasing = false;
    peek.desired = vec(peek.corner.x + inwardX * lift, peek.corner.y + inwardY * lift * 0.8);
    this.turn = peek;
    this.requestFrame();
  }

  private readonly handleUp = (e: PointerEvent): void => {
    if (this.pressing) {
      this.pressing = false;
      this.onPress?.('up', this.hitTest(e.clientX, e.clientY));
      return;
    }
    const turn = this.turn;
    if (!turn || turn.phase !== 'drag') return;
    const t = now();
    const moved = this.down ? Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) : Infinity;
    const quick = this.down ? t - this.down.t < CLICK_MS : false;
    this.down = null;

    if (moved < CLICK_SLOP && quick) {
      if (this.tapToTurn) {
        this.settle(turn, true, 0.85);
      } else {
        this.turn = null;
        this.render();
        const hit = this.hitTest(e.clientX, e.clientY);
        if (hit) this.onTap?.(hit);
      }
      return;
    }

    const first = this.trail[0];
    const last = this.trail[this.trail.length - 1];
    const vx = first && last && last.t > first.t ? (last.p.x - first.p.x) / (last.t - first.t) : 0;
    const crossed = turn.dir === 1 ? turn.pointer.x < this.W : turn.pointer.x > this.W;
    const flick = turn.dir === 1 ? vx < -FLICK_SPEED : vx > FLICK_SPEED;
    const flickBack = turn.dir === 1 ? vx > FLICK_SPEED : vx < -FLICK_SPEED;
    this.settle(turn, (crossed || flick) && !flickBack, 0.7);
  };

  private readonly handleCancel = (): void => {
    this.pressing = false;
    const turn = this.turn;
    this.down = null;
    if (turn && turn.phase === 'drag') this.settle(turn, false, 0.6);
  };

  private readonly handleLeave = (): void => {
    const turn = this.turn;
    if (turn?.phase === 'peek') {
      turn.releasing = true;
      turn.desired = turn.corner;
      this.requestFrame();
    }
  };

  // ── Rendering ─────────────────────────────────────────────────────────────

  private hasPage(index: number): boolean {
    return index >= 0 && index < this.pages.length;
  }

  private rectFor(index: number): { x: number; y: number } {
    return { x: index % 2 === 0 ? this.W : 0, y: 0 };
  }

  private texture(index: number): HTMLCanvasElement | null {
    const cached = this.textures.get(index);
    if (cached && !this.dirty.has(index)) return cached;
    const spec = this.pages[index];
    if (!spec || typeof document === 'undefined') return null;
    // Reuse the existing bitmap when repainting an edited page: no allocation, no GC.
    const c = cached ?? document.createElement('canvas');
    if (!cached) {
      c.width = Math.max(1, Math.round(this.W * this.dpr));
      c.height = Math.max(1, Math.round(this.H * this.dpr));
    }
    // Opaque, like the paper it is: the browser can then smooth text as sharply as it does the app's own
    // (sub-pixel), not the soft grey it uses on see-through canvases. Every page paints its whole rectangle.
    const g = c.getContext('2d', { alpha: false });
    if (!g) return null;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.scale(c.width / PAGE_W, c.height / PAGE_H);
    this.paint(g, spec, index);
    this.textures.set(index, c);
    this.dirty.delete(index);
    return c;
  }

  private drawOverlay(ctx: CanvasRenderingContext2D): void {
    const o = this.overlay;
    if (!o) return;
    const k = this.W / PAGE_W;
    const { left, right } = this.visiblePages();
    const onScreen = (page: number): boolean => page === left || page === right;
    ctx.save();
    ctx.fillStyle = COLORS.selection;
    for (const r of o.selection ?? []) {
      if (!onScreen(r.page)) continue;
      ctx.fillRect(this.rectFor(r.page).x + r.x * k, r.y * k, r.w * k, r.h * k);
    }
    const c = o.caret;
    if (c && this.caretOn && onScreen(c.page)) {
      ctx.fillStyle = COLORS.accent;
      ctx.fillRect(this.rectFor(c.page).x + c.x * k - 0.75, c.y * k, Math.max(1.3, 1.6 * k), c.h * k);
    }
    ctx.restore();
  }

  private drawMarker(ctx: CanvasRenderingContext2D): void {
    const m = this.marker;
    if (!m || !this.hasPage(m.page)) return;
    const { left, right } = this.visiblePages();
    if (m.page !== left && m.page !== right) return;
    const k = this.W / PAGE_W;
    const x = this.rectFor(m.page).x + m.x * k;
    const y = m.y * k;
    ctx.save();
    ctx.fillStyle = 'rgba(201, 164, 92, 0.16)';
    ctx.fillRect(x - 6 * k, y, m.w * k + 12 * k, m.h * k);
    ctx.fillStyle = COLORS.accent;
    ctx.fillRect(x - 16 * k, y + 4 * k, 2.5 * k, m.h * k - 8 * k);
    ctx.restore();
  }

  private drawPage(ctx: CanvasRenderingContext2D, index: number, at = this.rectFor(index)): void {
    if (!this.hasPage(index)) return;
    const tex = this.texture(index);
    if (tex) ctx.drawImage(tex, at.x, at.y, this.W, this.H);
  }

  /** Paints only the shadow of a rectangle (the shape itself is drawn off-canvas). */
  private castShadow(ctx: CanvasRenderingContext2D, x: number, y: number, alpha: number): void {
    if (alpha <= 0) return;
    const away = 20000;
    ctx.save();
    ctx.shadowColor = `rgba(8, 14, 12, ${0.55 * alpha})`;
    ctx.shadowBlur = Math.max(8, this.W * 0.09) * this.dpr;
    ctx.shadowOffsetX = away * this.dpr;
    ctx.shadowOffsetY = this.W * 0.04 * this.dpr;
    ctx.fillStyle = '#000';
    ctx.fillRect(x - away, y, this.W, this.H);
    ctx.restore();
  }

  private drawStacks(ctx: CanvasRenderingContext2D): void {
    const leaves = this.pages.length / 2;
    const unit = this.W / 360;
    const leftLeaves = this.spreadIndex;
    const rightLeaves = leaves - this.spreadIndex;
    const draw = (count: number, side: 'left' | 'right'): void => {
      const depth = Math.min(7, count * 0.55) * unit;
      if (depth <= 0.2) return;
      const lines = Math.max(1, Math.round(depth / unit));
      for (let i = lines; i >= 1; i--) {
        const d = (depth * i) / lines;
        ctx.fillStyle = i % 2 ? COLORS.edgeLight : COLORS.edgeDark;
        if (side === 'right') ctx.fillRect(this.W, d * 0.45, this.W + d, this.H);
        else ctx.fillRect(-d, d * 0.45, this.W + d, this.H);
      }
    };
    draw(leftLeaves - (this.spreadIndex > 0 ? 1 : 0), 'left');
    draw(rightLeaves - (this.spreadIndex < this.lastSpread ? 1 : 0), 'right');
  }

  private drawBase(ctx: CanvasRenderingContext2D): void {
    const s = this.spreadIndex;
    const t = this.turn;
    const p = this.progress();
    let left = this.hasPage(2 * s - 1) ? 1 : 0;
    let right = this.hasPage(2 * s) ? 1 : 0;
    if (t && t.phase !== 'peek') {
      // The landing side only gains its shadow as the leaf settles onto it.
      const landing = clamp((p - 0.8) / 0.2, 0, 1);
      if (t.dir === 1) {
        left = Math.max(left, landing);
        if (!this.hasPage(2 * s + 2)) right = 1 - p;
      } else {
        right = Math.max(right, landing);
        if (!this.hasPage(2 * s - 3)) left = 1 - p;
      }
    }
    this.castShadow(ctx, 0, 0, left);
    this.castShadow(ctx, this.W, 0, right);
    this.drawStacks(ctx);
  }

  private drawSpineCrease(ctx: CanvasRenderingContext2D): void {
    const { left, right } = this.visiblePages();
    if (left === null || right === null) return;
    // The fold itself: warm on cream paper, black on dark paper (never a brown line on a dark page).
    const dark = darkPaper();
    const ink = dark ? '0, 0, 0' : '40, 26, 14';
    const g = ctx.createLinearGradient(this.W - 6, 0, this.W + 6, 0);
    g.addColorStop(0, `rgba(${ink}, 0)`);
    g.addColorStop(0.5, `rgba(${ink}, ${dark ? 0.7 : 0.3})`);
    g.addColorStop(1, `rgba(${ink}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(this.W - 6, 0, 12, this.H);
  }

  private pathPolygon(ctx: CanvasRenderingContext2D, poly: readonly Vec[]): void {
    ctx.beginPath();
    poly.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
    ctx.closePath();
  }

  private turnPages(dir: Direction): { flipping: number; back: number; under: number; stay: number } {
    const s = this.spreadIndex;
    return dir === 1
      ? { flipping: 2 * s, back: 2 * s + 1, under: 2 * s + 2, stay: 2 * s - 1 }
      : { flipping: 2 * s - 1, back: 2 * s - 2, under: 2 * s - 3, stay: 2 * s };
  }

  /** A soft paper leaf folding along the bisector of corner and pointer. */
  private drawSoftTurn(ctx: CanvasRenderingContext2D, turn: Turn, fold: Fold): void {
    const { flipping, back, under, stay } = this.turnPages(turn.dir);
    const flipRect = this.rectFor(flipping);
    const leaf = rectPolygon(flipRect.x, flipRect.y, this.W, this.H);
    const lifted = clipPolygon(leaf, fold, 1);
    const flat = clipPolygon(leaf, fold, -1);
    const turned = lifted.map((pt) => reflectPoint(pt, fold));
    const depth = maxFoldDistance(lifted, fold);
    const p = this.progress();
    const intensity = 0.35 + 0.65 * Math.sin(Math.PI * clamp(p * 1.1, 0, 1));

    this.drawPage(ctx, stay);
    this.drawPage(ctx, under);
    this.drawSpineCrease(ctx);

    // Shadow the lifted leaf casts onto the page it reveals.
    if (lifted.length > 2) {
      ctx.save();
      this.pathPolygon(ctx, lifted);
      ctx.clip();
      const reach = clamp(depth * 0.55, this.W * 0.04, this.W * 0.4);
      const g = ctx.createLinearGradient(
        fold.mid.x,
        fold.mid.y,
        fold.mid.x + fold.normal.x * reach,
        fold.mid.y + fold.normal.y * reach,
      );
      g.addColorStop(0, `rgba(10, 8, 6, ${0.5 * intensity})`);
      g.addColorStop(0.35, `rgba(10, 8, 6, ${0.18 * intensity})`);
      g.addColorStop(1, 'rgba(10, 8, 6, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 2 * this.W, this.H);
      ctx.restore();
    }

    // The part of the leaf still lying flat.
    if (flat.length > 2) {
      ctx.save();
      this.pathPolygon(ctx, flat);
      ctx.clip();
      this.drawPage(ctx, flipping);
      // The paper starts to rise just before the crease.
      const rise = Math.min(depth * 0.35, this.W * 0.12);
      const g = ctx.createLinearGradient(
        fold.mid.x,
        fold.mid.y,
        fold.mid.x - fold.normal.x * rise,
        fold.mid.y - fold.normal.y * rise,
      );
      g.addColorStop(0, `rgba(30, 20, 10, ${0.22 * intensity})`);
      g.addColorStop(1, 'rgba(30, 20, 10, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 2 * this.W, this.H);
      ctx.restore();
    }

    if (turned.length < 3) return;

    // Drop shadow of the turning leaf onto everything beneath it.
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${0.38 * intensity})`;
    ctx.shadowBlur = this.W * 0.08 * this.dpr;
    ctx.shadowOffsetX = -fold.normal.x * this.W * 0.02 * this.dpr;
    ctx.shadowOffsetY = this.W * 0.012 * this.dpr;
    ctx.fillStyle = COLORS.paper;
    this.pathPolygon(ctx, turned);
    ctx.fill();
    ctx.restore();

    // The reverse side of the leaf: mirror about the spine, then about the fold.
    ctx.save();
    this.pathPolygon(ctx, turned);
    ctx.clip();
    const [a, b, c, d, e, f] = multiply(reflectionMatrix(fold), mirrorXMatrix(this.W));
    ctx.transform(a, b, c, d, e, f);
    this.drawPage(ctx, back);
    ctx.restore();

    // Curvature lighting across the turned paper.
    ctx.save();
    this.pathPolygon(ctx, turned);
    ctx.clip();
    const span = Math.max(depth, 1);
    const g = ctx.createLinearGradient(
      fold.mid.x,
      fold.mid.y,
      fold.mid.x - fold.normal.x * span,
      fold.mid.y - fold.normal.y * span,
    );
    g.addColorStop(0, `rgba(20, 12, 4, ${0.32 * intensity})`);
    g.addColorStop(0.04, `rgba(20, 12, 4, ${0.14 * intensity})`);
    g.addColorStop(0.16, `rgba(255, 252, 240, ${0.2 * intensity})`);
    g.addColorStop(0.32, `rgba(255, 252, 240, ${0.06 * intensity})`);
    g.addColorStop(0.7, 'rgba(20, 12, 4, 0.02)');
    g.addColorStop(1, `rgba(20, 12, 4, ${0.14 * intensity})`);
    ctx.fillStyle = g;
    ctx.fillRect(-this.W, -this.H, 4 * this.W, 3 * this.H);
    ctx.restore();

    // A hairline edge so the leaf reads crisply against the page below.
    ctx.save();
    ctx.strokeStyle = 'rgba(90, 70, 45, 0.25)';
    ctx.lineWidth = 0.6;
    this.pathPolygon(ctx, turned);
    ctx.stroke();
    ctx.restore();
  }

  /** A rigid board (the covers) swinging on its hinge with slight perspective. */
  private drawHardTurn(ctx: CanvasRenderingContext2D, turn: Turn): void {
    const { flipping, back, under, stay } = this.turnPages(turn.dir);
    const p = this.progress();
    const angle = p * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    this.drawPage(ctx, stay);
    this.drawPage(ctx, under);

    // Shadow on the page being uncovered, strongest while the board is low.
    const underRect = this.rectFor(flipping);
    if (this.hasPage(under) && cos > 0) {
      const dirOut = turn.dir === 1 ? 1 : -1;
      const reach = this.W * cos;
      const g = ctx.createLinearGradient(this.W + dirOut * reach, 0, this.W + dirOut * (reach + this.W * 0.25), 0);
      g.addColorStop(0, `rgba(0,0,0,${0.35 * cos})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(underRect.x, 0, this.W, this.H);
    }

    const front = cos >= 0;
    const index = front ? flipping : back;
    const tex = this.hasPage(index) ? this.texture(index) : null;
    const sign = (turn.dir === 1 ? 1 : -1) * (front ? 1 : -1);
    const scaleX = Math.abs(cos);
    const pageOnRight = index % 2 === 0;
    const strips = 28;

    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.3 + 0.25 * sin})`;
    ctx.shadowBlur = this.W * (0.04 + 0.1 * sin) * this.dpr;
    ctx.shadowOffsetY = this.W * 0.03 * sin * this.dpr;
    ctx.fillStyle = COLORS.cloth;
    ctx.beginPath();
    const farLift = 1 + 0.1 * sin;
    const xFar = this.W + sign * this.W * scaleX;
    ctx.moveTo(this.W, 0);
    ctx.lineTo(xFar, (this.H * (1 - farLift)) / 2);
    ctx.lineTo(xFar, (this.H * (1 + farLift)) / 2);
    ctx.lineTo(this.W, this.H);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (tex && scaleX > 0.002) {
      for (let i = 0; i < strips; i++) {
        const u0 = (this.W * i) / strips;
        const u1 = (this.W * (i + 1)) / strips;
        const x0 = this.W + sign * u0 * scaleX;
        const x1 = this.W + sign * u1 * scaleX;
        const lift = 1 + 0.1 * sin * ((u0 + u1) / 2 / this.W);
        const h = this.H * lift;
        const srcU0 = pageOnRight ? u0 : this.W - u1;
        const k = tex.width / this.W;
        ctx.drawImage(
          tex,
          srcU0 * k,
          0,
          (u1 - u0) * k,
          tex.height,
          Math.min(x0, x1) - 0.4,
          (this.H - h) / 2,
          Math.abs(x1 - x0) + 0.8,
          h,
        );
      }
      // Light falls off as the board tilts away.
      const shade = front ? 0.45 * (1 - cos) : 0.45 * (1 - Math.abs(cos));
      ctx.fillStyle = `rgba(0,0,0,${shade * 0.6})`;
      ctx.beginPath();
      ctx.moveTo(this.W, 0);
      ctx.lineTo(xFar, (this.H * (1 - farLift)) / 2);
      ctx.lineTo(xFar, (this.H * (1 + farLift)) / 2);
      ctx.lineTo(this.W, this.H);
      ctx.closePath();
      ctx.fill();
    }
  }

  render(): void {
    const ctx = this.ctx;
    if (!ctx || this.W === 0) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.originX(), this.originY());

    this.drawBase(ctx);

    const turn = this.turn;
    const fold = turn ? computeFold(turn.corner, turn.pointer) : null;
    if (!turn || !fold) {
      const { left, right } = this.visiblePages();
      if (left !== null) this.drawPage(ctx, left);
      if (right !== null) this.drawPage(ctx, right);
      this.drawSpineCrease(ctx);
      this.drawMarker(ctx);
      if (!turn) this.drawOverlay(ctx);
      if (!turn) this.scheduleWarm();
      return;
    }
    if (turn.hard) this.drawHardTurn(ctx, turn);
    else this.drawSoftTurn(ctx, turn, fold);
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function assertEvenPages(pages: readonly PageSpec[]): void {
  if (pages.length < 2 || pages.length % 2 !== 0) {
    throw new Error('A book needs an even number of pages (front and back of each leaf).');
  }
}
