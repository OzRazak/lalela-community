// Wave E1 — cosmetic rewards (themes + badges) unlocked by an honor-system
// share or charity donation.
//
// Binding product rule: NOTHING functional is ever gated. Lalela is free,
// private and local-first, and every feature is yours regardless of any of
// this. These rewards are purely a look — "unlock a look, not a feature."
//
// Because a share or a donation cannot be verified server-side, unlocking is
// honest: clicking an action opens the link AND unlocks the cosmetic. No
// deception, no fake gating of function — just a friendly thank-you.
//
// Persistence is local-only (localStorage) for v1. Cross-device sync of
// unlocks / active picks is intentionally out of scope; a later phase could
// mirror these to the SQLite settings K/V or Supabase.
//
// One exception: the ACTIVE app icon (macOS only) lives in the SQLite settings
// K/V, not localStorage — because a Rust command applies it and re-applies it at
// launch (the running Dock icon). The unlock *ledger* below still governs which
// icons are pickable, so it stays consistent with themes/badges.

import { invoke } from "@tauri-apps/api/core";
import { IS_MOBILE } from "./platform";
import { IS_STORE_BUILD } from "./distribution";

/** Referral + share links point at the marketing site. */
export const MARKETING_BASE = "https://lalela.auxodigital.africa";

/** A reputable, no-strings charity for the "donate to unlock" action. The
 * honor system means we never see whether you actually gave — donate here, or
 * to any cause you care about, and your reward unlocks either way. */
export const CHARITY_URL = "https://www.givedirectly.org/";
export const CHARITY_NAME = "GiveDirectly";

/** How a cosmetic is unlocked. "free" items are always available. */
export type UnlockKind = "free" | "share" | "donate";

// --- Themes -----------------------------------------------------------------
// A theme is a thin layer over the canonical Amp/Lalela tokens (globals.css):
// it overrides a handful of CSS custom properties on :root at runtime. We never
// fork the stylesheet — every `bg-primary` / `text-accent` utility already
// resolves through var(--color-*), so swapping the variable re-skins the whole
// app instantly. Tokens NOT listed fall back to the globals.css defaults.

export interface ThemeDef {
  id: string;
  label: string;
  description: string;
  unlock: UnlockKind;
  /** CSS custom-property overrides applied to document.documentElement. */
  tokens: Record<string, string>;
  /** Three colours for the settings preview chip (bg · primary · accent). */
  preview: { bg: string; primary: string; accent: string; text: string };
}

export const THEMES: ThemeDef[] = [
  {
    id: "aurora",
    label: "Aurora",
    description: "The signature Lalela look — Auxo yellow on clean paper.",
    unlock: "free",
    tokens: {},
    preview: { bg: "#ffffff", primary: "#ffd200", accent: "hsl(220 80% 55%)", text: "#343330" },
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "A calm teal accent over the same bright canvas.",
    unlock: "share",
    tokens: {
      "--color-accent": "hsl(190 85% 40%)",
      "--color-accent-foreground": "#ffffff",
      "--color-ring": "hsl(190 85% 40%)",
      "--color-speaker-me": "hsl(190 85% 40%)",
      "--color-surface": "hsl(190 40% 98%)",
    },
    preview: { bg: "#ffffff", primary: "#ffd200", accent: "hsl(190 85% 40%)", text: "#343330" },
  },
  {
    id: "sunset",
    label: "Sunset",
    description: "Warm coral highlights on a softly-tinted paper.",
    unlock: "donate",
    tokens: {
      "--color-accent": "hsl(14 88% 55%)",
      "--color-accent-foreground": "#ffffff",
      "--color-ring": "hsl(14 88% 55%)",
      "--color-speaker-me": "hsl(14 88% 55%)",
      "--color-muted": "hsl(24 45% 96%)",
      "--color-surface": "hsl(24 45% 98%)",
    },
    preview: { bg: "#fff8f4", primary: "#ffd200", accent: "hsl(14 88% 55%)", text: "#343330" },
  },
  {
    id: "midnight",
    label: "Midnight",
    description: "Light-on-dark — the yellow mark glows against ink.",
    unlock: "share",
    tokens: {
      "--color-background": "#17171b",
      "--color-foreground": "#e9e9ec",
      "--color-card": "#202027",
      "--color-card-foreground": "#e9e9ec",
      "--color-muted": "#26262e",
      "--color-muted-foreground": "#9a9aa4",
      "--color-surface": "#1d1d23",
      "--color-border": "#31313a",
      "--color-input": "#31313a",
      "--color-accent": "hsl(220 85% 66%)",
      "--color-accent-foreground": "#ffffff",
      "--color-ring": "hsl(220 85% 66%)",
    },
    preview: { bg: "#17171b", primary: "#ffd200", accent: "hsl(220 85% 66%)", text: "#e9e9ec" },
  },
];

export const DEFAULT_THEME_ID = THEMES[0].id;

/** Union of every token any theme touches — cleared before applying a theme so
 * switching away from Midnight (which recolours the whole canvas) fully resets
 * to the globals.css defaults before the next theme's overrides go on. */
