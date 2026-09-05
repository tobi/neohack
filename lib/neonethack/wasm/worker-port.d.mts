export const inNode: boolean;
export function send(message: unknown): void;
export function listen(callback: (message: any) => void): void;
export interface WorkerPort { post(message: unknown): void; stop(): void | Promise<number> }
export function worker(url: URL, onMessage: (message: any) => void, onError: (error: Error) => void): WorkerPort;
