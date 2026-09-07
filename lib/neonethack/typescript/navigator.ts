import {WorldError, type Game} from './client.js';
import type {Compass,Snapshot} from './types.js';
export interface NavigationOptions { maxActions?: number; signal?: AbortSignal; onStep?: (snapshot: Snapshot) => void }
export interface NavigationResult {
  reason: 'arrived' | 'attempted' | 'stepLimit' | 'decision' | 'interrupted' | 'changed' | 'noRoute' | 'ended' | 'aborted';
  actionsTaken: number;
  turnsElapsed: number;
  snapshot: Snapshot;
}
export type Point = {x:number;y:number};
export interface GoOptions extends NavigationOptions {to:Point;force?:boolean}
/** Opt in by constructing one for a Game. Planning stays in C; this executor
 * submits bounded named actions and never answers a standing decision. */
export class Navigator {
  private running = false;
  constructor(readonly game: Game) {}
  go(options:GoOptions):Promise<NavigationResult> {
    return options.force ? this.direct({...options.to},options) : this.run({...options.to},false,options);
  }
  private async direct(to:Point, options:NavigationOptions):Promise<NavigationResult> {
    if(options.maxActions!==undefined && (!Number.isInteger(options.maxActions) || options.maxActions<1 || options.maxActions>1659)) throw Error('maxActions must be an integer from 1 to 1659');
    if(this.running) throw Error('A navigation leg is already running');
    this.running=true;
    let actionsTaken=0, turnsElapsed=0;
    const result=(reason:NavigationResult['reason']):NavigationResult=>({reason,actionsTaken,turnsElapsed,snapshot:this.game.state});
    try {
      if(this.game.state.ended) return result('ended');
      if(this.game.decision) return result('decision');
      if(options.signal?.aborted) return result('aborted');
      const revision=this.game.state.revision;
      const query=await this.game.actions(to,{expectedRevision:revision});
      const move=query.cell.actions.find(a=>a.method==='game.move');
      if(query.cell.movement.relation!=='adjacent' || !move?.arguments || !('direction' in move.arguments))
        throw Error('Choose an adjacent square for a direct attempt; force does not mean force attack');
      if(options.signal?.aborted) return result('aborted');
      const frame=await this.game.move(move.arguments.direction!,{expectedRevision:revision});
      actionsTaken++; turnsElapsed += frame.outcome.turnsElapsed;
        options.onStep?.(frame);
      return result(frame.ended?'ended':frame.decision?'decision':frame.outcome.status==='completed'?(frame.observation.you?.x===to.x && frame.observation.you?.y===to.y?'arrived':'attempted'):'interrupted');
    } finally {this.running=false;}
  }
  explore(options:NavigationOptions = {}):Promise<NavigationResult> {
    return this.run('frontier', false, options);
  }
  descend(options:NavigationOptions = {}):Promise<NavigationResult> {
    return this.run('down', true, options);
  }
  private async run(destination:Point|'frontier'|'down', climb:boolean, options:NavigationOptions):Promise<NavigationResult> {
    const limit = options.maxActions ?? 1659;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1659) throw Error('maxActions must be an integer from 1 to 1659');
    if (this.running) throw Error('A navigation leg is already running');
    this.running = true;
    let actionsTaken = 0, turnsElapsed = 0;
    const result = (reason:NavigationResult['reason']):NavigationResult => ({reason,actionsTaken,turnsElapsed,snapshot:this.game.state});
    const gate = ():NavigationResult['reason']|undefined => this.game.state.ended ? 'ended' :
      this.game.decision ? 'decision' : options.signal?.aborted ? 'aborted' : undefined;
    const level = this.game.observation.location.id;
    try {
      const initial = gate(); if(initial) return result(initial);
      let to:Point, door:Compass|undefined;
      if(typeof destination==='string') {
        const nav = await this.game.navigation();
        const points = destination==='frontier' ? nav.frontiers : nav.waysDown;
        const chosen = points.filter(p=>p.distance!==null).sort((a,b)=>a.distance!-b.distance! || a.y-b.y || a.x-b.x)[0];
        if(chosen) to={x:chosen.x,y:chosen.y};
        else {
          const nextDoor=destination==='frontier' ? nav.doors.filter(d=>d.lock!=='locked' && d.distance!==null && d.approach && d.direction).sort((a,b)=>a.distance!-b.distance! || a.y-b.y || a.x-b.x)[0] : undefined;
          if(!nextDoor?.approach || !nextDoor.direction) return result('noRoute');
          to=nextDoor.approach; door=nextDoor.direction;
        }
      } else to=destination;
      while(true) {
        const stopped=gate(); if(stopped) return result(stopped);
        if(this.game.observation.location.id!==level) return result('changed');
        const revision=this.game.state.revision;
        const route=await this.game.route(to,{expectedRevision:revision});
        if(route.distance===null) return result('noRoute');
        if(route.distance===0 && !climb && !door) return result('arrived');
        if(actionsTaken>=limit) return result('stepLimit');
        if(options.signal?.aborted) return result('aborted');
        const next=route.steps[0];
        if(route.distance>0 && !next) throw Error('Route has no first step');
        const health=this.game.observation.vitals.health;
        const before=this.game.observation.world.filter(c=>c.occupant?.kind==='creature');
        const frame = route.distance===0
          ? door ? await this.game.open(door,{expectedRevision:revision}) : await this.game.climb('down',{expectedRevision:revision})
          : await this.game.move(next!.direction,{expectedRevision:revision});
        actionsTaken++; turnsElapsed += frame.outcome.turnsElapsed;
        options.onStep?.(frame);
        const after=gate(); if(after) return result(after);
        if(frame.outcome.status!=='completed') return result('interrupted');
        if(typeof health==='number' && typeof frame.observation.vitals.health==='number' && frame.observation.vitals.health<health) return result('changed');
        if(route.distance===0) {
          if(door) return result((await this.game.actions({direction:door})).cell.terrain?.type==='openDoor'?'arrived':'interrupted');
          return result(frame.observation.location.id!==level?'arrived':'interrupted');
        }
        if(frame.observation.location.id!==level) return result('changed');
        if(!frame.outcome.positionChanged) return result('interrupted');
        if(frame.observation.world.some(c=>c.occupant?.kind==='creature' && !before.some(p=>p.x===c.x && p.y===c.y && p.occupant?.appearance===c.occupant?.appearance))) return result('changed');
        if(actionsTaken>=limit) return result(!climb && !door && frame.observation.you?.x===to.x && frame.observation.you?.y===to.y ? 'arrived' : 'stepLimit');
      }
    } catch(error) {
      if(error instanceof WorldError && 'error' in error.response && error.response.error?.code==='staleRevision') return result('changed');
      throw error; // Missing receipts and uncertain execution are never retried here.
    } finally { this.running=false; }
  }
}
