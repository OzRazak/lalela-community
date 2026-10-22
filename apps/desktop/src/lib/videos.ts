// Feature explainer videos, playable in-app via <VideoModal>.
// Hosted alongside releases in the public Supabase bucket so playback works
// without auth. To serve one from YouTube instead, set `youtubeId` — the
// modal then embeds the YouTube player instead of the hosted file.
import { IS_COMMUNITY } from "@/lib/edition";
import { SUPABASE_URL } from "@/lib/supabase";

export interface FeatureVideo {
  id: string;
  title: string;
  description: string;
  /** mm:ss, shown as a chip so people know the commitment. */
  duration: string;
  /** Direct-playable MP4 (public URL). */
  src: string;
  /** Optional YouTube video id; wins over `src` when set. */
  youtubeId?: string;
}

const VIDEO_BASE = `${SUPABASE_URL}/storage/v1/object/public/releases/lalela/videos`;

/** Hosted on Auxo's storage, so the Community edition ships none (and the
 *  Help menu's video list is simply empty there). */
export const FEATURE_VIDEOS: FeatureVideo[] = IS_COMMUNITY ? [] : [
  {
    id: "no-bot",
    title: "No bot joins your call",
    description: "How Lalela captures a meeting from your device — with no bot in the room.",
    duration: "0:51",
    src: `${VIDEO_BASE}/hero-nobot-explainer.mp4`,
  },
  {
    id: "on-device",
    title: "Nothing leaves your device",
    description: "On-device AI: your transcript and summaries never touch the internet.",
    duration: "0:41",
    src: `${VIDEO_BASE}/ondevice-proof-explainer.mp4`,
  },
  {
    id: "automations",
    title: "Automations in 90 seconds",
    description: "Rules that tag, file and summarise meetings for you — with your approval.",
    duration: "1:31",
    src: `${VIDEO_BASE}/automations-explainer.mp4`,
  },
  {
    id: "meeting-to-crm",
    title: "Meeting to CRM in one click",
    description: "Send a call's summary and next steps to your CRM — nothing sent without approval.",
    duration: "0:28",
    src: `${VIDEO_BASE}/meeting-to-crm-explainer.mp4`,
  },
];

export function getVideoById(id: string): FeatureVideo | undefined {
  return FEATURE_VIDEOS.find((v) => v.id === id);
}
