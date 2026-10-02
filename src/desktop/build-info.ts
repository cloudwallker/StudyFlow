declare const __STUDYFLOW_BUILD__: { test: boolean; version: string; id: string };
export const buildInfo = typeof __STUDYFLOW_BUILD__ === 'undefined'
  ? { test: false, version: '0.2.0-m3-dev', id: 'development' }
  : __STUDYFLOW_BUILD__;
