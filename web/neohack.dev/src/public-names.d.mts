export type NameCorrection = { original: string; name: string };
export function displayText(text: unknown, correction?: NameCorrection): string;
export function displayDocument<T>(value: T, correction?: NameCorrection): T;
