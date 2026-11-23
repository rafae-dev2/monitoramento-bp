export function getRuntimeEnv(name, fallback = '') {
  const runtime = globalThis.Netlify;
  if (runtime && runtime.env && typeof runtime.env.get === 'function') {
    const value = runtime.env.get(name);
    if (value != null && String(value) !== '') return String(value);
  }
  if (typeof process !== 'undefined' && process.env && process.env[name] != null) {
    const value = String(process.env[name]);
    if (value !== '') return value;
  }
  return fallback;
}

export function readRuntimeEnv(names) {
  return Object.fromEntries(names.map((name) => [name, getRuntimeEnv(name)]));
}
