import { isDatabaseNotReady } from "@/agent";

/**
 * Load page data, turning "database not set up" into a value the page can show (other errors still throw).
 * Keeps try/catch around data loading only, never around JSX.
 */
export async function loadPageData<T>(
  load: () => Promise<T>,
): Promise<{ ready: true; data: T } | { ready: false }> {
  try {
    return { ready: true, data: await load() };
  } catch (error) {
    if (isDatabaseNotReady(error)) return { ready: false };
    throw error;
  }
}
