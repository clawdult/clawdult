/**
 * Retry a function with exponential backoff for transient AWS errors.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; transientErrors?: string[] } = {}
): Promise<T> {
  const {
    maxRetries = 5,
    baseDelayMs = 1000,
    transientErrors = ['NoSuchEntityException', 'ThrottlingException'],
  } = options;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Error && transientErrors.includes(error.name)) {
        lastError = error;
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }

  throw lastError;
}
