import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Gift,
  Palette,
  Award,
  AppWindow,
  Copy,
  Check,
  Share2,
  Heart,
  Mail,
  Globe,
  Lock,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import {
  THEMES,
  BADGES,
  ICONS,
  CHARITY_URL,
  CHARITY_NAME,
  referralLink,
  shareIntents,
  isUnlocked,
  COSMETICS_ALL_FREE,
  unlock,
  getActiveThemeId,
  setActiveTheme,
  getActiveBadgeId,
  setActiveBadge,
  appIconStatus,
  setActiveIcon,
  DEFAULT_ICON_ID,
  COSMETICS_CHANGED_EVENT,
  type UnlockKind,
} from "@/lib/cosmetics";

const cardClass = "rounded-[var(--radius)] border border-border bg-card p-5";

/** Force a re-render whenever unlocks / active picks change (they mutate
 * localStorage and fire COSMETICS_CHANGED_EVENT rather than living in state). */
function useCosmeticsVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const bump = () => setV((n) => n + 1);
    window.addEventListener(COSMETICS_CHANGED_EVENT, bump);
    return () => window.removeEventListener(COSMETICS_CHANGED_EVENT, bump);
  }, []);
  return v;
}

/** The unlock buttons for a locked cosmetic. Honest by design: clicking opens
 * the share/donate link AND unlocks the cosmetic, then shows a thank-you. */
function UnlockActions({
  id,
  kind,
  link,
}: {
  id: string;
  kind: UnlockKind;
  link: string;
}) {
  const intents = shareIntents(link);
  const doUnlock = (url: string) => {
    // Unlock first (never lose the reward if the browser open is blocked),
    // then open the link in the system browser.
    unlock(id);
    openUrl(url).catch(() => {});
  };

  if (kind === "donate") {
    return (
      <div className="space-y-1.5">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => doUnlock(CHARITY_URL)}
        >
          <Heart className="h-3.5 w-3.5" />
          Donate to unlock
        </Button>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Opens {CHARITY_NAME}. On our honour — give here or to any cause you love, and it unlocks.
        </p>
      </div>
    );
  }

  // Share.
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" className="flex-1" onClick={() => doUnlock(intents.x)}>
          <Share2 className="h-3.5 w-3.5" />X
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => doUnlock(intents.linkedin)}
        >
          <Globe className="h-3.5 w-3.5" />
          In
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={() => doUnlock(intents.email)}
        >
          <Mail className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="text-[11px] leading-snug text-muted-foreground">
        Share Lalela to unlock — thanks for spreading the word.
      </p>
    </div>
  );
}

/** The invite-link card: copy + prefilled share intents. */
function InviteCard({ link, signedIn }: { link: string; signedIn: boolean }) {
  const [copied, setCopied] = useState(false);
  const intents = shareIntents(link);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  return (
    <div className={cardClass}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-accent/15 text-accent">
          <Share2 className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">Invite a colleague</h3>
          <p className="text-sm text-muted-foreground">
            {signedIn
              ? "Know someone who'd like calmer meetings? Send them your link. Lalela is free, private and local-first."
              : "Sign in to get a personal invite link. For now this is the public download link."}
          </p>
          <div className="mt-3 flex gap-2">
            <input
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-sm text-muted-foreground outline-none"
            />
            <Button variant="outline" size="sm" onClick={copy} className="shrink-0">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => openUrl(intents.x).catch(() => {})}>
              <Share2 className="h-3.5 w-3.5" />
              Share on X
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openUrl(intents.linkedin).catch(() => {})}
            >
              <Globe className="h-3.5 w-3.5" />
              LinkedIn
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openUrl(intents.email).catch(() => {})}>
              <Mail className="h-3.5 w-3.5" />
              Email
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One theme tile: preview swatch + state (applied / apply / locked). */
function ThemeTile({ themeId, link }: { themeId: string; link: string }) {
  const t = THEMES.find((x) => x.id === themeId)!;
  const unlocked = isUnlocked(t.id);
  const active = getActiveThemeId() === t.id;
  return (
    <div
      className={cn(
        "flex flex-col rounded-[var(--radius)] border p-3",
        active ? "border-accent ring-1 ring-accent" : "border-border",
      )}
    >
      <div
        className="mb-2 flex h-16 items-center justify-center gap-1.5 rounded-[var(--radius)] border border-border"
        style={{ background: t.preview.bg }}
      >
        <span
          className="h-6 w-6 rounded-full"
          style={{ background: t.preview.primary }}
          aria-hidden
        />
        <span
          className="h-6 w-6 rounded-full"
          style={{ background: t.preview.accent }}
          aria-hidden
        />
        <span
          className="text-xs font-semibold"
          style={{ color: t.preview.text }}
        >
          Aa
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-semibold">{t.label}</span>
        {!unlocked && <Lock className="h-3 w-3 text-muted-foreground" />}
      </div>
      <p className="mb-2 mt-0.5 flex-1 text-xs text-muted-foreground">{t.description}</p>
      {unlocked ? (
        active ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-accent">
            <Check className="h-3.5 w-3.5" /> Applied
          </span>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setActiveTheme(t.id)}>
            Apply
          </Button>
        )
      ) : (
        <UnlockActions id={t.id} kind={t.unlock} link={link} />
      )}
    </div>
  );
}

