/**
 * Silver curve-regime engine — SHARED by the dashboard and the server-side
 * daily auto-logger. Single source of truth on purpose: a duplicated copy
 * would drift, and the whole point of auto-logging is that server entries and
 * dashboard entries come from the same engine so they can be compared.
 *
 * Browser:  <script src="scripts/engine.js"></script>  -> window.Engine
 * Node:     const Engine = require('./engine.js')
 *
 * Pure: no DOM, no network, no globals. reason(d) takes the gathered data
 * object and returns the verdict.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
const fmt=(x,d=1)=>x==null?'\u2014':(x>=0?'+':'')+x.toFixed(d);
function parseTitleDate(t){const M={january:0,february:1,march:2,april:3,may:4,june:5,july:6,august:7,september:8,october:9,november:10,december:11};const m=t.toLowerCase().match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})?,?\s*(\d{4})?/);if(!m)return null;const now=new Date();const yr=m[3]?+m[3]:now.getFullYear();return new Date(yr,M[m[1]],m[2]?+m[2]:28);}
function daysToExpiry(t){const d=parseTitleDate(t);if(!d)return null;return Math.round((d-new Date())/86400000);}

// reason(d, variant):
//   variant undefined -> v13, THE CHAMPION. Behaviour frozen; do not touch.
//   variant 'v14'     -> THE CHALLENGER (spec pre-committed 2026-08-16, before
//     any v14 verdict was ever scored). Exactly two changes, each repairing an
//     internal contradiction with the project's own validated findings:
//     1. oilTilt reads the 5-SESSION oil change (d.oilChg5, scaled /6) instead
//        of the 1-day change (/3). The validated oil->silver channel is ~20d
//        forward with same-day correlation ~0 — v13's dominant input was the
//        one timescale shown to carry no information (57% flip rate resulted).
//     2. Direction dead-band widens 0.15 -> 0.25: a 5-20d forecaster should
//        need more evidence to leave 'balanced', giving verdicts hysteresis.
//   PROMOTION RULE (fixed now): v14 replaces v13 only if, with >=15 independent
//   (non-overlapping) t+5 windows in the shadow log, its pooled t+5/t+10
//   directional hit rate beats BOTH v13's and momentum's on the same dates by
//   >=10pp. Otherwise v14 is retired and the next challenger starts fresh.
function reason(d,variant){
  const C=d.contracts;
  C.forEach(c=>{
    c.near=c.dte!=null&&c.dte>=0&&c.dte<=7;
    c.far=c.dte!=null&&c.dte>30;
    c.thin=(c.vol||0)<150000;
    c.decay=c.near&&c.delta!=null&&c.delta<0;
    // a near-dated contract RISING hard is NOT decay — it's real repricing on news
    c.repriceUp=c.delta!=null&&Math.abs(c.delta)>=8&&!c.decay;
    const t=c.title.toLowerCase();
    // reversal/negation words that flip a threat-word into DE-escalation:
    // "blockade ... LIFTED", "airspace ... REOPENED", "war ... ENDS", "traffic RETURNS to normal"
    const reversal=/lifted|reopen|re-open|ends?|ended|ending|resolved|withdraw|withdrawn|returns? to normal|restored|normaliz|de-?escalat|stand[ -]?down|cease|halt(ed|s)?|truce/.test(t);
    const threat=/blockade|airspace|strike|attack|invade|war|sink|missile|closure|closes|seize|shut/.test(t);
    const dealish=/peace|deal|ceasefire|agreement|surrender|diplomat|nuclear (deal|agreement|talks|accord)/.test(t);
    if(dealish||(threat&&reversal))c.escSign=+1;        // de-escalation: a deal, OR a threat being undone
    else if(threat&&!reversal)c.escSign=-1;             // genuine escalation: threat word, no reversal
    else if(reversal)c.escSign=+1;                       // reversal language alone (returns to normal etc.)
    else c.escSign=0;
    if(c.thin)c.role='thin';
    else if(c.decay)c.role='decay·excluded';
    else if(c.far&&Math.abs(c.escSign)===1)c.role='regime anchor';
    else if(c.escSign===-1)c.role='escalation watch';
    else if(c.delta!=null&&Math.abs(c.delta)>=5&&!c.decay)c.role='repricing';
    else c.role='context';
  });
  // repricing contributions: a hard move on a non-decaying, non-thin contract feeds the tilt
  // via its escSign direction (de-escalation rising = bullish, escalation rising = bearish)
  const repricers=C.filter(c=>c.role==='repricing'&&!c.thin&&c.escSign!==0&&c.delta!=null);
  let repTilt=0,repW=0;
  repricers.forEach(c=>{const w=Math.min(1,c.vol/600000);repTilt+=c.escSign*Math.sign(c.delta)*Math.min(1,Math.abs(c.delta)/30)*w;repW+=w;});
  repTilt=repW>0?repTilt/repW:0;
  const anchors=C.filter(c=>c.escSign===+1&&c.far&&!c.thin&&c.yes!=null);
  let regimeLevel=null,sw=0,sv=0;
  anchors.forEach(c=>{const w=Math.min(1,c.vol/1000000);sw+=w;sv+=c.yes*w;});
  if(sw>0)regimeLevel=sv/sw;
  // No fallback to mid-dated contracts when there are zero deep anchors: averaging
  // near/mid-dated noise into "regimeLevel" while still labeling it "0 deep anchors"
  // self-contradicts the displayed text and quietly leaks a phantom signal into the
  // tilt and confidence math. Zero anchors means no regime read, full stop.
  let regimeTilt=regimeLevel!=null?Math.max(-1,Math.min(1,(regimeLevel-50)/40)):0;
  const esc=C.filter(c=>c.escSign===-1&&!c.thin&&c.yes!=null);
  let escLevel=esc.length?Math.max(...esc.map(c=>c.yes)):0;
  let escRising=esc.some(c=>c.yes>=25&&c.delta!=null&&c.delta>=5);
  let escTilt=-Math.max(0,(escLevel-35)/50);if(escRising)escTilt-=0.15;escTilt=Math.max(-1,escTilt);
  let contractTilt=Math.max(-1,Math.min(1,regimeTilt+escTilt+0.4*repTilt));
  let oilTilt=(variant==='v14')
    ?(d.oilChg5!=null?Math.max(-1,Math.min(1,-d.oilChg5/6)):null)
    :(d.oilChg!=null?Math.max(-1,Math.min(1,-d.oilChg/3)):null);
  let netTilt=oilTilt!=null?0.4*contractTilt+0.6*oilTilt:contractTilt;
  const contradiction=oilTilt!=null&&Math.sign(contractTilt)!==Math.sign(oilTilt)&&Math.abs(contractTilt)>0.35&&Math.abs(oilTilt)>0.25;
  // the +12 agreement bonus is documented as "oil agrees with the REGIME read" — it must not
  // fire when there is no regime read (regimeLevel null), or a lone one-day oil move plus
  // escalation/repricing scraps can still reach 52% confidence with zero structural anchors
  let conf=22+Math.min(20,anchors.length*6)+((oilTilt!=null&&Math.abs(oilTilt)>0.3)?18:0)+((oilTilt!=null&&regimeLevel!=null&&Math.sign(contractTilt)===Math.sign(oilTilt))?12:0);
  // PRICED-IN PENALTY: when relief is already consensus (far-dated odds high), the channel may
  // have already fired; sell-the-news risk is elevated. Cap confidence on bullish calls accordingly.
  // Rationale: silver fell across multiple confident bullish reads while the regime sat at 57-79%.
  // We can't validate this yet — it's a hypothesis — but the asymmetric room-for-surprise is real.
  let pricedIn=false, pricedInLevel=null;
  if(regimeLevel!=null && regimeLevel>=60 && netTilt>0){
    pricedIn=true; pricedInLevel=regimeLevel;
    // taper bullish confidence as regime exceeds 60%: at 60% = no penalty, at 80% = cap at 45
    const over=Math.min(1,(regimeLevel-60)/20);
    const cap=Math.round(65-over*20); // 65 down to 45
    conf=Math.min(conf,cap);
  }
  if(contradiction)conf=Math.min(conf,28);
  const DIR_TH=(variant==='v14')?0.25:0.15;
  const dir=netTilt,tilt=dir>DIR_TH?'bullish':dir<-DIR_TH?'bearish':'balanced';
  // narrative
  const decayed=C.filter(c=>c.decay);
  const standout=C.filter(c=>!c.decay&&!c.thin&&c.delta!=null).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta))[0];
  const regimeWord=regimeLevel==null?'unclear (no deep anchors)':regimeLevel>=60?'active de-escalation':regimeLevel>=45?'leaning de-escalation':regimeLevel>=30?'mixed':'escalation-leaning';
  // ---- CATALYST TIMELINE: term structure of de-escalation from the deal curve ----
  // Read the market's expected WHEN, not silver's price. Each deal contract = P(catalyst by its date).
  const dealCurve=C.filter(c=>c.escSign===+1&&/deal|ceasefire|agreement|peace/.test(c.title.toLowerCase())&&c.dte!=null&&c.dte>=0&&c.yes!=null&&!c.thin)
    .sort((a,b)=>a.dte-b.dte);
  let timelineTxt='',slope=null,nearP=null,farP=null;
  if(dealCurve.length>=2){
    nearP=dealCurve[0]; farP=dealCurve[dealCurve.length-1];
    slope=(farP.yes-nearP.yes)/Math.max(1,(farP.dte-nearP.dte)); // pts per day
    const shape = farP.yes-nearP.yes>15?'rising term structure (slow thaw — more likely the longer the horizon)':
                  farP.yes-nearP.yes<-15?'inverted (near-term resolution priced, fades later)':'flat (steady probability across horizons)';
    // expected duration of the relief tilt: long if far-dated odds high & rising
    const duration = (farP.yes>=65&&farP.dte>=60)?'durable — the catalyst backdrop extends months out, so the relief tilt is not about to expire':
                     (nearP.yes>=55)?'near-term — resolution expected soon, watch for a confirming spike or a fade':
                     'uncertain — the curve does not strongly favor a timeframe';
    timelineTxt='Catalyst term structure: P(deal) runs '+Math.round(nearP.yes)+'% by '+nearP.dte+'d → '+Math.round(farP.yes)+'% by '+farP.dte+'d. Shape: '+shape+'. Duration of tilt: '+duration+'.';
  } else timelineTxt='Insufficient dated deal contracts to build a catalyst term structure today.';
  let headline;
  if(contradiction)headline='Iran/oil channel: contracts and oil disagree — no confident call. (Other channels not modeled — see scope note.)';
  else if(tilt==='bullish'&&pricedIn)headline='Iran/oil channel only: relief tilt, but consensus already priced (regime '+Math.round(pricedInLevel)+'%) — sell-the-news risk + other-channel offsets not modeled. Confidence throttled.';
  else if(tilt==='bullish')headline='Iran/oil channel only: relief tilt, '+(d.oilChg!=null&&d.oilChg<-1?'oil falling '+fmt(d.oilChg)+'% ':'')+'into a '+regimeWord+' regime. One channel\u2019s read — see scope note before treating as a silver verdict.';
  else if(tilt==='bearish')headline='Iran/oil channel only: stagflation tilt, '+(d.oilChg!=null&&d.oilChg>1?'oil rising '+fmt(d.oilChg)+'% ':'')+'with '+regimeWord+'. One channel\u2019s read \u2014 other channels not modeled here.';
  else headline='Iran/oil channel: balanced \u2014 no decisive lean. Other channels not modeled here.';
  const reg=regimeLevel==null
    ?'<b class="dim">NO REGIME READ</b> — 0 contracts qualify as deep anchors today, so this component is dropped from tilt and confidence entirely. Near-dated noise is NOT substituted in its place; the verdict below rests on the remaining components (mostly oil) with correspondingly less structural grounding.'
    :'Regime read from '+anchors.length+' deep anchor'+(anchors.length===1?'':'s')+': de-escalation odds average '+Math.round(regimeLevel)+'% on the far-dated curve → <b class="'+(regimeTilt>0.1?'bull':regimeTilt<-0.1?'bear':'dim')+'">'+regimeWord+'</b>. This is the structural backdrop, read from levels not the noisy near-dated deltas.'+(pricedIn?' <b class="warn">CAUTION:</b> regime is already at consensus — relief is the priced view, not a surprise. Sell-the-news risk material; confidence capped accordingly.':'');
  const decTxt=decayed.length?decayed.length+' near-dated contract'+(decayed.length===1?'':'s')+' bleeding toward zero on calendar decay (e.g. "'+decayed[0].title.slice(0,40)+'" '+fmt(decayed[0].delta)+'pt at '+decayed[0].dte+'d) — excluded from direction. These deadline-failures are NOT escalation.':'No near-dated decay distortion today.';
  const oilTxt=d.oilChg==null?'Oil unavailable — running on contracts alone, lower confidence.':(contradiction?'Oil ('+fmt(d.oilChg)+'%) CONTRADICTS the contract lean — confidence forced low. Trust oil.':'Oil '+fmt(d.oilChg)+'% '+(d.oilChg<0?'(relief→bullish)':d.oilChg>0?'(stagflation→bearish)':'(neutral)')+' '+(regimeLevel==null?'is the dominant vote (no regime read to corroborate).':(Math.sign(contractTilt)===Math.sign(oilTilt)?'AGREES with the regime read — confidence reinforced.':'is the dominant vote.')));
  const points=[];
  points.push(regimeLevel!=null
    ?'Regime (deep curve): '+regimeWord+' at ~'+Math.round(regimeLevel)+'% deal odds — the de-escalation backdrop that drives silver via oil.'
    :'Regime (deep curve): no read — zero qualifying deep anchors; component excluded rather than approximated from near-dated contracts.');
  if(pricedIn)points.push('PRICED-IN check fired: regime at '+Math.round(pricedInLevel)+'% means relief is consensus, not surprise. Room to upside-disappoint > room to upside-surprise. Confidence capped — this addresses the failure mode where confident bullish reads preceded silver DOWN-days.');
  if(decayed.length)points.push('Calendar decay disarmed: '+decayed.length+' near-dated drop'+(decayed.length===1?'':'s')+' correctly read as deadline-lapse, not escalation (the trap that fooled the arithmetic engine).');
  if(standout&&Math.abs(standout.delta)>=5)points.push('Standout real move: "'+standout.title.slice(0,40)+'" '+fmt(standout.delta)+'pt — '+(standout.escSign>0?'de-escalation/normalization signal':standout.escSign<0?'escalation signal':'notable repricing')+', not decay.');
  points.push('Escalation watch: max escalation odds '+Math.round(escLevel)+'%'+(escRising?' and rising':' and quiet')+' → '+(escTilt<-0.1?'meaningful bearish drag':'no escalation bid'));
  if(d.oilChg!=null)points.push('Oil anchor: '+fmt(d.oilChg)+'% '+(d.oilChg<0?'confirms relief':d.oilChg>0?'signals stagflation':'neutral')+' — the one validated channel, weighted 60% of direction.');
  const fals=[];
  if(d.oilChg!=null&&d.oilChg<0)fals.push('Oil reversing back up — the relief bid evaporates (oil is the anchor).');
  else if(d.oilChg!=null&&d.oilChg>0)fals.push('Oil rolling back down — the stagflation pressure releases.');
  fals.push('Deep deal odds (now ~'+(regimeLevel!=null?Math.round(regimeLevel)+'%':'n/a')+') breaking '+(regimeLevel!=null&&regimeLevel>=50?'below 50% — de-escalation regime failing.':'above 50% — de-escalation taking hold.'));
  fals.push('An escalation contract (blockade/airspace) spiking high on real news rather than calendar noise.');
  if(pricedIn)fals.push('Silver continuing to ignore relief signals — would confirm sell-the-news regime; downgrade the channel until proven otherwise.');
  return {tilt,confidence:Math.round(conf),dir,headline,regime:reg,decay_caught:decTxt,oil_check:oilTxt,timeline:timelineTxt,key_points:points,falsifiers:fals,contradiction,pricedIn,regimeLevel,dealCurve,oilTilt};
}

return { fmt, parseTitleDate, daysToExpiry, reason };
});
