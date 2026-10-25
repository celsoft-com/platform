// Versions before the `--` names proved ownership with these; they are read only to clean up
// what those versions left, and go away in the next major.
export const LEGACY_PLATFORM_TAG = "celsoft-platform";
export const LEGACY_BUCKET_MARKER = ".celsoft-platform";
export const LEGACY_DNS_COMMENT = "managed by @celsoft/platform";

export const legacyNames = (app: string) => ({
  preview: (pr: number) => `${app}-pr-${pr}`,
  previewPattern: new RegExp(`^${app}-pr-(\\d+)$`),
  previewPrefix: `${app}-pr-`,
  filesBucket: `${app}-files`,
  previewsBucket: `${app}-previews`,
});
