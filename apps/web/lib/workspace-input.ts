export class InputError extends Error {}

export function text(value: unknown, field: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.trim().length > maximum || (!allowEmpty && !value.trim())) {
    throw new InputError(`${field} must contain ${allowEmpty ? "0" : "1"}–${maximum} characters`);
  }
  return value.trim();
}

export function entityId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new InputError("A valid record ID is required");
  }
  return value;
}

export function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new InputError(`Value must be a whole number between 1 and ${maximum}`);
  }
  return value;
}
