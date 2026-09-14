export type MouseButton = "left" | "right" | "middle";

export interface ScreenInfo {
  width: number;
  height: number;
  left: number;
  top: number;
}

export interface CapturedScreen {
  /** JPEG bytes, scaled down to at most `maxWidth` wide. */
  image: Buffer;
  width: number;
  height: number;
  /** Screenshot pixels per screen pixel (≤ 1). */
  scale: number;
  screen: ScreenInfo;
}

/** Low-level desktop control. Coordinates are physical screen pixels. */
export interface ComputerDriver {
  readonly platform: string;
  start(): Promise<ScreenInfo>;
  stop(): Promise<void>;
  screen(): Promise<ScreenInfo>;
  screenshot(maxWidth: number): Promise<CapturedScreen>;
  cursor(): Promise<{ x: number; y: number }>;
  move(x: number, y: number): Promise<void>;
  click(x: number, y: number, button: MouseButton, count: number): Promise<void>;
  drag(fromX: number, fromY: number, toX: number, toY: number, button: MouseButton): Promise<void>;
  /** Positive dy scrolls down; units are wheel notches. */
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  type(text: string): Promise<void>;
  /** Key names: letters, digits, enter, tab, escape, arrows, f1–f12 and modifiers ctrl/alt/shift. */
  key(keys: string[]): Promise<void>;
}

export interface DriverAvailability {
  available: boolean;
  reason?: string;
}
