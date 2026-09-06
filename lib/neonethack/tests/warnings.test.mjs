import { fixture } from './native-fixture.mjs';
import { instrumentedNativeEngine } from './instrumented-native-engine.mjs';
import { ordinaryWarningContracts, controlledWarningContracts } from './warning-contracts.mjs';
ordinaryWarningContracts('native', fixture);
controlledWarningContracts('native', async t => fixture(t, { enginePath: await instrumentedNativeEngine(t, `${import.meta.dirname}/warning-decisions.inc`, 'warning_fixture_prepare') }));
