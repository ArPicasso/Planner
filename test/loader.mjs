// Resolves `sdk`, `sdk/db`, `sdk/api`, `sdk/fetch` to the local mock.
const MOCK = new URL('./mock-sdk.mjs', import.meta.url).href;
export async function resolve(specifier, context, next) {
  if (specifier === 'sdk' || specifier.startsWith('sdk/')) return { url: MOCK, shortCircuit: true };
  return next(specifier, context);
}
