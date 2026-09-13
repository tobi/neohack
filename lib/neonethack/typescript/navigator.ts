import {WorldError, type Game} from './client.js';
import type {CellActions,Compass,RouteWhy,Snapshot} from './types.js';
export interface NavigationOptions { maxActions?: number; signal?: AbortSignal; onStep?: (snapshot: Snapshot) => void; stopOnNewCreatures?: boolean }
export interface ExploreOptions extends NavigationOptions { maxFrontiers?: number }
const routeHints: Record<RouteWhy, string> = {
  targetOccupied: 'A hostile or peaceful creature occupies the square; routes only displace tame allies. Inspect its occupant or go to a free square beside it.',
  targetUnknown: 'Inspect or step adjacent; knownWalking does not guess unmapped tiles.',
  closedDoor: 'Open the door, or explore toward it. go does not open doors.',
  disconnected: 'No reachable unvisited frontier or closed door. Search, or walk to a remembered edge and step into the dark.',
};
const NEIGHBORS = [[0,-1],[1,0],[0,1],[-1,0],[1,-1],[1,1],[-1,1],[-1,-1]] as const;
function unknownNeighbors(game:Game,x:number,y:number):Point[] {
  const result:Point[]=[];
  const known=new Map(game.observation.world.map(cell=>[`${cell.x},${cell.y}`,cell]));
  for (const [dx,dy] of NEIGHBORS) {
    const nx=x+dx, ny=y+dy;
    if (nx<1||nx>79||ny<0||ny>20) continue;
    const cell=known.get(`${nx},${ny}`);
    if (!cell || cell.terrain.type==='unknown' || cell.terrain.type==='dark') result.push({x:nx,y:ny});
  }
  return result;
}
/** Exploration policy uses C restrictions; a single go({direction}) step remains an attempt. */
function probeOffer(cell:CellActions) {
  if(cell.movement.relation!=='adjacent'||cell.movement.knownRestriction||cell.movement.requiresSqueeze||cell.hazards?.length||cell.occupant||!['unknown','step'].includes(cell.movement.intent??'unknown'))return;
  const offer=cell.actions.find(a=>a.method==='game.move');
  if(offer?.arguments)return offer;
}
async function perceivedProbe(game:Game):Promise<Point|undefined> {
  const you=game.observation.you;
  if(!you)return;
  for(const point of unknownNeighbors(game,you.x,you.y)) {
    const query=await game.actions(point,{expectedRevision:game.state.revision});
    if(probeOffer(query.cell))return point;
  }
}
export interface NavigationStop {
  kind: 'healthLost' | 'hungerChanged' | 'conditionChanged' | 'levelChanged' | 'creaturePerceived' | 'positionUnchanged' | 'staleRevision';
  before?: unknown;
  after?: unknown;
}
export interface NavigationResult {
  reason: 'arrived' | 'attempted' | 'stepLimit' | 'decision' | 'interrupted' | 'changed' | 'noRoute' | 'ended' | 'aborted' | 'error';
  actionsTaken: number;
  turnsElapsed: number;
  snapshot: Snapshot;
  stop?: NavigationStop;
  why?: RouteWhy;
  hint?: string;
  lastOperationId?: string;
}
/** A failed substep does not undo earlier inputs in the same navigation call. */
export class NavigationError extends Error {
  constructor(readonly result: NavigationResult, cause: unknown) {
    super(`Navigation stopped after ${result.actionsTaken} actions and ${result.turnsElapsed} turns. Substep error: ${cause instanceof Error ? cause.message : String(cause)}`, {cause});
    this.name = 'NavigationError';
  }
}
export type Point = {x:number;y:number};
/** go({to}) walks a routed leg; go({direction}) takes one ordinary step. */
export type GoOptions = NavigationOptions & ({to:Point;direction?:undefined} | {direction:Compass;to?:undefined});
export const compassOffsets:Record<Compass,readonly [number,number]> = {
  north:[0,-1], northeast:[1,-1], east:[1,0], southeast:[1,1], south:[0,1], southwest:[-1,1], west:[-1,0], northwest:[-1,-1],
};
/** Opt in by constructing one for a Game. Planning stays in C; this executor
 * submits bounded named actions and never answers a standing decision. */
