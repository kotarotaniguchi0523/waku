export const abortError = () =>
  new DOMException('Navigation aborted', 'AbortError');

export const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

/** For a promise whose rejection is reported somewhere else. */
export const ignoreRejection = (promise: Promise<unknown> | undefined) => {
  promise?.catch(() => {});
};

/** For a navigation whose outcome the router reports itself. */
export const ignoreResult = (result: NavigationResult) => {
  ignoreRejection(result.committed);
  ignoreRejection(result.finished);
};
