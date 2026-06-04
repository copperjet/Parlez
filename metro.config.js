// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// @supabase/supabase-js >=2.106 ships an ESM entry (dist/index.mjs) whose lazy
// `import(/* @vite-ignore */ OTEL_PKG)` for optional OpenTelemetry uses a
// computed specifier that Hermes cannot parse ("Invalid expression"), which
// breaks release bundling (`createBundleReleaseJsAndAssets`). Its CJS build
// (dist/index.cjs) loads the same optional dep via `require()`, which is
// Hermes-safe. Force supabase-js to resolve through the "require" export
// condition so the CJS variant is bundled.
const supabaseCjs = require.resolve('@supabase/supabase-js/dist/index.cjs');
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === '@supabase/supabase-js') {
    return { type: 'sourceFile', filePath: supabaseCjs };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
