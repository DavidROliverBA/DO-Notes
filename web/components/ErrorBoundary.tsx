// Wraps the main view in App. A render crash shows a message and "Try again" in place of the
// screen, while the sidebar and panels keep working; moving to another page (resetKey) clears it.

import { Component, type ReactNode } from "react";

/** Last line of defence: a crash in one view shows a message instead of a blank app. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: unknown }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty-state" role="alert">
        <p>This page couldn't be shown: DO Notes hit a fault while drawing it.</p>
        <p className="muted small">Try again, or open another note from the sidebar. If it keeps happening, reload the page.</p>
        <p className="muted small">Details: {this.state.error.message}</p>
        <div className="row">
          <button className="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button onClick={() => location.reload()}>Reload the page</button>
        </div>
      </div>
    );
  }
}