/** One badge tile: glyph + state (wearing / wear / locked). */
function BadgeTile({ badgeId, link }: { badgeId: string; link: string }) {
  const b = BADGES.find((x) => x.id === badgeId)!;
  const unlocked = isUnlocked(b.id);
  const worn = getActiveBadgeId() === b.id;
  return (
    <div
      className={cn(
        "flex flex-col rounded-[var(--radius)] border p-3",
        worn ? "border-accent ring-1 ring-accent" : "border-border",
      )}
    >
      <div className="mb-2 flex h-16 items-center justify-center rounded-[var(--radius)] bg-surface text-3xl">
        <span aria-hidden style={{ filter: unlocked ? "none" : "grayscale(1) opacity(0.4)" }}>
          {b.glyph}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-semibold">{b.label}</span>
        {!unlocked && <Lock className="h-3 w-3 text-muted-foreground" />}
      </div>
      <p className="mb-2 mt-0.5 flex-1 text-xs text-muted-foreground">{b.description}</p>
      {unlocked ? (
        worn ? (
          <Button size="sm" variant="ghost" onClick={() => setActiveBadge("")}>
            Remove
          </Button>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setActiveBadge(b.id)}>
            Wear
          </Button>
        )
      ) : (
        <UnlockActions id={b.id} kind={b.unlock} link={link} />
      )}
    </div>
  );
}

/** Load the app-icon platform support + active id, reloading whenever unlocks /
 * active picks change. If the persisted icon is somehow no longer unlocked (the
 * ledger was wiped), reconcile back to the default so the picker and the running
 * Dock icon agree. macOS-desktop-only; `supported:false` everywhere else. */
function useAppIcon(): { supported: boolean; active: string } {
  const [state, setState] = useState<{ supported: boolean; active: string }>({
    supported: false,
    active: DEFAULT_ICON_ID,
  });
  useEffect(() => {
    let alive = true;
    const load = () => {
      appIconStatus().then((s) => {
        if (!alive) return;
        if (s.active !== DEFAULT_ICON_ID && !isUnlocked(s.active)) {
          setActiveIcon(DEFAULT_ICON_ID).catch(() => {});
          setState({ supported: s.supported, active: DEFAULT_ICON_ID });
        } else {
          setState(s);
        }
      });
    };
    load();
    window.addEventListener(COSMETICS_CHANGED_EVENT, load);
    return () => {
      alive = false;
      window.removeEventListener(COSMETICS_CHANGED_EVENT, load);
    };
  }, []);
  return state;
}

/** A tiny CSS echo of the Lalela mark — a rounded tile with the waveform bars in
 * the variant's colour. Greyed when the variant is still locked. */
function IconGlyph({ bg, bars, muted }: { bg: string; bars: string; muted: boolean }) {
  const heights = [14, 22, 30, 20, 11];
  return (
    <div
      className="flex h-11 w-11 items-end justify-center gap-[3px] rounded-[11px] p-[9px]"
      style={{ background: bg, filter: muted ? "grayscale(1) opacity(0.45)" : "none" }}
      aria-hidden
    >
      {heights.map((h, i) => (
        <span key={i} style={{ height: h, width: 3.5, borderRadius: 2, background: bars }} />
      ))}
    </div>
  );
}

