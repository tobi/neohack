// Test-only clock injection, inherited by Node engine/core workers via --import.
// The engine still executes its real C calendar rules. No monotonic timers or
// game observations are fabricated.
import { readFileSync } from 'node:fs';
if (!process.env.NNH_TEST_CLOCK) throw Error('Clock fixture requires its own control file');
Date.now = () => Number(readFileSync(process.env.NNH_TEST_CLOCK, 'utf8')) * 1000;
