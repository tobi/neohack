import {fixture} from './native-fixture.mjs';
import {positionContracts} from './position-contracts.mjs';
positionContracts('native', async t => {
  const b=await fixture(t);
  b.restart=async game=>{
    await game.close(); await b.transport.close();
    const resumed=await fixture(t,{sessions:b.sessions});
    return {...resumed,game:await resumed.api.resume(game.id)};
  };
  return b;
});
