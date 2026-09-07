import {test} from 'node:test';
import {fixture} from './native-fixture.mjs';
import {loreContracts} from './lore-contracts.mjs';
loreContracts(test,'native',fixture);
