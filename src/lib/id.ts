let counter = 0;

/** Small monotonic id generator — avoids a uuid dependency for local objects. */
export function nextId(prefix = 'm'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}
