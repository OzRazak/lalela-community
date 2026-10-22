/* Amp kit · primitives · v0.2.1 · source: OzRazak/auxo-amp · do not hand-edit — re-run scripts/add.mjs to update */
// @auxo/amp-primitives — Tour data model.
//
// Generalized from lalela's in-house engine (apps/desktop/src/lib/tours.ts),
// the estate's working precedent. Estate-neutral: no lucide `Icon` requirement,
// no app imports. A tour is an ordered list of steps; each step optionally
// spotlights a real element (matched by its `data-tour-id`) and shows a card.
// Steps advance via the card's Next button (`advance: "next"`, default) or when
// the user clicks the spotlighted control (`advance: "click"` — used for nav).

export type TourAdvance = "next" | "click";

export interface TourStep {
  /** `data-tour-id` of the element to spotlight. Omit for a centred card. */
  target?: string;
  title: string;
  body: string;
  /** How this step advances. Default "next". */
  advance?: TourAdvance;
}

export interface Tour {
  id: string;
  /** Short label for the card header / Help menu. */
  title: string;
  /** One-liner describing the tour. */
  description?: string;
  steps: TourStep[];
}

export function getTourById(tours: Tour[], id: string): Tour | null {
  return tours.find((t) => t.id === id) ?? null;
}
