import {WorldError, type Game} from './client.js';
import type {Compass,RouteWhy,Snapshot} from './types.js';
export interface NavigationOptions { maxActions?: number; signal?: AbortSignal; onStep?: (snapshot: Snapshot) => void; stopOnNewCreatures?: boolean }
export interface ExploreOptions extends NavigationOptions { maxFrontiers?: number }
const routeHints: Record<RouteWhy, string> = {
  targetOccupied: 'Attack the occupant if adjacent; go does not fight.',
  targetUnknown: 'Inspect or step adjacent; knownWalking does not guess unmapped tiles.',
  closedDoor: 'Open the door, or explore toward it. go does not open doors.',
  disconnected: 'No reachable unvisited frontier or closed door. Search, or walk to a remembered edge and step into the dark.',
};
const CARDINAL = [[0,-1],[1,0],[0,1],[-1,0]] as const;
function unknownNeighbor(game:Game,x:number,y:number):Point|undefined {
  const known=new Map(game.observation.world.map(cell=>[`${cell.x},${cell.y}`,cell]));
  for (const [dx,dy] of CARDINAL) {
    const nx=x+dx, ny=y+dy;
    if (nx<1||nx>79||ny<0||ny>20) continue;
    const cell=known.get(`${nx},${ny}`);
    if (!cell || cell.terrain.type==='unknown' || cell.terrain.type==='dark') return {x:nx,y:ny};
  }
}
export interface NavigationResult {
  reason: 'arrived' | 'attempted' | 'stepLimit' | 'decision' | 'interrupted' | 'changed' | 'noRoute' | 'ended' | 'aborted' | 'error';
  actionsTaken: number;
  turnsElapsed: number;
  snapshot: Snapshot;
  why?: RouteWhy;
  hint?: string;
  lastOperationId?: string;
  recover?: string;
}
/** A failed substep does not undo earlier inputs in the same navigation call. */
export class NavigationError extends Error {
  constructor(readonly result: NavigationResult, cause: unknown) {
    super(`Navigation stopped after ${result.actionsTaken} actions and ${result.turnsElapsed} turns. Substep error: ${cause instanceof Error ? cause.message : String(cause)}`, {cause});
    this.name = 'NavigationError';
  }
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
    let accountedTurn=this.game.observation.turn;
    const result=(reason:NavigationResult['reason'], extra: Pick<NavigationResult,'why'|'hint'> = {}):NavigationResult=>{
      const lastOperationId = (actionsTaken > 0 && reason !== 'arrived' && reason !== 'ended') ? this.game.state.requestId ?? undefined : undefined;
      const recover = lastOperationId ? 'Call recover; do not resubmit this navigation leg.' : undefined;
      return {reason,actionsTaken,turnsElapsed,snapshot:this.game.state,...extra,...(lastOperationId?{lastOperationId}:{}),...(recover?{recover}:{})};
    };
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
      accountedTurn=frame.observation.turn;
        options.onStep?.(frame);
      return result(frame.ended?'ended':frame.decision?'decision':frame.outcome.status==='completed'?(frame.observation.you?.x===to.x && frame.observation.you?.y===to.y?'arrived':'attempted'):'interrupted');
    } catch(error) {
      const elapsed=this.game.observation.turn-accountedTurn;
      if(elapsed>0){actionsTaken++;turnsElapsed+=elapsed;}
      throw new NavigationError(result('error'),error);
    }
    finally {this.running=false;}
  }
  explore(options:ExploreOptions = {}):Promise<NavigationResult> {
    return this.run('frontier', false, options);
  }
  descend(options:NavigationOptions = {}):Promise<NavigationResult> {
    return this.run('down', true, options);
  }
  private async run(destination:Point|'frontier'|'down', climb:boolean, options:ExploreOptions):Promise<NavigationResult> {
    const limit = options.maxActions ?? 1659;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1659) throw Error('maxActions must be an integer from 1 to 1659');
    const frontierLimit = options.maxFrontiers ?? 1;
    if (!Number.isInteger(frontierLimit) || frontierLimit < 1 || frontierLimit > 1659) throw Error('maxFrontiers must be an integer from 1 to 1659');
    if (this.running) throw Error('A navigation leg is already running');
    this.running = true;
    let actionsTaken = 0, turnsElapsed = 0;
    let accountedTurn=this.game.observation.turn;
    const result = (reason:NavigationResult['reason'], extra: Pick<NavigationResult,'why'|'hint'> = {}):NavigationResult => {
      const lastOperationId = (actionsTaken > 0 && reason !== 'arrived' && reason !== 'ended') ? this.game.state.requestId ?? undefined : undefined;
      const recover = lastOperationId ? 'Call recover; do not resubmit this navigation leg.' : undefined;
      return {reason,actionsTaken,turnsElapsed,snapshot:this.game.state,...extra,...(lastOperationId?{lastOperationId}:{}),...(recover?{recover}:{})};
    };
    const gate = ():NavigationResult['reason']|undefined => this.game.state.ended ? 'ended' :
      this.game.decision ? 'decision' : options.signal?.aborted ? 'aborted' : undefined;
    const level = this.game.observation.location.id;
    try {
      const initial = gate(); if(initial) return result(initial);
      let to:Point, door:Compass|undefined, probe:Point|undefined, edge=false, frontiersReached=0;
      const noticeCreatures=options.stopOnNewCreatures!==false;
      const choose = async ():Promise<boolean> => {
        door=undefined; probe=undefined; edge=false;
        if(typeof destination!=='string') {to=destination;return true;}
        const nav = await this.game.navigation();
        const points = destination==='frontier' ? nav.frontiers : nav.waysDown;
        const chosen = points.filter(p=>p.distance!==null).sort((a,b)=>a.distance!-b.distance! || a.y-b.y || a.x-b.x)[0];
        if(chosen) to={x:chosen.x,y:chosen.y};
        else {
          const nextDoor=destination==='frontier' ? nav.doors.filter(d=>d.lock!=='locked' && d.distance!==null && d.approach && d.direction).sort((a,b)=>a.distance!-b.distance! || a.y-b.y || a.x-b.x)[0] : undefined;
          if(nextDoor?.approach && nextDoor.direction) { to=nextDoor.approach; door=nextDoor.direction; }
          else if(destination==='frontier') {
            const you=this.game.observation.you;
            if(!you) return false;
            const here=unknownNeighbor(this.game,you.x,you.y);
            if(here) { to=here; probe=here; return true; }
            let best:Point|undefined, bestDistance=Infinity;
            for (const cell of this.game.observation.world) {
              if(!unknownNeighbor(this.game,cell.x,cell.y)) continue;
              const route=await this.game.route({x:cell.x,y:cell.y},{expectedRevision:this.game.state.revision});
              if(route.distance===null || route.distance>=bestDistance) continue;
              bestDistance=route.distance; best={x:cell.x,y:cell.y};
            }
            if(!best) return false;
            to=best; edge=true;
          } else return false;
        }
        return true;
      };
      if(!await choose()) return result('noRoute',{why:'disconnected',hint:routeHints.disconnected});
      while(true) {
        const stopped=gate(); if(stopped) return result(stopped);
        if(this.game.observation.location.id!==level) return result('changed');
        const revision=this.game.state.revision;
        if(probe) {
          const query=await this.game.actions(probe,{expectedRevision:revision});
          const move=query.cell.actions.find(a=>a.method==='game.move');
          if(query.cell.movement.relation!=='adjacent' || !move?.arguments || !('direction' in move.arguments))
            return result('noRoute',{why:'targetUnknown',hint:routeHints.targetUnknown});
          if(actionsTaken>=limit) return result('stepLimit');
          const frame=await this.game.move(move.arguments.direction!,{expectedRevision:revision});
          actionsTaken++; turnsElapsed += frame.outcome.turnsElapsed;
          accountedTurn=frame.observation.turn;
          options.onStep?.(frame);
          return result(frame.ended?'ended':frame.decision?'decision':frame.outcome.status==='completed'?'attempted':'interrupted');
        }
        const route=await this.game.route(to!,{expectedRevision:revision});
        if(route.distance===null) {
          const why=route.why??'disconnected';
          return result('noRoute',{why,hint:routeHints[why]});
        }
        if(route.distance===0 && !climb && !door) {
          const you=this.game.observation.you;
          const nextUnknown=you?unknownNeighbor(this.game,you.x,you.y):undefined;
          if(edge && nextUnknown) { to=nextUnknown; probe=nextUnknown; edge=false; continue; }
          if(destination!=='frontier' || ++frontiersReached>=frontierLimit) return result('arrived');
          if(actionsTaken>=limit) return result('stepLimit');
          if(!await choose()) return result('noRoute',{why:'disconnected',hint:routeHints.disconnected});
          continue;
        }
        if(actionsTaken>=limit) return result('stepLimit');
        if(options.signal?.aborted) return result('aborted');
        const next=route.steps[0];
        if(route.distance>0 && !next) throw Error('Route has no first step');
        const health=this.game.observation.vitals.health;
        const condition=JSON.stringify(this.game.observation.vitals.condition),hunger=this.game.observation.vitals.hunger;
        const before=this.game.observation.world.filter(c=>c.occupant?.kind==='creature');
        const frame = route.distance===0
          ? door ? await this.game.open(door,{expectedRevision:revision}) : await this.game.climb('down',{expectedRevision:revision})
          : await this.game.move(next!.direction,{expectedRevision:revision});
        actionsTaken++; turnsElapsed += frame.outcome.turnsElapsed;
        accountedTurn=frame.observation.turn;
        options.onStep?.(frame);
        const after=gate(); if(after) return result(after);
        if(frame.outcome.status!=='completed') return result('interrupted');
        if(typeof health==='number' && typeof frame.observation.vitals.health==='number' && frame.observation.vitals.health<health) return result('changed');
        if(JSON.stringify(frame.observation.vitals.condition)!==condition || frame.observation.vitals.hunger!==hunger) return result('changed');
        if(route.distance===0) {
          if(door) return result((await this.game.actions({direction:door})).cell.terrain?.type==='openDoor'?'arrived':'interrupted');
          return result(frame.observation.location.id!==level?'arrived':'interrupted');
        }
        if(frame.observation.location.id!==level) return result('changed');
        if(!frame.outcome.positionChanged) return result('interrupted');
        if(noticeCreatures && frame.observation.world.some(c=>c.occupant?.kind==='creature' && !before.some(p=>p.x===c.x && p.y===c.y && p.occupant?.appearance===c.occupant?.appearance))) return result('changed',{hint:'A creature is now perceived.'});
        if(actionsTaken>=limit) return result(!climb && !door && (destination!=='frontier' || frontiersReached+1>=frontierLimit) && frame.observation.you?.x===to!.x && frame.observation.you?.y===to!.y ? 'arrived' : 'stepLimit');
      }
    } catch(error) {
      const elapsed=this.game.observation.turn-accountedTurn;
      if(elapsed>0){actionsTaken++;turnsElapsed+=elapsed;}
      if(error instanceof WorldError && 'error' in error.response && error.response.error?.code==='staleRevision') return result('changed');
      throw new NavigationError(result('error'),error); // Never retry missing or uncertain receipts here.
    } finally { this.running=false; }
  }
}
