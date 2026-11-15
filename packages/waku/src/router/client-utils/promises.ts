export const abortError = () =>
  new DOMException('Navigation aborted', 'AbortError');

export const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

/** For a promise whose rejection is reported somewhere else. */
export const ignoreRejection = (promise: Promise<unknown> | undefined) => {
  promise?.catch(() => {});
};