export class Navigator {
  private running = false;
  constructor(readonly game: Game) {}
  go(options:GoOptions):Promise<NavigationResult> {
    if((options.to===undefined)===(options.direction===undefined)) throw Error('go takes exactly one of to (a routed leg) or direction (one step)');
    return options.direction!==undefined ? this.step(options.direction,options) : this.run({...options.to!},false,options);
  }
  /** One ordinary engine move: door bumps, boulder pushes and ally swaps happen
   * under engine rules. A square displaying a creature is refused before any
   * input; attacking is the separate attack operation. */
  private async step(direction:Compass, options:NavigationOptions):Promise<NavigationResult> {
    const offset=compassOffsets[direction];
    if(!offset) throw Error('direction must be a compass direction');
    if(this.running) throw Error('A navigation leg is already running');
    this.running=true;
    let actionsTaken=0, turnsElapsed=0;
    let accountedTurn=this.game.observation.turn;
    const result=(reason:NavigationResult['reason'], extra: Pick<NavigationResult,'why'|'hint'|'stop'> = {}):NavigationResult=>{
      const lastOperationId = (actionsTaken > 0 && reason !== 'arrived' && reason !== 'ended') ? this.game.state.requestId ?? undefined : undefined;
      return {reason,actionsTaken,turnsElapsed,snapshot:this.game.state,...extra,...(lastOperationId?{lastOperationId}:{})};
    };
    try {
      if(this.game.state.ended) return result('ended');
      if(this.game.decision) return result('decision');
      if(options.signal?.aborted) return result('aborted');
      const revision=this.game.state.revision;
      const you=this.game.observation.you;
      if(!you) throw Error('Your position is unknown; a single step needs a perceived position');
      const to:Point={x:you.x+offset[0],y:you.y+offset[1]};
      const query=await this.game.actions({direction},{expectedRevision:revision});
      if(query.cell.occupant && query.cell.occupant.kind!=='self' && query.cell.occupant.kind!=='ally')
        throw Error(`A creature is displayed ${direction}; go never attacks. Use attack for a deliberate attack.`);
      const move=query.cell.actions.find(a=>a.method==='game.move');
      if(!query.cell.inBounds || !move?.arguments || !('direction' in move.arguments))
        throw Error(`No ordinary movement is offered ${direction}`);
      if(options.signal?.aborted) return result('aborted');
      const frame=await this.game.move(direction,{expectedRevision:revision});
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
    const result = (reason:NavigationResult['reason'], extra: Pick<NavigationResult,'why'|'hint'|'stop'> = {}):NavigationResult => {
      const lastOperationId = (actionsTaken > 0 && reason !== 'arrived' && reason !== 'ended') ? this.game.state.requestId ?? undefined : undefined;
      return {reason,actionsTaken,turnsElapsed,snapshot:this.game.state,...extra,...(lastOperationId?{lastOperationId}:{})};
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
            const here=await perceivedProbe(this.game);
            if(here) { to=here; probe=here; return true; }
            let best:Point|undefined, bestDistance=Infinity;
            for (const cell of this.game.observation.world) {
              if(!unknownNeighbors(this.game,cell.x,cell.y).length) continue;
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
        if(this.game.observation.location.id!==level) return result('changed',{stop:{kind:'levelChanged',before:level,after:this.game.observation.location.id}});
        const revision=this.game.state.revision;
        if(probe) {
          const query=await this.game.actions(probe,{expectedRevision:revision});
          const move=probeOffer(query.cell);
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
          const nextUnknown=edge&&you?await perceivedProbe(this.game):undefined;
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
        if(typeof health==='number' && typeof frame.observation.vitals.health==='number' && frame.observation.vitals.health<health) return result('changed',{stop:{kind:'healthLost',before:health,after:frame.observation.vitals.health}});
        if(JSON.stringify(frame.observation.vitals.condition)!==condition) return result('changed',{stop:{kind:'conditionChanged',before:condition?JSON.parse(condition):null,after:frame.observation.vitals.condition}});
        if(frame.observation.vitals.hunger!==hunger) return result('changed',{stop:{kind:'hungerChanged',before:hunger,after:frame.observation.vitals.hunger}});
        if(route.distance===0) {
          if(door) return result((await this.game.actions({direction:door})).cell.terrain?.type==='openDoor'?'arrived':'interrupted');
          return result(frame.observation.location.id!==level?'arrived':'interrupted');
        }
        if(frame.observation.location.id!==level) return result('changed',{stop:{kind:'levelChanged',before:level,after:frame.observation.location.id}});
        if(!frame.outcome.positionChanged) return result('interrupted',{stop:{kind:'positionUnchanged'}});
        if(noticeCreatures && frame.observation.world.some(c=>c.occupant?.kind==='creature' && !before.some(p=>p.x===c.x && p.y===c.y && p.occupant?.appearance===c.occupant?.appearance))) return result('changed',{stop:{kind:'creaturePerceived'},hint:'A creature is now perceived.'});
        if(actionsTaken>=limit) return result(!climb && !door && (destination!=='frontier' || frontiersReached+1>=frontierLimit) && frame.observation.you?.x===to!.x && frame.observation.you?.y===to!.y ? 'arrived' : 'stepLimit');
      }
    } catch(error) {
      const elapsed=this.game.observation.turn-accountedTurn;
      if(elapsed>0){actionsTaken++;turnsElapsed+=elapsed;}
      if(error instanceof WorldError && 'error' in error.response && error.response.error?.code==='staleRevision') return result('changed',{stop:{kind:'staleRevision'}});
      throw new NavigationError(result('error'),error); // Never retry missing or uncertain receipts here.
    } finally { this.running=false; }
  }
}
