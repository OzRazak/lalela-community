// Interactive click-through tours — lightweight, in-house (no external tour
// library). A tour is an ordered list of steps; each step optionally spotlights
// a real UI element (matched by its `data-tour-id`) and shows a tooltip card.
//
// Steps advance either when the user clicks the highlighted control
// (`advance: "click"` — used for nav that moves the user through the app) or
// via the tooltip's Next button (`advance: "next"`, the default — used when
// clicking the control would leave the tour, e.g. starting a recording).
//
// Elements are tagged across the touched views with `data-tour-id="…"`:
//   Sidebar     → new-recording, nav-<view> (nav-meetings, nav-chat, nav-knowledge, nav-automations, …), nav-settings
//   Top bar     → topbar-search (the persistent search field / ⌘K), notifications-bell
//   Meetings    → import-meeting
//   Automations → automations-library-tab, automations-rules-tab, automations-pending-tab, new-automation
// If a target isn't on screen yet (it mounts after navigation), the engine
// polls for it and falls back to a centred card until it appears.

// Amp reconciliation (Wave 7 Lalela Pass): lalela's in-house engine WAS the
// source of the shared <Tour> in @auxo/amp-primitives, so the data model now
// lives upstream and lalela consumes it. The step/advance shapes are the shared
// ones verbatim; lalela adds only one app-local concern the estate-neutral kit
// deliberately omits — a Lucide `Icon` for the Help-menu list.
import type { ComponentType } from "react";
import { Mic, MessagesSquare, Zap } from "lucide-react";
import type { TourModel, TourStep, TourAdvance } from "@auxo/amp-primitives";
import { chord } from "@/lib/platform";

/** Lucide icons render as SVG components; this is all the tour UI needs. */
type IconType = ComponentType<{ className?: string }>;

export type { TourStep, TourAdvance };

/** A lalela tour = the shared Amp tour model + a Help-menu icon + a required
 *  one-liner (the kit makes `description` optional; lalela always shows one). */
export type Tour = TourModel & {
  description: string;
  Icon: IconType;
};

const recordFirst: Tour = {
  id: "record-first",
  title: "Record your first meeting",
  description: "From hitting record to notes that write themselves.",
  Icon: Mic,
  steps: [
    {
      target: "new-recording",
      title: "Start a recording",
      body:
        "Every meeting begins here. Lalela records your microphone — and, if you allow it, your device's system audio — and transcribes on-device. No bot ever joins your call, and the audio is discarded after transcription.",
      advance: "next",
    },
    {
      target: "nav-meetings",
      title: "Where recordings live",
      body:
        "Finished meetings land in Meetings, newest first — each saved as plain Markdown on your device. Click Meetings to open the list.",
      advance: "click",
    },
    {
      target: "import-meeting",
      title: "Already have audio?",
      body:
        "Import an existing recording or transcript (m4a, mp3, DOCX, PDF, VTT and more) and Lalela treats it exactly like a live meeting — same titles, summaries and action items.",
      advance: "next",
    },
    {
      target: "nav-settings",
      title: "Make the notes automatic",
      body:
        "In Settings → New meetings, switch on auto-summaries and pick your AI — bring your own OpenRouter key, or download a local model and run everything offline. That's it: you're ready to record.",
      advance: "next",
    },
  ],
};

const findChat: Tour = {
  id: "find-chat",
  title: "Find & chat with a meeting",
  description: "Search transcripts and ask questions across everything.",
  Icon: MessagesSquare,
  steps: [
    {
      target: "topbar-search",
      title: "Search everything",
      body:
        `The search field at the top scans every title, transcript, summary and note with fast, on-device full-text search. Click it — or press ${chord("K")} from anywhere — and start typing; results update as you go and opening one jumps you straight to that meeting.`,
      advance: "next",
    },
    {
      target: "nav-chat",
      title: "Ask, don't scroll",
      body:
        "Chat answers questions grounded in your whole meeting history and cites [m:ss] timestamps you can click to jump the transcript. Click it to try.",
      advance: "click",
    },
    {
      target: "nav-knowledge",
      title: "Your knowledge, compiled",
      body:
        "One more: the Knowledge hub. Its Wiki auto-compiles pages on the people, projects and topics across your meetings — every fact links back to its source — and Reports run reflections over everything.",
      advance: "next",
    },
  ],
};

const automationsFirst: Tour = {
  id: "automations-first-rule",
  title: "Automate your meetings",
  description: "Tag meetings as they arrive and let Lalela do the busywork.",
  Icon: Zap,
  steps: [
    {
      target: "nav-automations",
      title: "What automations do",
      body:
        "Automations tag meetings the moment they arrive and run actions for you — file them into a folder, draft a summary, or send them onward. Click Automations to open it.",
      advance: "click",
    },
    {
      target: "automations-rules-tab",
      title: "Rules do the watching",
      body:
        "A rule watches every new meeting and, when one matches, runs its actions automatically — no clicking required. Click Rules to see them.",
      advance: "click",
    },
    {
      target: "new-automation",
      title: "Create your first rule",
      body:
        "Give it a trigger (a keyword, an attendee, a meeting source), pick a tag, then choose what happens. Hit New automation to build one.",
      advance: "next",
    },
    {
      target: "automations-pending-tab",
      title: "Nothing sends without your OK",
      body:
        "Set an action to ask first and it waits in Pending approvals for a click — so nothing ever leaves Lalela until you approve it.",
      advance: "next",
    },
    {
      target: "automations-library-tab",
      title: "Templates to reuse",
      body:
        "The Library is a shelf of reusable summary prompts and workflow templates you can drop into any rule.",
      advance: "next",
    },
  ],
};

export const TOURS: Tour[] = [recordFirst, findChat, automationsFirst];

export function getTourById(id: string): Tour | null {
  return TOURS.find((t) => t.id === id) ?? null;
}
