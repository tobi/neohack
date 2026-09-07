import {test} from 'node:test';
import {fixture} from './native-fixture.mjs';
import {routeContracts} from './route-contracts.mjs';
routeContracts(test,'native',fixture);