/** One app-icon tile: preview mark + state (applied / apply / locked). */
function IconTile({
  iconId,
  link,
  activeId,
  onApply,
}: {
  iconId: string;
  link: string;
  activeId: string;
  onApply: (id: string) => void;
}) {
  const ic = ICONS.find((x) => x.id === iconId)!;
  const unlocked = isUnlocked(ic.id);
  const active = activeId === ic.id;
  return (
    <div
      className={cn(
        "flex flex-col rounded-[var(--radius)] border p-3",
        active ? "border-accent ring-1 ring-accent" : "border-border",
      )}
    >
      <div className="mb-2 flex h-16 items-center justify-center rounded-[var(--radius)] bg-surface">
        <IconGlyph bg={ic.preview.bg} bars={ic.preview.bars} muted={!unlocked} />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-sm font-semibold">{ic.label}</span>
        {!unlocked && <Lock className="h-3 w-3 text-muted-foreground" />}
      </div>
      <p className="mb-2 mt-0.5 flex-1 text-xs text-muted-foreground">{ic.description}</p>
      {unlocked ? (
        active ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-accent">
            <Check className="h-3.5 w-3.5" /> Applied
          </span>
        ) : (
          <Button size="sm" variant="outline" onClick={() => onApply(ic.id)}>
            Apply
          </Button>
        )
      ) : (
        <UnlockActions id={ic.id} kind={ic.unlock} link={link} />
      )}
    </div>
  );
}

/**
 * Rewards (Wave E1) — the Settings "Rewards" tab. Share Lalela or donate to a
 * charity to unlock free cosmetic themes and profile badges. Nothing functional
 * is ever gated; this is a look, not a feature. All persistence is local.
 */
export function RewardsPanel() {
  const { user } = useAuth();
  useCosmeticsVersion(); // re-render on unlock / active-pick changes
  const icon = useAppIcon(); // app-icon support + active id (macOS only)
  const link = referralLink(user?.id);
  const applyIcon = (id: string) => {
    setActiveIcon(id).catch(() => {});
  };

  return (
    <div className="grid gap-4">
      {/* Positioning banner */}
      <div className="rounded-[var(--radius)] border border-primary/40 bg-primary/10 p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0 rounded-full bg-primary/25 p-2 text-foreground">
            <Gift className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              {COSMETICS_ALL_FREE ? "Pick a look" : "Unlock a look, not a feature"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Every part of Lalela is free, private and yours already — nothing here is paywalled.
              {COSMETICS_ALL_FREE
                ? " These themes and badges are just for fun, and all of them are yours to use."
                : " These themes and badges are just for fun: share Lalela with someone, or give to a charity, and they're yours to keep on this device."}
            </p>
          </div>
        </div>
      </div>

      <InviteCard link={link} signedIn={!!user} />

      {/* Themes */}
      <div className={cardClass}>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-primary/15 text-foreground">
            <Palette className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">Themes</h3>
            <p className="text-sm text-muted-foreground">
              A fresh accent or a light-on-dark canvas. Applies instantly and stays put.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {THEMES.map((t) => (
                <ThemeTile key={t.id} themeId={t.id} link={link} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Badges */}
      <div className={cardClass}>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-primary/15 text-foreground">
            <Award className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold">Profile badges</h3>
            <p className="text-sm text-muted-foreground">
              A little flair beside your name on the Account tab. Wear one, or none.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {BADGES.map((b) => (
                <BadgeTile key={b.id} badgeId={b.id} link={link} />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* App icon (macOS desktop only — hidden on iOS / other desktop) */}
      {icon.supported && (
        <div className={cardClass}>
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-primary/15 text-foreground">
              <AppWindow className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="font-semibold">App icon</h3>
              <p className="text-sm text-muted-foreground">
                Give the Dock a fresh coat. Applies to Lalela&apos;s icon while it&apos;s running.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {ICONS.map((ic) => (
                  <IconTile
                    key={ic.id}
                    iconId={ic.id}
                    link={link}
                    activeId={icon.active}
                    onApply={applyIcon}
                  />
                ))}
              </div>
              <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
                This changes the icon in your Dock while Lalela is open. The icon in Finder and the
                Applications folder stays the classic mark.
              </p>
            </div>
          </div>
        </div>
      )}

      <p className="px-1 text-[11px] text-muted-foreground">
        Unlocks and your chosen look are saved on this device. Syncing them across your devices is
        coming later.
      </p>
    </div>
  );
}
