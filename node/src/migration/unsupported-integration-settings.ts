const unsupportedSettingNames = new Set([
  "sub2api_config",
  "cliproxyapi_config",
  "cpa_config",
]);

export function isUnsupportedIntegrationSetting(key: string): boolean {
  return unsupportedSettingNames.has(key.trim().toLowerCase());
}

export function supportedSettings(settings: Readonly<Record<string, unknown>>): {
  readonly accepted: Record<string, unknown>;
  readonly skipped: number;
} {
  const accepted: Record<string, unknown> = {};
  let skipped = 0;
  for (const [key, value] of Object.entries(settings)) {
    if (isUnsupportedIntegrationSetting(key)) {
      skipped += 1;
      continue;
    }
    accepted[key] = value;
  }
  return { accepted, skipped };
}
