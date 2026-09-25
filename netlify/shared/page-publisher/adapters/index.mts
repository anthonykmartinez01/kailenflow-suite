// Adapter registry — platform -> adapter instance. GIT_STATIC and MANUAL are
// implemented (page-publisher-build-spec.md §9, revised priority
// 2026-07-23: MANUAL moved ahead of Wix for a real GoDaddy client). Wix/
// WordPress not built yet, added here once they exist.
import type { Platform, PlatformAdapter } from "./base-adapter.mts";
import { gitStaticAdapter } from "./git-static-adapter.mts";
import { manualAdapter } from "./manual-adapter.mts";

const registry: Partial<Record<Platform, PlatformAdapter>> = {
  git_static: gitStaticAdapter,
  manual: manualAdapter,
};

export function getAdapter(platform: Platform): PlatformAdapter {
  const adapter = registry[platform];
  if (!adapter) throw new Error(`No adapter registered for platform "${platform}" yet`);
  return adapter;
}

export * from "./base-adapter.mts";
export { gitStaticAdapter, gitStaticCapabilities } from "./git-static-adapter.mts";
export { manualAdapter, manualCapabilities } from "./manual-adapter.mts";
