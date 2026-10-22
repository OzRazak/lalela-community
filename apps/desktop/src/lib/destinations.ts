// Send destinations (automations "Send to", workflow send blocks, pending
// approvals). Sends go through Lalela's hosted connectors, so they exist only
// in the official edition; the Community edition hides every send surface.
//
// The product-hub destination's display name is a partner brand, so it comes
// from the official build env (VITE_PRODUCT_HQ_LABEL, edition/official.env)
// rather than living in source; the stable id "arete" is unchanged.

import { IS_COMMUNITY } from "@/lib/edition";

/** True when this build can send meetings to connected destinations. */
export const SENDS_AVAILABLE: boolean = !IS_COMMUNITY;

export const PRODUCT_HQ_LABEL: string =
  import.meta.env?.VITE_PRODUCT_HQ_LABEL?.trim() || "Product HQ";

/** Destination id → short label (badges, confirm prompts). */
export const DESTINATION_LABEL: Record<string, string> = {
  artemis: "Fikelela CRM",
  atlas: "Atlas Delivery",
  atlas_pack: "Atlas (proposed actions)",
  arete: PRODUCT_HQ_LABEL,
  artemis_lead_flow: "Fikelela CRM (create lead)",
};
