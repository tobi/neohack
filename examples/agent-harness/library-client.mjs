import {Game} from '../../lib/neonethack/dist/typescript/client.js';

/** Bind the snapshot-based reference policy directly to the public library.
 * Low operation arguments remain unchanged. Only bounded navigation is a
 * library convenience, executed by the shared navigator over the same Game.
 * The snapshot client's durable reservation precedes this callback. */
export function librarySender(api) {
  return async ({name,arguments:args},{snapshot,reservationId}) => {
    if(name==='observe')return api.request('session.observe',args);
    if(['go','explore','descend'].includes(name)) {
      let index=0;
      const game=new Game(api,snapshot,()=>`${reservationId}:${++index}`);
      const {sessionId,...options}=args;
      if(sessionId!==game.id)throw new Error('Wrong navigation session.');
      const {snapshot:result,...navigation}=await game[name](options);
      return {...result,navigation};
    }
    return api.request(`${['answer','cancel'].includes(name)?'decision':'game'}.${name}`,
      {...args,expectedRevision:snapshot.revision,requestId:reservationId});
  };
}
