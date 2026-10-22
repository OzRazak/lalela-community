import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { appleLlmStatus, localLlmStatus, onLlmComplete } from "@/lib/lalela";
import {
  appleModelOption,
  DEFAULT_MODEL,
  isAppleModelId,
  isLocalModelId,
  LOCAL_MODEL_CATALOG,
  localModelOption,
  MODELS,
  type ModelOption,
} from "@/lib/settings";

// ---- Apple Intelligence availability (module-level, shared per app session) ----
//
// Apple's on-device option is resolved ONCE per session and shared across every
// picker mount, instead of each `useModelsState` re-probing on mount. Two
// reasons: the probe round-trips a resident Swift helper whose lock is held for
// the duration of each Apple generation (up to ~a minute per map-reduce chunk),
// and a per-mount probe blanks the option until it resolves — together that made
// the Apple entry disappear and reappear from every picker mid-generation.
//
// Invariants: availability only ever GAINS within a session (a model finishing
// download), never loses, so once known-available we freeze it and never remove
// it; while still unknown/unavailable we re-probe on later mounts (cheap now —
// the Rust side is cached and non-blocking) so a model that finishes downloading
// still appears. The `state` object reference is stable until a value actually
// changes, so `useSyncExternalStore` observers don't loop.

const NO_APPLE: ModelOption[] = [];

interface AppleState {
  apple: ModelOption[];
  ready: boolean;
}

let appleState: AppleState = { apple: NO_APPLE, ready: false };
let appleInflight = false;
const appleListeners = new Set<() => void>();

function subscribeApple(l: () => void): () => void {
  appleListeners.add(l);
  return () => {
    appleListeners.delete(l);
  };
}

/** Publish a new apple state, but only if a value actually changed — passing the
 * same `apple` reference on a still-unavailable re-probe is a no-op, so a probe
 * that resolves "unavailable again" never churns renders. Never downgrades a
 * known-available option list to empty. */
function publishApple(apple: ModelOption[], ready: boolean): void {
  if (appleState.apple === apple && appleState.ready === ready) return;
  appleState = { apple, ready };
  for (const l of appleListeners) l();
}

/** Kick a session-shared probe (deduped). Once available, the list is frozen. */
function refreshApple(): void {
  if (appleInflight || appleState.apple.length > 0) return;
  appleInflight = true;
  appleLlmStatus()
    .then((s) => {
      // Only ever add the option; a later "unavailable" never removes a
      // previously-available one (see invariants above).
      publishApple(s.available ? [appleModelOption] : appleState.apple, true);
    })
    .catch(() => publishApple(appleState.apple, true))
    .finally(() => {
      appleInflight = false;
    });
}

/** The shared Apple option list + a `ready` flag, resolved once per session. */
function useAppleModels(): AppleState {
  const state = useSyncExternalStore(
    subscribeApple,
    () => appleState,
    () => appleState,
  );
  useEffect(() => {
    // Re-probe on mount only while Apple isn't known available yet — never once
    // it is, so the option can't blink out from under a re-probe.
    if (state.apple.length === 0) refreshApple();
  }, [state.apple.length]);
  return state;
}

/** Cloud models plus any DOWNLOADED local models, and a `ready` flag that is
 * false until the first on-device status check resolves. Re-checks whenever a
 * background download finishes (`llm://complete`) so a newly-downloaded model
 * appears in every picker without a reload — regardless of which view was
 * mounted when the download completed. On iOS / when the check fails, it's just
 * the cloud list (and `ready` still flips true, so pickers stop waiting).
 *
 * The Apple option is resolved separately at module scope (see above) so it
 * stays visible across mounts and never flickers during a generation.
 *
 * `ready` is the fix for the default-model bug: a picker must NOT fall a
 * present local default back to Haiku while the async local-model list is
 * still resolving — only once `ready` is true and the model is confirmed
 * absent (see `useModelPicker`). */
export function useModelsState(): { models: ModelOption[]; ready: boolean } {
  const [local, setLocal] = useState<ModelOption[]>([]);
  const [localReady, setLocalReady] = useState(false);
  const { apple, ready: appleReady } = useAppleModels();
  const refresh = useCallback(() => {
    localLlmStatus(LOCAL_MODEL_CATALOG.map((s) => s.file))
      .then((list) => {
        const present = new Set(list.filter((s) => s.present).map((s) => s.file));
        setLocal(LOCAL_MODEL_CATALOG.filter((s) => present.has(s.file)).map(localModelOption));
      })
      .catch(() => setLocal([]))
      .finally(() => setLocalReady(true));
  }, []);
  useEffect(() => {
    refresh();
    let unlisten: (() => void) | undefined;
    onLlmComplete((p) => {
      if (p.ok) refresh();
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => unlisten?.();
  }, [refresh]);
  // `ready` gates the picker's default-model fallback, so it must wait for BOTH
  // on-device checks — otherwise a valid Apple/local selection could be reset
  // before its option has finished resolving.
  return { models: [...local, ...apple, ...MODELS], ready: localReady && appleReady };
}

/** Cloud + downloaded local models (see `useModelsState`). */
export function useAvailableModels(): ModelOption[] {
  return useModelsState().models;
}

/** A model picker's state that defaults to the user's chosen default (local
 * included) and only falls back to Haiku once the local-model list has
 * resolved AND a selected local model is confirmed absent. `initial` is read
 * once on mount (pass the surface's getter, e.g. `summaryModel`). */
export function useModelPicker(initial: () => string): {
  model: string;
  setModel: (id: string) => void;
  models: ModelOption[];
} {
  const { models, ready } = useModelsState();
  const [model, setModel] = useState(initial);
  useEffect(() => {
    // Only reset an on-device selection (local or Apple), only after both
    // checks resolved, and only when the model is genuinely missing — never on
    // a transient unresolved status, never for a valid present default, never
    // for cloud models.
    if (
      ready &&
      (isLocalModelId(model) || isAppleModelId(model)) &&
      !models.some((m) => m.id === model)
    ) {
      setModel(DEFAULT_MODEL);
    }
  }, [ready, model, models]);
  return { model, setModel, models };
}
