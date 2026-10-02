export function normalizeApp(app: string): string {
  return app.trim().toLowerCase();
}

export function isAllowedApp(app: string, whitelist: readonly string[]): boolean {
  const normalized = normalizeApp(app);
  return normalized.length > 0 && whitelist.some(item => normalizeApp(item) === normalized);
}
