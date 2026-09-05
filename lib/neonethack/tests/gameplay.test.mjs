import { doorOrientationContracts } from './door-orientation-contracts.mjs';
import { fixture } from './native-fixture.mjs';
import { gameplayContracts } from './gameplay-contracts.mjs';
import { interruptionContracts } from './interruption-contracts.mjs';
import { decisionContracts } from './decision-contracts.mjs';
const native = async t => {
  const backend = await fixture(t);
  backend.restart = async game => {
    await backend.transport.close();
    const next = await fixture(t, { sessions: backend.sessions });
    backend.transport = next.transport; backend.api = next.api;
    return backend.api.resume(game.id);
  };
  return backend;
};
gameplayContracts('native', native);
interruptionContracts('native', native);
decisionContracts('native', native);

doorOrientationContracts('native', native);
