import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { accountApi } from './account-client';

/** Shared site navigation and passkey UI; no engine ownership. */
class NeohackRail extends HTMLElement {
  private root = this.attachShadow({mode:'open'});
  private user: {name:string} | null = null;
  private busy = false;
  connectedCallback() {
    this.root.innerHTML = `<style>
      :host{display:block;height:60px;position:relative;z-index:30;color:#e8e3ce;font:14px Arial,sans-serif}*{box-sizing:border-box}header{height:60px;display:flex;align-items:center;gap:26px;padding:0 24px;border-bottom:1px solid #34413d;background:#10181d}a{color:#b8cc9e;text-decoration:none}a:hover,a[aria-current=page]{color:#f2cf90}a[aria-current=page]{text-decoration:underline;text-underline-offset:8px}.brand{font:18px Georgia,serif;color:#eee8d0;white-space:nowrap}.brand span{color:#9baa94}nav{display:flex;gap:22px;align-items:center;flex:1;min-width:0}nav a{white-space:nowrap}.account{display:flex;align-items:center;gap:14px;margin-left:auto;white-space:nowrap}button{font:inherit;cursor:pointer;background:#b9ca9c;color:#17201c;border:1px solid #708160;padding:9px 15px;min-height:40px}button:disabled{opacity:.5;cursor:wait}.quiet{background:transparent;color:#ccd3bd;border-color:#44524a}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid #e5c68b;outline-offset:3px}dialog{width:min(460px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto;background:#141f24;color:#e8e3ce;border:1px solid #64705b;padding:28px}dialog::backdrop{background:#060d12cf}h2{font:32px Georgia,serif;margin:16px 0}p{line-height:1.6;color:#aeb9ab}.dialog-top{display:flex;justify-content:space-between;align-items:center;font:11px monospace;letter-spacing:.14em}.dialog-top button{font-size:22px;min-width:40px;padding:2px}label{display:block;margin-bottom:8px}input{display:block;width:100%;padding:12px;background:#0d171c;color:#eee8d0;border:1px solid #52604f;font:16px Arial,sans-serif}form button{width:100%;margin-top:14px}hr{border:0;border-top:1px solid #34413d;margin:24px 0}#signin{width:100%}#auth-status{color:#e4c68e;min-height:24px}.account[hidden], [hidden]{display:none!important}@media(max-width:650px){header{padding:0 12px;gap:12px}nav{gap:12px;font-size:12px;overflow:auto}nav .secondary{display:none}.brand{font-size:16px}.account{gap:6px;font-size:12px}.account button{padding:8px}#account-name{max-width:100px;overflow:hidden;text-overflow:ellipsis}.signout{font-size:0!important}.signout:after{content:'↪';font-size:18px}}
      :host(:not([game])) slot{display:none}
      :host([game]){height:var(--site-rail-height,60px)}
      :host([game]) slot{display:block}
      :host([game]) slot[name="game-menu"]{flex:0 0 44px}
      :host([game]) header{height:100%;gap:18px;flex-wrap:wrap;align-content:center}
      :host([game]) nav{flex:0 1 auto}
      :host([game]) slot[name="game-info"]{flex:1;min-width:0}
      :host([game]) .account{margin-left:0}
      :host([game]) header a,:host([game]) header button{min-height:44px;display:inline-flex;align-items:center}
      @media(max-width:1499px){
        :host([game]) header{column-gap:14px;row-gap:0}
        :host([game]) nav{flex:1}
        :host([game][welcome]) slot[name="game-info"]{order:1;flex:1 1 calc(100% - 90px)}
        :host([game]:not([welcome])) slot[name="game-info"]{display:none}
        :host([game][welcome]) slot[name="game-link"]{order:2}
      }
      @media(max-width:650px){:host([game]) header{column-gap:8px}:host([game]) nav{gap:10px}:host([game]) nav a{font-size:12px}:host([game]) nav .secondary{display:none}:host([game]) #account-name{max-width:65px}}
    </style><header><a class="brand" href="/">neo<span>hack</span></a><nav aria-label="Site"><a href="/bots">Workshop</a><a href="/component">Component</a><a class="secondary" href="/dashboard">Ledger</a></nav><slot name="game-info"></slot><slot name="game-link"></slot><div class="account"><button id="open-login">Sign in</button><a id="account-name" href="/login" hidden></a><button id="logout" class="quiet signout" aria-label="Sign out" hidden>Sign out</button></div><slot name="game-menu"></slot></header>
    <dialog aria-labelledby="account-title"><div class="dialog-top">YOUR ADVENTURER’S KEY<button id="close-login" class="quiet" aria-label="Close account dialog">×</button></div><h2 id="account-title">Welcome, traveler.</h2><p>Save your bots and revisit your adventures.</p><button id="signin">Sign in with a passkey</button><hr><form><label for="name">New here? Choose a unique name</label><input id="name" required pattern="[A-Za-z](?:[A-Za-z0-9_]|-){2,23}" minlength="3" maxlength="24" autocomplete="username webauthn" placeholder="Choose a unique name"><button id="register" type="submit">Create a passkey →</button></form><p>Use 3–24 letters, numbers, underscores or hyphens, starting with a letter.</p><p>For access from several devices, save your passkey on your phone. Choose the phone or “Use another device” option in your browser’s dialog, then scan its QR code. Keep your passkey; there is no password reset.</p><p id="auth-status" role="status" aria-live="polite"></p></dialog>`;
    for(const link of this.root.querySelectorAll<HTMLAnchorElement>('nav a')) if(location.pathname.replace(/\/$/,'') === link.pathname) link.setAttribute('aria-current','page');
    this.root.addEventListener('keydown',event=>{if((event.target as Node).getRootNode()===this.root)event.stopPropagation();});
    this.root.querySelector('#open-login')!.addEventListener('click',()=>this.open());
    this.root.querySelector('#close-login')!.addEventListener('click',()=>this.dialog.close());
    this.root.querySelector('#signin')!.addEventListener('click',()=>void this.authenticate(false));
    this.root.querySelector('form')!.addEventListener('submit',event=>{event.preventDefault();void this.authenticate(true);});
    this.root.querySelector('#logout')!.addEventListener('click',()=>void this.signout());
    if(!(location.pathname.replace(/\/$/,'')==='/dashboard'&&new URL(location.href).searchParams.has('run')))void this.refresh();
  }
  private get dialog() { return this.root.querySelector('dialog')!; }
  open() {
    window.dispatchEvent(new Event('account-dialog-open'));
    this.dialog.showModal();
    const status=this.root.querySelector('#auth-status')!;
    status.textContent=window.isSecureContext ? '' : 'Passkeys need HTTPS or localhost. Open this site over HTTPS to sign in.';
  }
  private async refresh() { try {this.user=await accountApi();} catch {this.user=null;} this.renderAccount(); }
  private renderAccount() {
    const name=this.root.querySelector<HTMLAnchorElement>('#account-name')!;
    name.textContent=this.user?.name ?? '';name.hidden=!this.user;
    this.root.querySelector<HTMLElement>('#logout')!.hidden=!this.user;
    this.root.querySelector<HTMLElement>('#open-login')!.hidden=!!this.user;
  }
  private changed() {this.renderAccount();window.dispatchEvent(new CustomEvent('accountchange',{detail:this.user}));}
  private async authenticate(register:boolean) {
    if(this.busy)return;this.busy=true;
    const status=this.root.querySelector('#auth-status')!;
    this.root.querySelectorAll<HTMLButtonElement>('form button,#signin').forEach(button=>button.disabled=true);
    try {
      if(!window.isSecureContext)throw Error('Passkeys need HTTPS or localhost. Open this site over HTTPS to sign in.');
      status.textContent='Follow your browser’s passkey prompt…';
      const name=this.root.querySelector<HTMLInputElement>('#name')!.value.trim();
      const optionsJSON=await accountApi('/options',register?{register:true,name}:{});
      const response=register?await startRegistration({optionsJSON}):await startAuthentication({optionsJSON});
      this.user=await accountApi('/verify',response);this.changed();this.dialog.close();
    } catch(error){status.textContent=error instanceof Error ? error.message : String(error);} finally {this.busy=false;this.root.querySelectorAll<HTMLButtonElement>('form button,#signin').forEach(button=>button.disabled=false);}
  }
  private async signout() {
    try {await accountApi('/logout',{});this.user=null;this.changed();}
    catch(error){this.open();this.root.querySelector('#auth-status')!.textContent=error instanceof Error ? error.message : String(error);}
  }
}
if(!customElements.get('neohack-rail'))customElements.define('neohack-rail',NeohackRail);