const ALL_THEME_VARS = Array.from(
  new Set(THEMES.flatMap((t) => Object.keys(t.tokens))),
);

// --- Badges -----------------------------------------------------------------
// Purely decorative glyphs shown next to your name on the account surface.
// Emoji so they render anywhere with zero icon wiring.
// Copy rule (1.3.11, all builds): names/descriptions describe the badge, never
// how it was earned — nothing may read like a donation, financial support, or
// paying/sharing to unlock (Microsoft Store 10.8, App Review 3.1.1 / 3.2.2(x)).
// Ids are stable (stored in the unlock ledger); only the strings changed.

export interface BadgeDef {
  id: string;
  label: string;
  description: string;
  glyph: string;
  unlock: UnlockKind;
}

export const BADGES: BadgeDef[] = [
  {
    id: "advocate",
    label: "Advocate",
    description: "For people who care about private, on-device notes.",
    glyph: "📣",
    unlock: "share",
  },
  {
    id: "connector",
    label: "Connector",
    description: "For bringing people together in calmer meetings.",
    glyph: "🔗",
    unlock: "share",
  },
  {
    id: "philanthropist",
    label: "Kind Heart",
    description: "For leading meetings with warmth.",
    glyph: "💛",
    unlock: "donate",
  },
  {
    id: "trailblazer",
    label: "Trailblazer",
    description: "For trying a new way to run meetings.",
    glyph: "🚀",
    unlock: "donate",
  },
];

// --- App icons (macOS desktop only) -----------------------------------------
// A re-coloured Lalela mark for the Dock. Unlike themes (pure CSS) and badges
// (an emoji), swapping the icon calls into Rust: it sets the RUNNING app's
// NSApplication.applicationIconImage and re-applies on launch. The static bundle
// .icns is unchanged — Finder/Cmd-Tab-before-launch keep the stock mark (a full
// alternate-bundle icon is out of scope for v1; see docs/DECISIONS.md). Off
// macOS the picker hides itself (the Rust command reports `supported: false`).

export interface IconDef {
  id: string;
  label: string;
  description: string;
  unlock: UnlockKind;
  /** Two colours for the settings preview chip (canvas · sound-wave bars). */
  preview: { bg: string; bars: string };
}

export const ICONS: IconDef[] = [
  {
    id: "default",
    label: "Classic",
    description: "The signature Lalela mark — gold waves on ink.",
    unlock: "free",
    preview: { bg: "#0d0d0d", bars: "#efd465" },
  },
  {
    // Ledger id is "aqua" (not "ocean") so it never shares an unlock with the
    // Ocean *theme*; the label stays "Ocean" for a matching set.
    id: "aqua",
    label: "Ocean",
    description: "The same mark, re-tuned to a cool teal.",
    unlock: "share",
    preview: { bg: "#0d0d0d", bars: "#65ddef" },
  },
  {
    id: "coral",
    label: "Coral",
    description: "Warm coral waves for a friendlier Dock.",
    unlock: "donate",
    preview: { bg: "#0d0d0d", bars: "#ef7f65" },
  },
  {
    id: "violet",
    label: "Violet",
    description: "A bold violet take on the waveform.",
    unlock: "share",
    preview: { bg: "#0d0d0d", bars: "#ba65ef" },
  },
];

export const DEFAULT_ICON_ID = "default";

interface AppIconStatus {
  supported: boolean;
  active: string;
}

/** Whether alternate app icons work on this platform (macOS desktop). Cached so
 * the panel can decide once whether to render the picker at all. */
export async function appIconStatus(): Promise<AppIconStatus> {
  try {
    return await invoke<AppIconStatus>("app_icon_status");
  } catch {
    return { supported: false, active: DEFAULT_ICON_ID };
  }
}

/** The active icon id — but only if it's still unlocked; otherwise the default
 * (guards a stored id whose unlock was wiped). Reads the SQLite-backed status. */
export async function getActiveIconId(): Promise<string> {
  const { active } = await appIconStatus();
  const id = active || DEFAULT_ICON_ID;
  return isUnlocked(id) ? id : DEFAULT_ICON_ID;
}

/** Persist + apply an icon (default is always allowed; others must be unlocked).
 * Fires COSMETICS_CHANGED_EVENT so the panel re-renders the applied state. */
export async function setActiveIcon(id: string): Promise<void> {
  if (id !== DEFAULT_ICON_ID && !isUnlocked(id)) return;
  await invoke("set_app_icon", { id });
  emitChanged();
}

// --- Referral link ----------------------------------------------------------

/** A stable, non-PII referral code derived from the signed-in user id. FNV-1a
 * (32-bit) → base36; never exposes the id or email. The same account yields the
 * same code on every device, so a link stays valid. */
export function referralCode(userId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // A second pass over the reversed id widens the space a little (~10 chars).
  let g = 0x811c9dc5;
  for (let i = userId.length - 1; i >= 0; i--) {
    g ^= userId.charCodeAt(i);
    g = Math.imul(g, 0x01000193);
  }
  return ((h >>> 0).toString(36) + (g >>> 0).toString(36)).slice(0, 10);
}

