export function requiredValue<T>(
  value: T | null | undefined,
  message = 'Expected fixture value',
): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}
