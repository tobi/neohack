import {test} from 'node:test';
import {fixture} from './native-fixture.mjs';
import {agentContracts} from './agent-contracts.mjs';
agentContracts(test,'native',fixture);
