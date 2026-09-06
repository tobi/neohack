import {fixture} from './native-fixture.mjs';
import {instrumentedNativeEngine} from './instrumented-native-engine.mjs';
import {textDecisionContracts} from './text-decision-contracts.mjs';
textDecisionContracts('native', async t => fixture(t, {enginePath:await instrumentedNativeEngine(t, `${import.meta.dirname}/text-decisions.inc`, 'text_fixture_prepare')}));
