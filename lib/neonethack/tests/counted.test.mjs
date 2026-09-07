import {test} from 'node:test';
import {fixture} from './native-fixture.mjs';
import {countedContracts} from './counted-contracts.mjs';
countedContracts(test,'native',fixture);
