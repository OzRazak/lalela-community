import React from "react";
import { reportError } from "@/lib/errorReporting";

interface State {
  failed: boolean;
}

/** App-root error boundary: a render crash shows a calm recovery screen
 *  instead of a blank window, and (only if the person opted in) sends a
 *  content-free report via lib/errorReporting. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    reportError(error, { source: "react_error_boundary" });
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-8 text-foreground">
        <div className="max-w-md text-center">
          <h1 className="text-lg font-semibold">Something went wrong</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Lalela hit an unexpected error. Your meetings are safe — they're stored on this device.
            Reloading usually fixes it.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <button
              type="button"
              onClick={() => this.setState({ failed: false })}
              className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
            >
              Reload Lalela
            </button>
          </div>
        </div>
      </div>
    );
  }
}
