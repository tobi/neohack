// Pi resolves its own SDK when loading this explicit extension. Bun's launcher
// does not need a separately installed copy of Pi's dependencies.
import {createReadToolDefinition, createWriteToolDefinition} from '@mariozechner/pi-coding-agent';
import register from './run.mjs';

export default pi => register(pi, {createReadToolDefinition, createWriteToolDefinition});
