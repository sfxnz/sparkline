import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ProblemState } from './ProblemState';

interface Props {
  children: ReactNode;
  /** What failed, for the message: "This panel", "Overview". */
  what?: string;
  compact?: boolean;
  /** Changing this value resets the boundary (e.g. the route path). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  resetKey: unknown;
}

/** Contains a render failure to its own region; the rest of the dashboard keeps working. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { resetKey: props.resetKey, error: null } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.what ?? 'panel'}] render failed`, error, info.componentStack);
  }

  private readonly retry = () => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ProblemState
        compact={this.props.compact}
        message={`${this.props.what ?? 'This panel'} couldn't be displayed`}
        cause={error.message || 'An unexpected error occurred while rendering.'}
        fix="Retry. If it keeps failing, reload the page; other panels are unaffected."
        onRetry={this.retry}
      />
    );
  }
}
