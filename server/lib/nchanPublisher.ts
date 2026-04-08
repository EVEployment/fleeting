const NCHAN_PUB_BASE = process.env.NCHAN_PUB_URL ?? 'http://localhost/pub/fleet';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 200;

export async function publish(channelId: string, data: unknown): Promise<void> {
  const url = `${NCHAN_PUB_BASE}/${encodeURIComponent(channelId)}`;
  const body = JSON.stringify(data);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return;
      if (res.status >= 400 && res.status < 500) {
        console.warn(`[nchan] Publish to ${channelId} returned ${res.status} — not retrying`);
        return;
      }
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error(`[nchan] Publish to ${channelId} failed after ${MAX_RETRIES + 1} attempts:`, (err as Error).message);
        return;
      }
    }
    await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
  }
}
