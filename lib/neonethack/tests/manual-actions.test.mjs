import {test} from 'node:test';
import {fixture} from './native-fixture.mjs';
import {manualActionsContracts} from './manual-actions-contracts.mjs';
manualActionsContracts(test,fixture,'native');
