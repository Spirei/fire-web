/** One owner for cancellation, result ordering and foreground recovery. */
export class FeedReadLifecycle {
  private controller:AbortController|null=null;
  private sequence=0;
  private needsRead=false;
  private confirmedAt:number;
  private startedAt=0;
  requests=0;
  lastReadMs=0;
  constructor(hasInitial=false){this.confirmedAt=hasInitial?Date.now():0;}
  get epoch(){return this.sequence;}
  get pending(){return !!this.controller&&!this.controller.signal.aborted;}
  begin(){
    if(this.pending)return null;
    this.cancel();
    const controller=new AbortController();this.controller=controller;this.startedAt=Date.now();++this.requests;
    return {controller,epoch:this.sequence};
  }
  current(epoch:number){return epoch===this.sequence;}
  confirm(epoch:number){if(this.current(epoch)){this.confirmedAt=Date.now();this.lastReadMs=this.confirmedAt-this.startedAt;this.needsRead=false;}}
  finish(controller:AbortController){if(this.controller===controller)this.controller=null;}
  cancel(){if(this.pending)this.needsRead=true;this.controller?.abort();this.controller=null;++this.sequence;}
  shouldResume(){return !this.pending&&(this.needsRead||!this.confirmedAt||Date.now()-this.confirmedAt>30_000);}
}