/** The link to share. Signed in → a personal /r/<code> invite; signed out → a
 * generic download link (no code, nothing personal). */
export function referralLink(userId: string | null | undefined): string {
  if (userId) return `${MARKETING_BASE}/r/${referralCode(userId)}`;
  return `${MARKETING_BASE}/download`;
}

/** The one-line pitch that rides along with a share. */
export const SHARE_MESSAGE =
  "I'm using Lalela — a private, on-device meeting notetaker. It records both sides, transcribes on your own computer, and your audio never leaves the device. Free to use:";

/** Prefilled share-intent URLs for the common destinations. Each opens in the
 * system browser via the opener plugin. */
export function shareIntents(link: string): { x: string; linkedin: string; email: string } {
  const text = encodeURIComponent(SHARE_MESSAGE);
  const url = encodeURIComponent(link);
  return {
    x: `https://x.com/intent/post?text=${text}&url=${url}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
    email: `mailto:?subject=${encodeURIComponent("You should try Lalela")}&body=${text}%0A%0A${url}`,
  };
}

// --- Persistence (local-only) ----------------------------------------------

const KEYS = {
  unlocked: "lalela.cosmetics.unlocked",
  activeTheme: "lalela.cosmetics.theme",
  activeBadge: "lalela.cosmetics.badge",
} as const;

/** Fires on window whenever unlocks or the active theme/badge change, so the
 * account surface and any open Rewards panel re-render without prop-drilling. */
export const COSMETICS_CHANGED_EVENT = "lalela:cosmetics-changed";

function emitChanged(): void {
  window.dispatchEvent(new Event(COSMETICS_CHANGED_EVENT));
}

function readUnlocked(): Set<string> {
  try {
    const raw = localStorage.getItem(KEYS.unlocked);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Every cosmetic id that is "free" (always unlocked). */
function freeIds(): Set<string> {
  return new Set(
    [...THEMES, ...BADGES, ...ICONS].filter((c) => c.unlock === "free").map((c) => c.id),
  );
}

/** Mobile store builds (iOS/iPadOS, Android): everything is unlocked and the
 * share/donate gates never render. Unlocking digital items by donating through
 * an external link is an out-of-app purchase mechanism (App Review 3.1.1 /
 * 3.1.1(a)), and share-to-unlock is an incentive for an action Apple lists in
 * 3.2.2(x). The Microsoft Store build does the same (Store policy 10.8 on
 * digital goods outside Store commerce). Direct-download desktop keeps the gates. */
export const COSMETICS_ALL_FREE: boolean = IS_MOBILE || IS_STORE_BUILD;

export function isUnlocked(id: string): boolean {
  return COSMETICS_ALL_FREE || freeIds().has(id) || readUnlocked().has(id);
}

/** Record an unlock (idempotent). Free items are a no-op. */
export function unlock(id: string): void {
  if (freeIds().has(id) || readUnlocked().has(id)) return;
  const next = readUnlocked();
  next.add(id);
  localStorage.setItem(KEYS.unlocked, JSON.stringify([...next]));
  emitChanged();
}

// --- Active theme -----------------------------------------------------------

/** Apply a theme's token overrides to :root. Clears every theme var first so
 * switching themes never leaves stale overrides behind. Falls back to the
 * default theme for an unknown id. */
export function applyTheme(id: string): void {
  if (typeof document === "undefined") return;
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0];
  const root = document.documentElement;
  for (const v of ALL_THEME_VARS) root.style.removeProperty(v);
  for (const [k, val] of Object.entries(theme.tokens)) root.style.setProperty(k, val);
  root.setAttribute("data-cosmetic-theme", theme.id);
}

/** The active theme id — but only if it's still unlocked; otherwise the default
 * (guards against a stored id whose unlock was wiped). */
export function getActiveThemeId(): string {
  const id = localStorage.getItem(KEYS.activeTheme) ?? DEFAULT_THEME_ID;
  return isUnlocked(id) ? id : DEFAULT_THEME_ID;
}

export function setActiveTheme(id: string): void {
  if (!isUnlocked(id)) return;
  localStorage.setItem(KEYS.activeTheme, id);
  applyTheme(id);
  emitChanged();
}

/** Apply the persisted theme. Called from main.tsx before first paint so a
 * chosen theme never flashes the default. */
export function applyStoredTheme(): void {
  applyTheme(getActiveThemeId());
}

// --- Active badge -----------------------------------------------------------

/** The badge id worn on the profile, or "" for none. Cleared to "" if its
 * unlock was wiped. */
export function getActiveBadgeId(): string {
  const id = localStorage.getItem(KEYS.activeBadge) ?? "";
  return id && isUnlocked(id) ? id : "";
}

export function setActiveBadge(id: string): void {
  if (id && !isUnlocked(id)) return;
  localStorage.setItem(KEYS.activeBadge, id);
  emitChanged();
}

/** The worn badge definition, or null when none is set. */
export function activeBadge(): BadgeDef | null {
  const id = getActiveBadgeId();
  return BADGES.find((b) => b.id === id) ?? null;
}
