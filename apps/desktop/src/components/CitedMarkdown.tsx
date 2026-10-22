import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface CitedMarkdownProps {
  children: string;
  /** When set, [m:ss] timestamps render as links that seek the transcript. */
  onSeek?: (ms: number) => void;
  /**
   * Attribution mode for "Enhance my notes" (Wave A3). When true, any
   * paragraph or list-item that CONTAINS a [m:ss] citation renders muted
   * (gray) — that's AI-added content, which our prompt requires to carry a
   * citation. Lines WITHOUT a citation (the user's own verbatim notes) stay
   * normal foreground (black). Zero invented markup: the citation the model
   * already emits doubles as the black-vs-gray signal. Degrades gracefully —
   * if the model forgets a citation, that text just renders black.
   */
  aiMuted?: boolean;
}

// Non-global so `.test()` is stateless. Matches a bare [m:ss] / [mm:ss] stamp.
const CITATION_RE = /\[\d{1,3}:\d{2}\]/;

/** Does this node's OWN line contain a citation? Two shapes count: a seek link
 * (href `#t-…`, produced below when onSeek is set) or a bare `[m:ss]` text run
 * (when it isn't). Crucially, this does NOT descend into a nested list: a
 * user's verbatim bullet (no citation) may carry cited AI SUB-bullets beneath
 * it — those children are colored on their own `<li>` pass, so the parent must
 * stay black. Without this exclusion the whole parent bullet would gray out. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasOwnCitation(node: any): boolean {
  if (!node) return false;
  if (node.type === "text") return CITATION_RE.test(node.value ?? "");
  if (node.type === "element") {
    const href = node.properties?.href;
    if (typeof href === "string" && href.startsWith("#t-")) return true;
    if (node.tagName === "ul" || node.tagName === "ol") return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (node.children ?? []).some((c: any) => hasOwnCitation(c));
}

/** Markdown where bare [m:ss] citations (the format our prompts request)
 * become clickable links that jump the transcript to that moment. */
export function CitedMarkdown({ children, onSeek, aiMuted }: CitedMarkdownProps) {
  // [3:24] → [3:24](#t-204000); the (?!\() guard leaves real links alone.
  const linked = onSeek
    ? children.replace(
        /\[(\d{1,3}):(\d{2})\](?!\()/g,
        (_m, min: string, sec: string) => `[${min}:${sec}](#t-${(+min * 60 + +sec) * 1000})`,
      )
    : children;

  const components: Components = {
    a: ({ href, children: linkChildren, ...props }) => {
      if (onSeek && href?.startsWith("#t-")) {
        return (
          <button
            onClick={() => onSeek(Number(href.slice(3)))}
            title="Jump to this moment in the transcript"
            className="rounded bg-accent/15 px-1 font-mono text-[0.85em] text-accent hover:bg-accent/25"
          >
            {linkChildren}
          </button>
        );
      }
      return (
        <a href={href} {...props}>
          {linkChildren}
        </a>
      );
    },
  };

  // Attribution overrides are added ONLY in aiMuted mode, so summary/chat
  // rendering (the common case) is byte-identical to before.
  if (aiMuted) {
    components.p = ({ node, children: c }) => (
      <p className={hasOwnCitation(node) ? "text-muted-foreground" : undefined}>{c}</p>
    );
    components.li = ({ node, children: c }) => (
      <li className={hasOwnCitation(node) ? "text-muted-foreground" : undefined}>{c}</li>
    );
  }

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {linked}
    </ReactMarkdown>
  );
}
