import { X } from "lucide-react";
import type { FeatureVideo } from "@/lib/videos";

interface VideoModalProps {
  video: FeatureVideo;
  onClose: () => void;
}

/** Full-screen dimmed overlay playing a feature explainer video. Click
 * outside or the X to dismiss. YouTube-backed videos embed the YT player;
 * hosted videos use the native <video> element (works offline-cached too). */
export function VideoModal({ video, onClose }: VideoModalProps) {
  return (
    <div
      className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl overflow-hidden rounded-[var(--radius)] border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold">{video.title}</h2>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {video.duration}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="aspect-video w-full bg-black">
          {video.youtubeId ? (
            <iframe
              className="h-full w-full"
              src={`https://www.youtube-nocookie.com/embed/${video.youtubeId}?autoplay=1&rel=0`}
              title={video.title}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <video className="h-full w-full" src={video.src} controls autoPlay />
          )}
        </div>
      </div>
    </div>
  );
}
