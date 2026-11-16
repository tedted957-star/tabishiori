// 旅しおり — Firebase（ログイン・データ）+ Googleマップ（地図・場所・ルート）
const FB = 'https://www.gstatic.com/firebasejs/10.14.1/';
// config.js は「const firebaseConfig = {…};」を貼っただけでも動くようにする
const CFG = window.APP_CONFIG || {
  firebase: (typeof firebaseConfig!=='undefined') ? firebaseConfig : null,
  mapsApiKey: (typeof mapsApiKey!=='undefined') ? mapsApiKey : ''
};
const $ = s => document.querySelector(s);

/* ================= state ================= */
const S = {
  user:null, trips:[], tripsLoaded:false, tripId:null, trip:{},
  items:[], stays:[], costs:[], bookings:[], routes:{}, unsubs:[],
  tab:'plan', day:null, mapDay:'all', ready:false, routeReq:new Set(), photoFix:new Set()
};
const TABS=['plan','map','stay','cost','book'];
let F = {}; // firebase functions
let db, auth;

/* ================= utils ================= */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yen = n => '¥' + Math.round(n||0).toLocaleString('ja-JP');
const num = v => { const n = parseFloat(String(v??'').replace(/[,¥円\s]/g,'')); return isFinite(n) ? n : 0; };
const toast = m => { const t=$('#toast'); t.textContent=m; t.style.display='block'; clearTimeout(toast._t); toast._t=setTimeout(()=>t.style.display='none',2400); };
const WD=['日','月','火','水','木','金','土'];
const pad2 = n => String(n).padStart(2,'0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const todayStr = () => ymd(new Date());
function parseDate(s){ if(!s||!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null; const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
function fmtDate(s){ const d=parseDate(s); return d? `${d.getMonth()+1}/${d.getDate()}(${WD[d.getDay()]})` : (s||''); }
function addDays(s,n){ const d=parseDate(s); d.setDate(d.getDate()+n); return ymd(d); }
function tripDays(){ const a=S.trip.start,b=S.trip.end, out=[]; if(parseDate(a)&&parseDate(b)&&a<=b){ let c=a,g=0; while(c<=b&&g<60){ out.push(c); c=addDays(c,1); g++; } } return out; }
const headcount = () => Math.max(1, Math.round(num(S.trip.headcount)) || (S.trip.members||[]).length || 1);
const hasLL = o => o && typeof o.lat==='number' && typeof o.lng==='number' && isFinite(o.lat) && isFinite(o.lng) && !(o.lat===0&&o.lng===0);
const ptStr = o => hasLL(o) ? `${o.lat},${o.lng}` : (o.place||o.address||o.title||o.name||'');
const gmapsPoint = o => o.gmapsUrl ? o.gmapsUrl : 'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(hasLL(o)?`${o.lat},${o.lng}`:(o.place||o.address||o.title||o.name||''))+(o.placeId?'&query_place_id='+encodeURIComponent(o.placeId):'');
const gmapsDir = (a,b,mode) => `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(ptStr(a))}&destination=${encodeURIComponent(ptStr(b))}&travelmode=${mode==='car'?'driving':mode==='walk'?'walking':'transit'}`;
const safeUrl = u => { u=String(u||'').trim(); if(!u) return ''; if(!/^https?:\/\//i.test(u)) u='https://'+u; return u; };
function parseLL(t){ t=String(t||''); const m=t.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)||t.match(/[?&](?:q|query|ll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/)||t.match(/^\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/)||t.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/); if(!m) return null; const lat=+m[1],lng=+m[2]; if(Math.abs(lat)>90||Math.abs(lng)>180) return null; return {lat,lng}; }
const randCode = () => Array.from(crypto.getRandomValues(new Uint8Array(12))).map(b=>'abcdefghjkmnpqrstuvwxyz23456789'[b%31]).join('');
async function copyText(s){ try{ await navigator.clipboard.writeText(s); toast('コピーしました'); }catch(e){ toast('コピーできませんでした'); } }
const appUrl = () => location.origin + location.pathname;

/* ================= estimation (fallback when Google has no route) ================= */
function hav(a,b){ const R=6371,r=x=>x*Math.PI/180; const dLa=r(b.lat-a.lat),dLo=r(b.lng-a.lng); const h=Math.sin(dLa/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(dLo/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
function fuelCost(km){ return km/(num(S.trip.fuelEff)||13)*(num(S.trip.fuelPrice)||175); }
function estFare(km){ if(km<3) return 180; if(km<100) return Math.round((150+km*21)/10)*10; if(km<250) return Math.round((km*17+2500)/10)*10; return Math.round((km*16+4500)/10)*10; }
function est(km){
  const w=km*1.25, c=km*1.3, t=km*1.3;
  const cs = c<5?20:c<30?32:c<100?50:70, ts = t<10?18:t<50?32:t<250?75:160;
  return { walk:{km:w,min:w/4.5*60,cost:0},
           car:{km:c,min:c/cs*60+5,fuel:fuelCost(c),toll:c>40?c*24:0,cost:fuelCost(c)+(c>40?c*24:0)},
           transit:{km:t,min:t/ts*60+10,fare:estFare(t),cost:estFare(t)} };
}
function pickMode(km,pref){
  if(['walk','car','transit'].includes(pref)) return pref;
  if(km<1.2) return 'walk';
  const m=S.trip.mainMode||'mixed'; if(m==='car') return 'car'; if(m==='transit') return 'transit';
  if(km<8) return 'transit';
  const e=est(km); return e.car.min<e.transit.min*0.85?'car':'transit';
}
const MODE={walk:'🚶徒歩',transit:'🚃公共交通',car:'🚗車'};
const fmtMin = m => { m=Math.round(m); return m<60?`${m}分`:`${Math.floor(m/60)}時間${m%60?m%60+'分':''}`; };
const fmtKm = k => k<10? k.toFixed(1)+'km' : Math.round(k)+'km';

/* ================= Google: routes, places ================= */
const routeKey = (a,b,mode) => `${mode}_${a.lat.toFixed(4)}_${a.lng.toFixed(4)}_${b.lat.toFixed(4)}_${b.lng.toFixed(4)}`.replace(/\./g,'p').replace(/-/g,'m');
const money = m => m ? num(m.units) + (m.nanos||0)/1e9 : 0;
async function fetchRoute(a,b,mode,whenDate,whenTime){
  const tm={car:'DRIVE',walk:'WALK',transit:'TRANSIT'}[mode];
  const body={ origin:{location:{latLng:{latitude:a.lat,longitude:a.lng}}}, destination:{location:{latLng:{latitude:b.lat,longitude:b.lng}}},
    travelMode:tm, languageCode:'ja', regionCode:'JP', units:'METRIC' };
  if(mode==='car'){ body.extraComputations=['TOLLS']; body.routeModifiers={vehicleInfo:{emissionType:'GASOLINE'}}; }
  if(mode==='transit' && whenDate){ const d=new Date(`${whenDate}T${whenTime||'09:00'}:00`); if(d>new Date()) body.departureTime=d.toISOString(); }
  const r=await fetch('https://routes.googleapis.com/directions/v2:computeRoutes',{method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':CFG.mapsApiKey,
    'X-Goog-FieldMask':'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.travelAdvisory.tollInfo,routes.travelAdvisory.transitFare'},body:JSON.stringify(body)});
  if(!r.ok) throw new Error('routes '+r.status);
  const j=await r.json(); const rt=j.routes&&j.routes[0];
  if(!rt) return {ok:false, at:Date.now()};
  const tolls=(rt.travelAdvisory?.tollInfo?.estimatedPrice||[]).filter(p=>p.currencyCode==='JPY').reduce((s,p)=>s+money(p),0);
  const fare=rt.travelAdvisory?.transitFare?.currencyCode==='JPY'? money(rt.travelAdvisory.transitFare) : null;
  return {ok:true, km:(rt.distanceMeters||0)/1000, min:parseInt(String(rt.duration||'0').replace('s',''))/60, toll: mode==='car'?tolls:0, fare, poly:rt.polyline?.encodedPolyline||'', at:Date.now()};
}
function queueRoutes(legs){
  if(!CFG.mapsApiKey) return;
  legs.forEach(l=>{
    if(!l||l.km==null) return; const k=routeKey(l.a,l.b,l.mode);
    const c=S.routes[k]; if(c && (c.ok || Date.now()-(c.at||0) < 7*864e5)) return;
    if(S.routeReq.has(k)) return; S.routeReq.add(k);
    (async()=>{ try{ const r=await fetchRoute(l.a,l.b,l.mode,l.b.day,l.b.time); await F.setDoc(F.doc(db,`trips/${S.tripId}/routes/${k}`),r); }catch(e){ console.warn('route',e); } })();
  });
}
async function placesSearch(q){
  if(!CFG.mapsApiKey) return osmSearch(q);
  const {Place} = await google.maps.importLibrary('places');
  const {places} = await Place.searchByText({ textQuery:q, language:'ja', region:'jp', maxResultCount:6,
    fields:['id','displayName','formattedAddress','location','photos','nationalPhoneNumber','websiteURI','rating','userRatingCount','googleMapsURI'] });
  return (places||[]).map(placeToObj);
}
// 無料の地図（OpenStreetMap）で場所を検索（Googleマップのキーがないとき）
async function osmSearch(q){
  const r=await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=6&accept-language=ja&q='+encodeURIComponent(q));
  if(!r.ok) throw new Error('osm '+r.status);
  const j=await r.json();
  return j.map(x=>{ const parts=String(x.display_name||'').split(',').map(s=>s.trim()); const addr=parts.slice(1).reverse().filter(s=>!/^\d{3}-?\d{4}$/.test(s)&&s!=='日本').join('');
    return {placeId:'', name:x.name||parts[0]||q, address:addr||x.display_name||'', lat:+x.lat, lng:+x.lon, phone:'', url:'', rating:null, ratingCount:null,
      gmapsUrl:'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent((x.name||parts[0]||q)+' '+(addr||'')), photoUrl:'', photoAttr:''}; });
}
function placeToObj(p){
  const ph=p.photos&&p.photos[0];
  return { placeId:p.id, name:p.displayName||'', address:p.formattedAddress||'', lat:p.location?p.location.lat():null, lng:p.location?p.location.lng():null,
    phone:p.nationalPhoneNumber||'', url:p.websiteURI||'', rating:p.rating??null, ratingCount:p.userRatingCount??null, gmapsUrl:p.googleMapsURI||'',
    photoUrl: ph? ph.getURI({maxWidth:900}) : '', photoAttr: ph&&ph.authorAttributions&&ph.authorAttributions[0]? ph.authorAttributions[0].displayName : '' };
}
// 写真URLが期限切れになったら取り直す
window.__fixPhoto = async (img, col, id) => {
  img.style.display='none';
  const key=col+'/'+id; if(S.photoFix.has(key)||!window.google?.maps) return; S.photoFix.add(key);
  const o=(S[col]||[]).find(x=>x.id===id); if(!o||!o.placeId) return;
  try{ const {Place}=await google.maps.importLibrary('places'); const p=new Place({id:o.placeId}); await p.fetchFields({fields:['photos']});
    const ph=p.photos&&p.photos[0]; if(ph) await F.updateDoc(F.doc(db,`trips/${S.tripId}/${col}/${id}`),{photoUrl:ph.getURI({maxWidth:900}),photoAttr:ph.authorAttributions?.[0]?.displayName||''}); }catch(e){}
};
const photoHtml = (o,col,style='') => o.photoUrl ? `<img class="ph" style="${style}" src="${esc(o.photoUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="__fixPhoto(this,'${col}','${esc(o.id)}')">${o.photoAttr?`<div class="credit">写真: ${esc(o.photoAttr)} / Google</div>`:''}` : '';

/* ================= day sequence ================= */
function itemsOf(day){ return S.items.filter(i=>(i.day||'')===day).sort((a,b)=>(a.order??0)-(b.order??0)||String(a.time||'').localeCompare(String(b.time||''))); }
function stayFor(night){ return S.stays.find(s=>s.checkin&&s.checkout&&s.checkin<=night&&night<s.checkout); }
function sequence(day){
  const seq=[];
  if(day){ const p=stayFor(addDays(day,-1)); if(p) seq.push({...p,kind:'stayStart',title:p.name}); }
  itemsOf(day).forEach(i=>seq.push({...i,kind:'item'}));
  if(day){ const t=stayFor(day); if(t) seq.push({...t,kind:'stayEnd',title:t.name}); }
  return seq;
}
function legsOf(seq){
  const legs=[];
  for(let i=1;i<seq.length;i++){
    const a=seq[i-1], b=seq[i];
    if(a.kind==='stayStart'&&b.kind==='stayEnd'&&a.id===b.id){ legs.push(null); continue; }
    if(hasLL(a)&&hasLL(b)){
      const km=hav(a,b); const mode=pickMode(km, b.kind==='item'?b.mode:''); const e=est(km);
      const r=S.routes[routeKey(a,b,mode)];
      let x;
      if(r&&r.ok){
        if(mode==='car'){ const fuel=fuelCost(r.km); x={km:r.km,min:r.min,fuel,toll:r.toll||0,cost:fuel+(r.toll||0),real:true}; }
        else if(mode==='transit'){ const fare=r.fare!=null?r.fare:estFare(r.km); x={km:r.km,min:r.min,fare,cost:fare,real:true,fareReal:r.fare!=null}; }
        else x={km:r.km,min:r.min,cost:0,real:true};
      } else x=e[mode];
      legs.push({a,b,km,mode,e,x,poly:r&&r.ok?r.poly:''});
    } else legs.push({a,b,km:null,mode:pickMode(5,b.kind==='item'?b.mode:'')});
  }
  return legs;
}
const legTotal = l => l.mode==='transit' ? l.x.cost*headcount() : l.x.cost;
function daySummary(day){ const seq=sequence(day), legs=legsOf(seq); let km=0,min=0,cost=0,unknown=0;
  legs.forEach(l=>{ if(!l) return; if(l.km==null){unknown++;return;} km+=l.x.km; min+=l.x.min; cost+=legTotal(l); });
  return {km,min,cost,unknown,seq,legs}; }

/* ================= render ================= */
function render(){
  const signedIn=!!S.user;
  $('#hdr').classList.toggle('hidden',!signedIn); $('#tabs').classList.toggle('hidden',!signedIn||!S.tripId);
  if(!signedIn) return;
  const t=S.trip, days=tripDays();
  $('#tripTitle').textContent=(S.tripId?(t.title||'無題の旅行'):'旅しおり')+' ▾';
  let meta='';
  if(S.tripId){
    meta = days.length? `${fmtDate(days[0])}〜${fmtDate(days[days.length-1])}・${days.length-1}泊${days.length}日` : '日程未定';
    meta += `・${headcount()}人`;
    if(days.length){ const diff=Math.round((parseDate(days[0])-parseDate(todayStr()))/864e5); if(diff>0) meta+=`・あと${diff}日`; else if(todayStr()<=days[days.length-1]) meta+='・旅行中！'; }
  } else meta = S.user.displayName ? `${S.user.displayName} さん` : '';
  $('#tripMeta').textContent=meta;
  document.querySelectorAll('#tabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===S.tab));
  const v=$('#view');
  if(!S.tripsLoaded){ v.innerHTML='<div class="empty">読み込み中…</div>'; return; }
  if(!S.tripId){ renderHome(v); return; }
  ({plan:renderPlan,map:renderMap,stay:renderStays,cost:renderCost,book:renderBook})[S.tab](v);
}

function renderHome(v){
  let h=`<div class="card"><h3 style="margin:0 0 6px">${S.trips.length?'旅行を選んでください':'ようこそ！最初の旅行を作りましょう'}</h3>
    <p class="small" style="margin:0">旅行ごとに、招待した同行メンバーだけが見られます。</p></div>`;
  S.trips.forEach(t=>{ h+=`<button class="card" data-trip="${esc(t.id)}" style="display:block;width:100%;text-align:left;cursor:pointer"><b>${esc(t.title||'無題の旅行')}</b><div class="small">${t.start?fmtDate(t.start)+'〜'+fmtDate(t.end):'日程未定'}${t.destination?'・'+esc(t.destination):''}・${(t.members||[]).length}人</div></button>`; });
  h+=`<button class="btn" id="newTrip" style="margin-top:8px">＋ 新しい旅行を作る</button>`;
  v.innerHTML=h;
  v.querySelectorAll('[data-trip]').forEach(b=>b.onclick=()=>{ selectTrip(b.dataset.trip); });
  $('#newTrip').onclick=openNewTrip;
}

function dayChips(sel,withAll){
  const days=tripDays(); let h='<div class="days">';
  if(withAll) h+=`<button class="chip ${sel==='all'?'on':''}" data-day="all">全日程</button>`;
  days.forEach((d,i)=>h+=`<button class="chip ${sel===d?'on':''}" data-day="${d}">${i+1}日目 ${fmtDate(d)}</button>`);
  if(!days.length||S.items.some(i=>!i.day||!days.includes(i.day))) h+=`<button class="chip ${sel===''?'on':''}" data-day="">日付未定</button>`;
  return h+'</div>';
}
function currentDay(){ const days=tripDays(); if(S.day===null||(S.day!==''&&!days.includes(S.day))){ const t=todayStr(); S.day=days.includes(t)?t:(days[0]??''); } return S.day; }

function renderPlan(v){
  const day=currentDay(); const {km,min,cost,unknown,seq,legs}=daySummary(day);
  let h=dayChips(day,false);
  h+=`<div class="sum"><div class="b"><div class="k">移動距離</div><div class="v">${fmtKm(km)}</div></div>
    <div class="b"><div class="k">移動時間</div><div class="v">${fmtMin(min)}</div></div>
    <div class="b"><div class="k">交通費（全員）</div><div class="v">${yen(cost)}</div></div></div>`;
  if(unknown) h+=`<div class="banner">場所が地図上で決まっていない区間が${unknown}つあります。予定を開いて「🔎Googleで場所を検索」すると距離・時間・交通費が出ます。</div>`;
  if(!seq.length) h+=`<div class="empty">この日の予定はまだありません</div>`;
  seq.forEach((s,i)=>{ if(i>0&&legs[i-1]) h+=legHtml(legs[i-1]); h+= s.kind==='item'? itemCard(s) : stayAnchor(s); });
  h+=`<div class="row2" style="margin-top:12px"><button class="btn" id="addItem">＋ 予定を追加</button><button class="btn ghost" id="optBtn">🧭 順番を最適化</button></div>
      ${CFG.mapsApiKey?'<button class="btn ghost" id="recBtn" style="margin-top:8px">✨ 行き先のおすすめを探す</button>':''}`;
  const pts=seq.filter(x=>hasLL(x)||x.place||x.address);
  if(pts.length>=2) h+=`<div style="margin-top:8px"><a class="lk" href="${dayRouteUrl(pts)}" target="_blank" rel="noopener">この日の全ルートをGoogleマップで開く ↗</a></div>`;
  v.innerHTML=h;
  v.querySelectorAll('.days .chip').forEach(c=>c.onclick=()=>{S.day=c.dataset.day;render();});
  v.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>openItem(S.items.find(x=>x.id===b.dataset.edit)));
  v.querySelectorAll('[data-up]').forEach(b=>b.onclick=()=>moveItem(b.dataset.up,-1));
  v.querySelectorAll('[data-down]').forEach(b=>b.onclick=()=>moveItem(b.dataset.down,1));
  v.querySelectorAll('[data-gostay]').forEach(b=>b.onclick=()=>{S.tab='stay';render();scrollTo(0,0);});
  $('#addItem').onclick=()=>openItem(null); $('#optBtn').onclick=()=>optimizeDay(day);
  const rb=$('#recBtn'); if(rb) rb.onclick=openRecommend;
  queueRoutes(legs);
}
function dayRouteUrl(pts){ const mode=S.trip.mainMode==='transit'?'transit':'driving'; const o=pts[0],d=pts[pts.length-1]; const w=pts.slice(1,-1).slice(0,8).map(ptStr).join('|');
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(ptStr(o))}&destination=${encodeURIComponent(ptStr(d))}${w?'&waypoints='+encodeURIComponent(w):''}&travelmode=${mode}`; }
function legHtml(l){
  if(l.km==null) return `<div class="leg"><div class="row">距離不明・<a href="${gmapsDir(l.a,l.b,l.mode)}" target="_blank" rel="noopener">経路を調べる ↗</a></div></div>`;
  const x=l.x; let c='';
  if(l.mode==='transit') c=`・${yen(x.cost)}/人${x.real&&!x.fareReal?'(運賃は目安)':''}`;
  if(l.mode==='car') c=`・${yen(x.cost)}（ガソリン${x.toll?`+高速${yen(x.toll)}`:''}）`;
  const others=['walk','transit','car'].filter(m=>m!==l.mode&&!(m==='walk'&&l.km>4)).map(m=>`<span class="opt">${MODE[m]} 約${fmtMin(l.e[m].min)}</span>`).join('');
  return `<div class="leg"><div class="row"><span class="best mode-${l.mode}">${MODE[l.mode]} ${x.real?'':'約'}${fmtMin(x.min)}・${fmtKm(x.km)}${c}</span>${x.real?'<span class="real">Google</span>':'<span class="real" style="background:#f0ebe1;color:#6f6a61">目安</span>'}
    <a href="${gmapsDir(l.a,l.b,l.mode)}" target="_blank" rel="noopener">ナビ ↗</a></div><div class="row">${others}</div></div>`;
}
function itemCard(i){
  const tags=[]; if(i.booking) tags.push(`<span class="tag bk">🎫 ${esc(i.booking)}</span>`);
  if(num(i.cost)) tags.push(`<span class="tag cost">💴 ${yen(num(i.cost))}${i.costPer==='person'?'/人':''}</span>`);
  if(i.mode) tags.push(`<span class="tag">ここへは ${MODE[i.mode]}</span>`);
  if(i.rating) tags.push(`<span class="tag">★${i.rating}</span>`);
  return `<div class="card"><div class="stop"><div class="time">${esc(i.time||'')}</div><div class="body"><h3>${esc(i.title||'(無題)')}</h3>
    ${i.place?`<div class="place">${esc(i.place)}</div>`:''}${i.memo?`<div class="memo">${esc(i.memo)}</div>`:''}${photoHtml(i,'items')}
    ${tags.length?`<div class="tags">${tags.join('')}</div>`:''}
    <div class="links">${(hasLL(i)||i.place)?`<a class="lk" href="${gmapsPoint(i)}" target="_blank" rel="noopener">📍地図</a>`:''}${i.url?`<a class="lk" href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener">🔗リンク</a>`:''}<button class="lk" data-edit="${esc(i.id)}">✏️編集</button></div></div>
    <div class="ordbtns"><button data-up="${esc(i.id)}" aria-label="上へ">▲</button><button data-down="${esc(i.id)}" aria-label="下へ">▼</button></div></div></div>`;
}
function stayAnchor(s){ return `<div class="card stay"><div class="stop"><div class="time">${s.kind==='stayStart'?'出発':'泊'}</div><div class="body"><h3>🏨 ${esc(s.name||'宿')}</h3>${s.address?`<div class="place">${esc(s.address)}</div>`:''}
  <div class="links"><a class="lk" href="${gmapsPoint(s)}" target="_blank" rel="noopener">📍地図</a><button class="lk" data-gostay="1">宿の詳細</button></div></div></div></div>`; }

/* ---------- map ---------- */
const DAYCOL=['#d9663f','#1f7a6d','#3b6fb6','#a0479b','#b08a1e','#4f8a3a','#c43e5c','#2d6b88'];
let MAP=null, MAPEL=null, OVER=[], INFO=null;
async function renderMap(v){
  const days=tripDays(); const sel=S.mapDay;
  v.innerHTML = dayChips(sel,true) + '<div id="gmapWrap"></div><div id="mapInfo"></div><div id="mapSum"></div>';
  v.querySelectorAll('.days .chip').forEach(c=>c.onclick=()=>{S.mapDay=c.dataset.day;render();});
  const dl = sel==='all'? days : [sel];
  const groups = dl.map(d=>{ const s=daySummary(d); return {day:d, seq:s.seq.filter(hasLL), legs:s.legs, col: d===''?'#6f6a61':DAYCOL[Math.max(0,days.indexOf(d))%DAYCOL.length], sum:s}; });
  // summary table
  if(dl.length && dl[0]!==''){
    $('#mapSum').innerHTML=`<div class="card"><table class="table">${groups.map(g=>{ const sq=g.sum.seq.filter(x=>hasLL(x)||x.place); return `<tr><td><span class="dot" style="background:${g.col}"></span>${days.indexOf(g.day)+1}日目 ${fmtDate(g.day)}</td><td class="r">${fmtKm(g.sum.km)}・${fmtMin(g.sum.min)}</td><td class="r">${sq.length>=2?`<a href="${dayRouteUrl(sq)}" target="_blank" rel="noopener">ナビ↗</a>`:''}</td></tr>`; }).join('')}</table></div>`;
  }
  if(!CFG.mapsApiKey){ renderOsmMap(groups,sel); return; }
  try{
    const [{Map,InfoWindow},{AdvancedMarkerElement,PinElement},{encoding}] = await Promise.all([google.maps.importLibrary('maps'),google.maps.importLibrary('marker'),google.maps.importLibrary('geometry')]);
    if(!MAPEL){ MAPEL=document.createElement('div'); MAPEL.id='gmap'; MAP=new Map(MAPEL,{center:{lat:35.68,lng:139.76},zoom:6,mapId:'DEMO_MAP_ID',gestureHandling:'greedy',mapTypeControl:false,streetViewControl:false,fullscreenControl:false}); INFO=new InfoWindow(); }
    const wrap=$('#gmapWrap'); if(!wrap) return; wrap.appendChild(MAPEL);
    OVER.forEach(o=>{ if(o.setMap) o.setMap(null); else o.map=null; }); OVER=[];
    const bounds=new google.maps.LatLngBounds(); let n=0; const seenStay=new Set(); let any=false;
    groups.forEach(g=>{
      g.legs.forEach(l=>{ if(!l||l.km==null) return; const path = l.poly? encoding.decodePath(l.poly) : [l.a,l.b];
        const pl=new google.maps.Polyline({path,map:MAP,strokeColor:g.col,strokeOpacity:l.poly?0.85:0,strokeWeight:4,
          icons: l.poly?[]:[{icon:{path:'M 0,-1 0,1',strokeOpacity:0.9,strokeColor:g.col,scale:3},offset:'0',repeat:'14px'}]}); OVER.push(pl); });
      g.seq.forEach(p=>{
        let glyph, bg=g.col;
        if(p.kind==='item'){ n++; glyph=String(n); } else { if(seenStay.has(p.id)) return; seenStay.add(p.id); glyph='宿'; bg='#d9663f'; }
        const pin=new PinElement({glyph, background:bg, borderColor:'#ffffff', glyphColor:'#ffffff', scale:p.kind==='item'?1:1.15});
        const mk=new AdvancedMarkerElement({map:MAP,position:{lat:p.lat,lng:p.lng},content:pin.element,title:p.title||p.name||''});
        mk.addListener('click',()=>{ INFO.setContent(`<div style="font-family:inherit;max-width:220px"><b>${esc(p.title||p.name||'')}</b>${p.time?' '+esc(p.time):''}<br><span style="font-size:12px;color:#666">${esc(p.place||p.address||'')}</span><br><a href="${gmapsPoint(p)}" target="_blank" rel="noopener">Googleマップで開く</a></div>`); INFO.open({map:MAP,anchor:mk}); });
        OVER.push(mk); bounds.extend({lat:p.lat,lng:p.lng}); any=true;
      });
    });
    S.stays.filter(hasLL).forEach(s=>{ if(seenStay.has(s.id)) return; if(sel!=='all') return; const pin=new PinElement({glyph:'宿',background:'#d9663f',borderColor:'#fff',glyphColor:'#fff'}); const mk=new AdvancedMarkerElement({map:MAP,position:{lat:s.lat,lng:s.lng},content:pin.element,title:s.name}); OVER.push(mk); bounds.extend({lat:s.lat,lng:s.lng}); any=true; });
    if(any){ MAP.fitBounds(bounds,48); google.maps.event.addListenerOnce(MAP,'idle',()=>{ if(MAP.getZoom()>16) MAP.setZoom(16); }); }
    else $('#mapInfo').innerHTML='<div class="small" style="margin:6px 2px">地図に出せる場所がまだありません。予定や宿で「🔎Googleで検索」すると表示されます。</div>';
    groups.forEach(g=>queueRoutes(g.legs));
  }catch(e){ console.error(e); $('#gmapWrap').innerHTML='<div class="empty">地図を読み込めませんでした。APIキーの設定を確認してください。</div>'; }
}

let LMAP=null, LEL=null, LLAYER=null;
async function loadLeaflet(){
  if(window.L) return;
  await new Promise((res,rej)=>{ const l=document.createElement('link'); l.rel='stylesheet'; l.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(l);
    const sc=document.createElement('script'); sc.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'; sc.onload=res; sc.onerror=rej; document.head.appendChild(sc); });
}
async function renderOsmMap(groups,sel){
  try{
    await loadLeaflet();
    const wrap=$('#gmapWrap'); if(!wrap) return;
    if(!LEL){ LEL=document.createElement('div'); LEL.id='gmap'; }
    wrap.appendChild(LEL);
    if(!LMAP){ LMAP=L.map(LEL,{zoomControl:true}).setView([35.68,139.76],6); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(LMAP); LLAYER=L.layerGroup().addTo(LMAP); }
    LLAYER.clearLayers(); setTimeout(()=>LMAP.invalidateSize(),50);
    const pts=[]; let n=0; const seen=new Set();
    const icon=(txt,bg,sq)=>L.divIcon({className:'',iconSize:[28,28],iconAnchor:[14,14],html:`<div style="width:28px;height:28px;border-radius:${sq?'8px':'50%'};background:${bg};color:#fff;border:2.5px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);display:grid;place-items:center;font:700 12px sans-serif">${txt}</div>`});
    groups.forEach(g=>{
      g.legs.forEach(l=>{ if(l&&l.km!=null) L.polyline([[l.a.lat,l.a.lng],[l.b.lat,l.b.lng]],{color:g.col,weight:4,opacity:.85,dashArray:'8 8'}).addTo(LLAYER); });
      g.seq.forEach(p=>{ let t,bg=g.col,sq=false; if(p.kind==='item'){ n++; t=n; } else { if(seen.has(p.id)) return; seen.add(p.id); t='宿'; bg='#d9663f'; sq=true; }
        L.marker([p.lat,p.lng],{icon:icon(t,bg,sq)}).addTo(LLAYER).bindPopup(`<b>${esc(p.title||p.name||'')}</b>${p.time?' '+esc(p.time):''}<br><span style="font-size:12px;color:#666">${esc(p.place||p.address||'')}</span><br><a href="${gmapsPoint(p)}" target="_blank" rel="noopener">Googleマップで開く</a>`);
        pts.push([p.lat,p.lng]); });
    });
    if(sel==='all') S.stays.filter(hasLL).forEach(s=>{ if(seen.has(s.id)) return; L.marker([s.lat,s.lng],{icon:icon('宿','#d9663f',true)}).addTo(LLAYER).bindPopup(esc(s.name)); pts.push([s.lat,s.lng]); });
    if(pts.length) LMAP.fitBounds(pts,{padding:[40,40],maxZoom:16});
    else $('#mapInfo').innerHTML='<div class="small" style="margin:6px 2px">地図に出せる場所がまだありません。予定や宿で「🔎地図で検索」すると表示されます。</div>';
  }catch(e){ console.error(e); const w=$('#gmapWrap'); if(w) w.innerHTML='<div class="empty">地図を読み込めませんでした。電波を確認してください。</div>'; }
}

/* ---------- stays ---------- */
function renderStays(v){
  const list=[...S.stays].sort((a,b)=>String(a.checkin||'').localeCompare(String(b.checkin||'')));
  let h=list.length?'':'<div class="empty">宿はまだ登録されていません</div>';
  list.forEach(s=>{
    const nights=(parseDate(s.checkin)&&parseDate(s.checkout))?Math.round((parseDate(s.checkout)-parseDate(s.checkin))/864e5):0;
    h+=`<div class="card stay">${photoHtml(s,'stays','max-height:220px;margin:0 0 4px')}
      <h3 style="margin:6px 0 0;font-size:17px">🏨 ${esc(s.name||'宿')}${s.rating?` <span class="tag">★${s.rating}${s.ratingCount?`（${s.ratingCount}件）`:''}</span>`:''}</h3>
      ${s.memo?`<div class="memo" style="font-size:13px;margin-top:4px">${esc(s.memo)}</div>`:''}
      <div class="kv">
        ${s.checkin?`<span class="k">日程</span><span>${fmtDate(s.checkin)}〜${fmtDate(s.checkout)}${nights?`（${nights}泊）`:''}</span>`:''}
        ${(s.inTime||s.outTime)?`<span class="k">IN/OUT</span><span>${esc(s.inTime||'-')} / ${esc(s.outTime||'-')}</span>`:''}
        ${s.address?`<span class="k">住所</span><span>${esc(s.address)}</span>`:''}
        ${s.phone?`<span class="k">電話</span><span><a href="tel:${esc(s.phone.replace(/[^\d+]/g,''))}">${esc(s.phone)}</a></span>`:''}
        ${num(s.price)?`<span class="k">料金</span><span>${yen(num(s.price))}（合計）・${yen(num(s.price)/headcount())}/人</span>`:''}
        ${s.booking?`<span class="k">予約番号</span><span><b>${esc(s.booking)}</b></span>`:''}
      </div>
      <div class="links"><a class="lk pri" href="${gmapsPoint(s)}" target="_blank" rel="noopener">📍地図</a>
        ${s.url?`<a class="lk" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">🔗公式サイト</a>`:''}
        ${s.bookUrl?`<a class="lk" href="${esc(safeUrl(s.bookUrl))}" target="_blank" rel="noopener">🧾予約ページ</a>`:''}
        <button class="lk" data-sedit="${esc(s.id)}">✏️編集</button></div></div>`;
  });
  h+=`<button class="btn" id="addStay" style="margin-top:10px">＋ 宿を追加</button>`;
  v.innerHTML=h;
  v.querySelectorAll('[data-sedit]').forEach(b=>b.onclick=()=>openStay(S.stays.find(x=>x.id===b.dataset.sedit)));
  $('#addStay').onclick=()=>openStay(null);
}

/* ---------- cost ---------- */
function renderCost(v){
  const days=tripDays(), M=headcount(); let stay=0,act=0,trans=0,other=0; const rows=[],tRows=[];
  S.stays.forEach(s=>{const p=num(s.price); if(p){stay+=p; rows.push(['🏨 '+(s.name||'宿'),p]);}});
  S.items.forEach(i=>{const c=num(i.cost); if(c){const t=i.costPer==='person'?c*M:c; act+=t; rows.push(['📌 '+(i.title||'予定')+(i.costPer==='person'?`（${yen(c)}×${M}人）`:''),t]);}});
  (days.length?days:['']).forEach((d,idx)=>{const s=daySummary(d); if(s.cost){trans+=s.cost; tRows.push([(d?`${idx+1}日目 ${fmtDate(d)}`:'日付未定')+` ${fmtKm(s.km)}`,s.cost]);}});
  S.costs.forEach(c=>{const a=num(c.amount); if(a) other+= c.per==='person'?a*M:a;});
  const total=stay+act+trans+other;
  v.innerHTML=`<div class="sum"><div class="b"><div class="k">合計（目安）</div><div class="v">${yen(total)}</div></div><div class="b"><div class="k">1人あたり（${M}人）</div><div class="v">${yen(total/M)}</div></div></div>
   <div class="card"><table class="table"><tr><td>🏨 宿泊</td><td class="r">${yen(stay)}</td></tr><tr><td>📌 観光・食事など</td><td class="r">${yen(act)}</td></tr><tr><td>🚃🚗 交通（自動計算）</td><td class="r">${yen(trans)}</td></tr><tr><td>🧾 その他</td><td class="r">${yen(other)}</td></tr><tr class="tot"><td>合計</td><td class="r">${yen(total)}</td></tr></table></div>
   <div class="card"><b>交通費の内訳</b><table class="table">${tRows.map(r=>`<tr><td>${esc(r[0])}</td><td class="r">${yen(r[1])}</td></tr>`).join('')||'<tr><td class="small">場所が決まった区間がありません</td><td></td></tr>'}</table>
   <div class="small" style="margin-top:6px">車：Googleのルート距離×燃費${num(S.trip.fuelEff)||13}km/L×ガソリン${num(S.trip.fuelPrice)||175}円/L＋Googleの高速料金。公共交通：Googleの運賃（日本では出ないことが多く、その場合は距離からの目安）×人数。⚙️で変更できます。</div></div>
   ${rows.length?`<div class="card"><b>宿・予定の費用</b><table class="table">${rows.map(r=>`<tr><td>${esc(r[0])}</td><td class="r">${yen(r[1])}</td></tr>`).join('')}</table></div>`:''}
   <div class="card"><b>その他の費用</b><table class="table">${S.costs.map(c=>`<tr><td>${esc(c.label||'')}${c.per==='person'?`（${yen(num(c.amount))}×${M}人）`:''}</td><td class="r">${yen(c.per==='person'?num(c.amount)*M:num(c.amount))} <button class="lk" data-cedit="${esc(c.id)}">✏️</button></td></tr>`).join('')||'<tr><td class="small">レンタカー代・お土産などを追加</td><td></td></tr>'}</table>
   <button class="btn ghost" id="addCost" style="margin-top:8px">＋ 費用を追加</button></div>`;
  v.querySelectorAll('[data-cedit]').forEach(b=>b.onclick=()=>openCost(S.costs.find(x=>x.id===b.dataset.cedit)));
  $('#addCost').onclick=()=>openCost(null);
}

/* ---------- bookings ---------- */
function renderBook(v){
  const list=[];
  S.stays.forEach(s=>{ if(s.booking) list.push({icon:'🏨',label:s.name,num:s.booking,sub:s.checkin?fmtDate(s.checkin)+' IN':''}); });
  S.items.forEach(i=>{ if(i.booking) list.push({icon:'📌',label:i.title,num:i.booking,sub:(i.day?fmtDate(i.day):'')+' '+(i.time||'')}); });
  S.bookings.forEach(b=>list.push({icon:'🎫',label:b.label,num:b.number,sub:b.date?fmtDate(b.date):'',note:b.note,id:b.id}));
  let h=list.length?'':'<div class="empty">予約番号はまだありません。<br>宿・予定に入れた予約番号もここにまとまります。</div>';
  list.forEach((b,i)=>h+=`<div class="card"><div class="bkrow"><div style="flex:1;min-width:0"><div class="small">${b.icon} ${esc(b.label||'')} ${esc(b.sub||'')}</div><div class="n">${esc(b.num||'')}</div>${b.note?`<div class="small" style="white-space:pre-wrap">${esc(b.note)}</div>`:''}</div>
    <button class="lk" data-copy="${i}">コピー</button>${b.id?`<button class="lk" data-bedit="${esc(b.id)}">✏️</button>`:''}</div></div>`);
  h+=`<button class="btn" id="addBk" style="margin-top:10px">＋ 予約メモを追加</button><div class="small" style="margin-top:6px">飛行機・新幹線・レンタカーなど、宿や予定に紐づかない予約はここへ。</div>`;
  v.innerHTML=h;
  v.querySelectorAll('[data-copy]').forEach(b=>b.onclick=()=>copyText(list[+b.dataset.copy].num));
  v.querySelectorAll('[data-bedit]').forEach(b=>b.onclick=()=>openBooking(S.bookings.find(x=>x.id===b.dataset.bedit)));
  $('#addBk').onclick=()=>openBooking(null);
}

/* ================= sheets & forms ================= */
function openSheet(html){ $('#sheet').innerHTML=html; $('#sheet').classList.add('open'); $('#sheetBg').classList.add('open'); $('#sheet').scrollTop=0; }
function closeSheet(){ $('#sheet').classList.remove('open'); $('#sheetBg').classList.remove('open'); }
$('#sheetBg').onclick=closeSheet;
const fld=(id,label,val,type='text',extra='')=>`<div class="f"><label for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(val??'')}" ${extra}></div>`;
const area=(id,label,val)=>`<div class="f"><label for="${id}">${label}</label><textarea id="${id}">${esc(val??'')}</textarea></div>`;
const sel=(id,label,val,opts)=>`<div class="f"><label for="${id}">${label}</label><select id="${id}">${opts.map(([v,t])=>`<option value="${v}" ${String(val??'')===v?'selected':''}>${t}</option>`).join('')}</select></div>`;
const gv=id=>{ const e=document.getElementById(id); return e?e.value.trim():''; };
const setv=(id,v)=>{ const e=document.getElementById(id); if(e&&v!=null&&v!=='') e.value=v; };
const dayOptions=()=>[['','日付未定'],...tripDays().map((d,i)=>[d,`${i+1}日目 ${fmtDate(d)}`])];
const col = name => F.collection(db,`trips/${S.tripId}/${name}`);
const dref = (name,id) => F.doc(db,`trips/${S.tripId}/${name}/${id}`);

// Googleで場所を検索して、フォームに入れる
function searchBlock(kind){
  const g=!!CFG.mapsApiKey;
  return `<div class="ai">🔎 <b>${g?'Googleで':'地図で'}${kind==='stay'?'宿':'場所'}を検索</b><span class="small">（${g?`住所・地図の位置・写真${kind==='stay'?'・電話・公式サイト・評価':''}`:'住所と地図の位置'}を自動で入れます）</span>
    <div class="row2" style="margin-top:6px"><input id="q" placeholder="${kind==='stay'?'例：ホテルグランヴィア京都':'例：清水寺'}" style="border:1px solid var(--line);border-radius:10px;padding:9px 10px;flex:3"><button class="btn" id="qBtn" type="button" style="flex:1;margin:0">検索</button></div>
    <div id="qRes"></div><div class="status" id="qSt"></div></div><input type="hidden" id="f_place_json">`;
}
function bindSearch(kind, onPick){
  const b=$('#qBtn'); if(!b) return;
  const go=async()=>{ const q=gv('q'); if(!q) return; const dest=S.trip.destination||''; $('#qSt').textContent='検索中…'; $('#qRes').innerHTML='';
    try{ const r=await placesSearch(dest&&!q.includes(dest)?`${q} ${dest}`:q); const r2 = r.length? r : await placesSearch(q);
      $('#qSt').textContent=r2.length?'選んでください':'見つかりませんでした。名前を変えて試してください。';
      $('#qRes').innerHTML=r2.map((p,i)=>`<div class="res">${p.photoUrl?`<img src="${esc(p.photoUrl)}" alt="" referrerpolicy="no-referrer">`:'<div class="noimg">📍</div>'}<div class="bd"><b>${esc(p.name)}</b>${p.rating?` ★${p.rating}`:''}<div class="small">${esc(p.address)}</div><button class="lk pri" data-pick="${i}" type="button" style="margin-top:4px">これにする</button></div></div>`).join('');
      $('#qRes').querySelectorAll('[data-pick]').forEach(x=>x.onclick=()=>{ const p=r2[+x.dataset.pick]; $('#f_place_json').value=JSON.stringify(p); onPick(p); $('#qRes').innerHTML=''; $('#qSt').textContent=`「${p.name}」の情報を入れました`; });
    }catch(e){ console.error(e); $('#qSt').textContent='検索できませんでした（APIキーやPlaces APIの設定を確認してください）'; }
  };
  b.onclick=go; $('#q').onkeydown=e=>{ if(e.key==='Enter'){ e.preventDefault(); go(); } };
}
const picked = () => { try{ return JSON.parse(gv('f_place_json')||'null'); }catch(e){ return null; } };
const placeFields = p => p? {placeId:p.placeId, lat:p.lat, lng:p.lng, photoUrl:p.photoUrl, photoAttr:p.photoAttr, rating:p.rating, ratingCount:p.ratingCount, gmapsUrl:p.gmapsUrl} : {};

function llManual(o){ return `<details style="margin:6px 0"><summary class="small">位置を手で入れる</summary>${fld('f_ll','座標（緯度,経度）またはGoogleマップのURL',hasLL(o)?`${o.lat},${o.lng}`:'')}</details>`; }
function readManualLL(){ const t=gv('f_ll'); if(!t) return undefined; return parseLL(t) || null; }

function openItem(it){
  const isNew=!it; it=it||{day:S.day??''};
  openSheet(`<h2>${isNew?'予定を追加':'予定を編集'}</h2>${searchBlock('item')}
    ${sel('f_day','日付',it.day||'',dayOptions())}${fld('f_time','時刻',it.time,'time')}
    ${fld('f_title','タイトル',it.title)}${fld('f_place','場所・住所',it.place)}${llManual(it)}
    ${sel('f_mode','ここへの移動手段',it.mode||'',[['','自動で選ぶ'],['walk','徒歩'],['transit','公共交通'],['car','車']])}
    <div class="row2">${fld('f_cost','費用（円）',it.cost,'text','inputmode="numeric"')}${sel('f_per','単位',it.costPer||'total',[['total','全体で'],['person','1人あたり']])}</div>
    ${fld('f_booking','予約番号',it.booking)}${fld('f_url','リンク',it.url,'url')}${area('f_memo','メモ',it.memo)}
    <div class="status" id="saveStatus"></div>
    <div class="row2" style="margin-top:10px"><button class="btn" id="saveBtn">保存</button><button class="btn ghost" id="cancelBtn">閉じる</button></div>
    ${isNew?'':'<button class="btn warn" id="delBtn" style="margin-top:10px">この予定を削除</button>'}`);
  $('#cancelBtn').onclick=closeSheet;
  bindSearch('item',p=>{ if(!gv('f_title')) setv('f_title',p.name); document.getElementById('f_place').value=p.address||p.name; if(p.url&&!gv('f_url')) setv('f_url',p.url); });
  $('#saveBtn').onclick=async()=>{
    const p=picked(); const ll=readManualLL(); if(ll===null){ $('#saveStatus').textContent='座標の形式が読み取れません'; return; }
    const d={day:gv('f_day'),time:gv('f_time'),title:gv('f_title'),place:gv('f_place'),mode:gv('f_mode'),cost:gv('f_cost'),costPer:gv('f_per'),booking:gv('f_booking'),url:gv('f_url'),memo:gv('f_memo'),...placeFields(p)};
    if(ll) { d.lat=ll.lat; d.lng=ll.lng; }
    if(!d.title){ $('#saveStatus').textContent='タイトルを入れてください'; return; }
    if(isNew){ const l=S.items.filter(i=>(i.day||'')===d.day); d.order=l.length?Math.max(...l.map(i=>i.order??0))+1:0; }
    await saveDoc('items',it.id,d);
  };
  if(!isNew) $('#delBtn').onclick=()=>confirmDel('items',it.id,'この予定');
}
function openStay(s){
  const isNew=!s; const days=tripDays(); s=s||{checkin:days[0]||'',checkout:days[1]||''};
  openSheet(`<h2>${isNew?'宿を追加':'宿を編集'}</h2>${searchBlock('stay')}
    ${fld('f_name','宿の名前',s.name)}${fld('f_address','住所',s.address)}${llManual(s)}
    <div class="row2">${fld('f_in','チェックイン日',s.checkin,'date')}${fld('f_out','チェックアウト日',s.checkout,'date')}</div>
    <div class="row2">${fld('f_intime','IN時刻',s.inTime,'text','placeholder="15:00"')}${fld('f_outtime','OUT時刻',s.outTime,'text','placeholder="10:00"')}</div>
    ${fld('f_price','料金（合計・円）',s.price,'text','inputmode="numeric"')}${fld('f_booking','予約番号',s.booking)}
    ${fld('f_phone','電話番号',s.phone,'tel')}${fld('f_url','公式サイト',s.url,'url')}${fld('f_bookurl','予約ページ（楽天・じゃらん等）',s.bookUrl,'url')}
    ${area('f_memo','メモ（駐車場、夕食の時間など）',s.memo)}
    <div class="status" id="saveStatus"></div>
    <div class="row2" style="margin-top:10px"><button class="btn" id="saveBtn">保存</button><button class="btn ghost" id="cancelBtn">閉じる</button></div>
    ${isNew?'':'<button class="btn warn" id="delBtn" style="margin-top:10px">この宿を削除</button>'}`);
  $('#cancelBtn').onclick=closeSheet;
  bindSearch('stay',p=>{ document.getElementById('f_name').value=p.name; document.getElementById('f_address').value=p.address; if(p.phone) document.getElementById('f_phone').value=p.phone; if(p.url) document.getElementById('f_url').value=p.url; });
  $('#saveBtn').onclick=async()=>{
    const p=picked(); const ll=readManualLL(); if(ll===null){ $('#saveStatus').textContent='座標の形式が読み取れません'; return; }
    const d={name:gv('f_name'),address:gv('f_address'),checkin:gv('f_in'),checkout:gv('f_out'),inTime:gv('f_intime'),outTime:gv('f_outtime'),price:gv('f_price'),booking:gv('f_booking'),phone:gv('f_phone'),url:gv('f_url'),bookUrl:gv('f_bookurl'),memo:gv('f_memo'),...placeFields(p)};
    if(ll){ d.lat=ll.lat; d.lng=ll.lng; }
    if(!d.name){ $('#saveStatus').textContent='宿の名前を入れてください'; return; }
    if(d.checkin&&d.checkout&&d.checkout<=d.checkin){ $('#saveStatus').textContent='チェックアウト日はチェックイン日より後にしてください'; return; }
    await saveDoc('stays',s.id,d);
  };
  if(!isNew) $('#delBtn').onclick=()=>confirmDel('stays',s.id,'この宿');
}
function openCost(c){ const isNew=!c; c=c||{};
  openSheet(`<h2>${isNew?'費用を追加':'費用を編集'}</h2>${fld('f_label','項目',c.label)}<div class="row2">${fld('f_amount','金額（円）',c.amount,'text','inputmode="numeric"')}${sel('f_per','単位',c.per||'total',[['total','全体で'],['person','1人あたり']])}</div>
    <div class="status" id="saveStatus"></div><div class="row2" style="margin-top:10px"><button class="btn" id="saveBtn">保存</button><button class="btn ghost" id="cancelBtn">閉じる</button></div>${isNew?'':'<button class="btn warn" id="delBtn" style="margin-top:10px">削除</button>'}`);
  $('#cancelBtn').onclick=closeSheet;
  $('#saveBtn').onclick=()=>{ const d={label:gv('f_label'),amount:gv('f_amount'),per:gv('f_per')}; if(!d.label){$('#saveStatus').textContent='項目名を入れてください';return;} saveDoc('costs',c.id,d); };
  if(!isNew) $('#delBtn').onclick=()=>confirmDel('costs',c.id,'この費用');
}
function openBooking(b){ const isNew=!b; b=b||{};
  openSheet(`<h2>${isNew?'予約メモを追加':'予約メモを編集'}</h2>${fld('f_label','内容（例：行きの新幹線 のぞみ21号）',b.label)}${fld('f_number','予約番号',b.number)}${fld('f_date','日付',b.date,'date')}${area('f_note','メモ',b.note)}
    <div class="status" id="saveStatus"></div><div class="row2" style="margin-top:10px"><button class="btn" id="saveBtn">保存</button><button class="btn ghost" id="cancelBtn">閉じる</button></div>${isNew?'':'<button class="btn warn" id="delBtn" style="margin-top:10px">削除</button>'}`);
  $('#cancelBtn').onclick=closeSheet;
  $('#saveBtn').onclick=()=>{ const d={label:gv('f_label'),number:gv('f_number'),date:gv('f_date'),note:gv('f_note')}; if(!d.label&&!d.number){$('#saveStatus').textContent='内容か予約番号を入れてください';return;} saveDoc('bookings',b.id,d); };
  if(!isNew) $('#delBtn').onclick=()=>confirmDel('bookings',b.id,'この予約メモ');
}
async function saveDoc(name,id,data){
  const sb=$('#saveBtn'); sb.disabled=true; $('#saveStatus').textContent='保存中…';
  Object.keys(data).forEach(k=>{ if(data[k]===undefined) delete data[k]; });
  data.updatedAt=Date.now(); data.updatedBy=S.user.uid;
  try{
    if(id) await F.updateDoc(dref(name,id),data);
    else await F.addDoc(col(name),{...data,createdAt:Date.now()});
    closeSheet(); toast('保存しました');
  }catch(e){ showErr(e); sb.disabled=false; }
}
function confirmDel(name,id,label){
  openSheet(`<h2>${label}を削除しますか？</h2><p class="small">メンバー全員の画面から消えます。元に戻せません。</p><div class="status" id="saveStatus"></div>
    <div class="row2"><button class="btn warn" id="yesDel">削除する</button><button class="btn ghost" id="noDel">やめる</button></div>`);
  $('#noDel').onclick=closeSheet;
  $('#yesDel').onclick=async()=>{ try{ await F.deleteDoc(dref(name,id)); closeSheet(); toast('削除しました'); }catch(e){ showErr(e); } };
}
function showErr(e){ console.error(e); const st=$('#saveStatus'); const m = e&&e.code==='permission-denied' ? 'この旅行を編集する権限がありません。' : '保存できませんでした。電波を確認してもう一度お試しください。'; if(st) st.textContent=m; else toast(m); }
async function moveItem(id,dir){
  const it=S.items.find(x=>x.id===id); if(!it) return; const list=itemsOf(it.day||''); const i=list.findIndex(x=>x.id===id), j=i+dir; if(j<0||j>=list.length) return;
  const arr=[...list]; [arr[i],arr[j]]=[arr[j],arr[i]];
  try{ const b=F.writeBatch(db); arr.forEach((x,k)=>{ if((x.order??-1)!==k) b.update(dref('items',x.id),{order:k}); }); await b.commit(); }catch(e){ toast('並べ替えできませんでした'); }
}

/* ---------- recommend ---------- */
function openRecommend(){
  const dest=S.trip.destination||'';
  openSheet(`<h2>✨ おすすめを探す</h2><p class="small" style="margin:0">Googleマップの情報から探します。「追加」で${S.day?fmtDate(S.day):'日付未定'}の予定に入ります。</p>
    <div class="days" style="margin-top:8px">${['観光スポット','グルメ','カフェ','温泉','お土産','夜景'].map(k=>`<button class="chip" data-k="${k}">${k}</button>`).join('')}</div>
    <div class="row2"><input id="rq" value="${esc(dest?dest+' 観光スポット':'')}" placeholder="例：京都 観光スポット" style="border:1px solid var(--line);border-radius:10px;padding:9px 10px;flex:3"><button class="btn" id="rqBtn" style="flex:1">検索</button></div>
    <div id="rRes"></div><div class="status" id="rSt"></div><button class="btn ghost" id="cancelBtn" style="margin-top:8px">閉じる</button>`);
  $('#cancelBtn').onclick=closeSheet;
  const go=async()=>{ const q=gv('rq'); if(!q) return; $('#rSt').textContent='検索中…'; $('#rRes').innerHTML='';
    try{ const r=await placesSearch(q); $('#rSt').textContent=r.length?'':'見つかりませんでした';
      $('#rRes').innerHTML=r.map((p,i)=>`<div class="res">${p.photoUrl?`<img src="${esc(p.photoUrl)}" alt="" referrerpolicy="no-referrer">`:'<div class="noimg">📍</div>'}<div class="bd"><b>${esc(p.name)}</b>${p.rating?` ★${p.rating}（${p.ratingCount||0}）`:''}<div class="small">${esc(p.address)}</div>
        <div class="links"><button class="lk pri" data-add="${i}">追加</button><a class="lk" href="${esc(p.gmapsUrl||gmapsPoint(p))}" target="_blank" rel="noopener">詳しく↗</a></div></div></div>`).join('');
      $('#rRes').querySelectorAll('[data-add]').forEach(x=>x.onclick=async()=>{ const p=r[+x.dataset.add]; x.disabled=true; const day=S.day??''; const l=S.items.filter(i=>(i.day||'')===day);
        try{ await F.addDoc(col('items'),{day,time:'',title:p.name,place:p.address,mode:'',cost:'',costPer:'total',booking:'',url:p.url||'',memo:'',...placeFields(p),order:l.length?Math.max(...l.map(i=>i.order??0))+1:0,createdAt:Date.now(),updatedAt:Date.now(),updatedBy:S.user.uid}); x.textContent='追加済み'; }catch(e){ x.disabled=false; showErr(e); } });
    }catch(e){ $('#rSt').textContent='検索できませんでした'; } };
  $('#rqBtn').onclick=go; document.querySelectorAll('#sheet [data-k]').forEach(c=>c.onclick=()=>{ $('#rq').value=`${dest} ${c.dataset.k}`.trim(); go(); });
}

/* ---------- optimize ---------- */
function optimizeDay(day){
  const list=itemsOf(day), seq=sequence(day);
  const start=seq[0]?.kind==='stayStart'?seq[0]:null, end=seq[seq.length-1]?.kind==='stayEnd'?seq[seq.length-1]:null;
  const pts=list.filter(hasLL), noLL=list.filter(x=>!hasLL(x));
  if(pts.length<2){ openSheet(`<h2>順番の最適化</h2><p>場所が決まった予定が2つ以上必要です。</p><button class="btn ghost" id="cancelBtn">閉じる</button>`); $('#cancelBtn').onclick=closeSheet; return; }
  const cost=o=>{ let s=0,p=start; o.forEach(x=>{ if(p) s+=hav(p,x); p=x; }); if(end&&p) s+=hav(p,end); return s; };
  const head=start?[]:[pts[0]], free=start?pts.slice():pts.slice(1); let best=null,bc=Infinity;
  if(free.length<=7){ const perm=(a,l=0)=>{ if(l===a.length){ const o=[...head,...a],c=cost(o); if(c<bc){bc=c;best=o;} return; } for(let i=l;i<a.length;i++){ [a[l],a[i]]=[a[i],a[l]]; perm(a,l+1); [a[l],a[i]]=[a[i],a[l]]; } }; perm(free.slice()); }
  else { let cur=head[0]||start; const rest=free.slice(), o=[...head]; while(rest.length){ let bi=0,bd=Infinity; rest.forEach((p,i)=>{ const d=cur?hav(cur,p):0; if(d<bd){bd=d;bi=i;} }); cur=rest.splice(bi,1)[0]; o.push(cur); }
    best=o; bc=cost(o); let imp=true; while(imp){ imp=false; for(let i=head.length;i<best.length-1;i++) for(let k=i+1;k<best.length;k++){ const n=[...best.slice(0,i),...best.slice(i,k+1).reverse(),...best.slice(k+1)],c=cost(n); if(c<bc-1e-9){best=n;bc=c;imp=true;} } } }
  const cc=cost(pts), same=best.every((p,i)=>p.id===pts[i].id);
  openSheet(`<h2>🧭 順番の最適化</h2><p class="small">${start?`出発：🏨${esc(start.name)}　`:`出発：${esc(pts[0].title)}（固定）　`}${end?`到着：🏨${esc(end.name)}`:''}</p>
    ${same?'<div class="banner info">今の順番がいちばん移動が短いです 👍</div>':`<div class="banner info">約 <b>${fmtKm((cc-bc)*1.3)}</b> 短くなります（${fmtKm(cc*1.3)} → ${fmtKm(bc*1.3)}）</div>
    <ol>${best.map(p=>`<li>${esc(p.title)} <span class="small">${esc(p.time||'')}</span></li>`).join('')}</ol><p class="small">※営業時間や予約時刻は考慮していません。</p><button class="btn" id="applyOpt">この順番にする</button>`}
    <button class="btn ghost" id="cancelBtn" style="margin-top:8px">閉じる</button>`);
  $('#cancelBtn').onclick=closeSheet;
  const ap=$('#applyOpt'); if(ap) ap.onclick=async()=>{ ap.disabled=true; try{ const b=F.writeBatch(db); [...best,...noLL].forEach((x,k)=>b.update(dref('items',x.id),{order:k})); await b.commit(); closeSheet(); toast('順番を更新しました'); }catch(e){ ap.disabled=false; toast('更新できませんでした'); } };
}

/* ================= trips, members, invites ================= */
function openTrips(){
  openSheet(`<h2>旅行の一覧</h2>${S.trips.map(t=>`<button class="card" data-trip="${esc(t.id)}" style="display:block;width:100%;text-align:left;cursor:pointer;${t.id===S.tripId?'border:2px solid var(--accent)':''}"><b>${esc(t.title||'無題の旅行')}</b><div class="small">${t.start?fmtDate(t.start)+'〜'+fmtDate(t.end):'日程未定'}${t.destination?'・'+esc(t.destination):''}</div></button>`).join('')||'<p class="small">まだ旅行がありません</p>'}
    <button class="btn" id="newTrip" style="margin-top:8px">＋ 新しい旅行を作る</button>
    <div class="small" style="margin-top:14px">${esc(S.user.displayName||'')}（${esc(S.user.email||'')}）でログイン中</div>
    <button class="btn ghost" id="logout" style="margin-top:6px">ログアウト</button><button class="btn ghost" id="cancelBtn" style="margin-top:6px">閉じる</button>`);
  $('#cancelBtn').onclick=closeSheet; $('#newTrip').onclick=openNewTrip;
  $('#logout').onclick=async()=>{ await F.signOut(auth); closeSheet(); };
  document.querySelectorAll('#sheet [data-trip]').forEach(b=>b.onclick=()=>{ selectTrip(b.dataset.trip); closeSheet(); });
}
function openNewTrip(){
  openSheet(`<h2>新しい旅行</h2>${fld('n_title','タイトル','','text','placeholder="例：冬の京都旅行"')}${fld('n_dest','行き先','','text','placeholder="例：京都"')}
    <div class="row2">${fld('n_start','出発日','','date')}${fld('n_end','帰る日','','date')}</div>
    ${sel('n_mode','主な移動手段','mixed',[['mixed','公共交通と車の両方'],['transit','公共交通メイン'],['car','車メイン']])}
    <div class="status" id="saveStatus"></div><button class="btn" id="createBtn" style="margin-top:10px">作成する</button><button class="btn ghost" id="cancelBtn" style="margin-top:8px">閉じる</button>`);
  $('#cancelBtn').onclick=closeSheet;
  $('#createBtn').onclick=async()=>{
    const d={title:gv('n_title')||(gv('n_dest')?gv('n_dest')+'旅行':'新しい旅行'),destination:gv('n_dest'),start:gv('n_start'),end:gv('n_end'),mainMode:gv('n_mode'),headcount:'',fuelPrice:'175',fuelEff:'13',notes:'',
      owner:S.user.uid, members:[S.user.uid], memberInfo:{[S.user.uid]:me()}, inviteCode:randCode(), createdAt:Date.now(), updatedAt:Date.now()};
    if(d.start&&d.end&&d.end<d.start){ $('#saveStatus').textContent='帰る日は出発日以降にしてください'; return; }
    $('#createBtn').disabled=true;
    try{ const r=await F.addDoc(F.collection(db,'trips'),d); closeSheet(); S.pendingSelect=r.id; selectTrip(r.id,{id:r.id,...d}); toast('作成しました。宿や予定を追加しましょう'); }
    catch(e){ showErr(e); $('#createBtn').disabled=false; }
  };
}
const me = () => ({name:S.user.displayName||S.user.email||'メンバー', photo:S.user.photoURL||''});
const inviteUrl = () => `${appUrl()}?join=${encodeURIComponent(S.tripId)}&code=${encodeURIComponent(S.trip.inviteCode||'')}`;
const lineUrl = t => 'https://line.me/R/share?text='+encodeURIComponent(t);
function itineraryText(){
  const t=S.trip, days=tripDays(), L=['🧳 '+(t.title||'旅行')];
  if(days.length) L.push(`${fmtDate(days[0])}〜${fmtDate(days[days.length-1])}（${days.length-1}泊${days.length}日）`);
  (days.length?days:['']).forEach((d,i)=>{ const l=itemsOf(d), tn=d?stayFor(d):null; if(!l.length&&!tn) return; L.push('',d?`■ ${i+1}日目 ${fmtDate(d)}`:'■ 日付未定'); l.forEach(x=>L.push(`${x.time?x.time+' ':'・'}${x.title||''}`)); if(tn) L.push(`🏨 ${tn.name}${tn.inTime?'（IN '+tn.inTime+'）':''}`); });
  return L.join('\n');
}
function openShare(){
  if(!S.tripId) return;
  const inv=`「${S.trip.title||'旅行'}」の旅しおりに招待します！Googleアカウントでログインすると、旅程・宿・予約番号が見られて一緒に編集できます👇\n${inviteUrl()}`;
  const txt=itineraryText();
  openSheet(`<h2>LINEで送る</h2>
    <div class="card"><b>① 同行メンバーを招待する</b><p class="small" style="margin:4px 0 8px">このリンクを開いてログインした人だけが、この旅行に参加できます。ほかの旅行は見えません。</p>
      <a class="btn" style="display:block;text-align:center;text-decoration:none;background:#06c755" href="${lineUrl(inv)}" target="_blank" rel="noopener">LINEで招待リンクを送る</a><button class="btn ghost" id="cpInv" style="margin-top:6px">招待リンクをコピー</button></div>
    <div class="card"><b>② 旅程をテキストで送る</b><p class="small" style="margin:4px 0 8px">アプリを使わない人向けに、旅程をメッセージで送ります（招待にはなりません）。</p>
      <textarea readonly style="width:100%;min-height:130px;border:1px solid var(--line);border-radius:10px;padding:8px;font-size:12.5px">${esc(txt)}</textarea>
      <a class="btn" style="display:block;text-align:center;text-decoration:none;background:#06c755;margin-top:6px" href="${lineUrl(txt)}" target="_blank" rel="noopener">LINEで旅程を送る</a></div>
    <button class="btn ghost" id="cancelBtn">閉じる</button>`);
  $('#cancelBtn').onclick=closeSheet; $('#cpInv').onclick=()=>copyText(inviteUrl());
}
function openSettings(){
  if(!S.tripId){ openTrips(); return; }
  const t=S.trip, isOwner=t.owner===S.user.uid, mi=t.memberInfo||{};
  const avatars=(t.members||[]).map(u=>{ const m=mi[u]||{}; return `<div class="av">${m.photo?`<img src="${esc(m.photo)}" alt="" referrerpolicy="no-referrer">`:`<span class="i">${esc((m.name||'?').slice(0,1))}</span>`}${esc(m.name||'メンバー')}${u===t.owner?'（作成者）':''}${isOwner&&u!==t.owner?` <button class="lk" data-rm="${esc(u)}" style="padding:0 6px">外す</button>`:''}</div>`; }).join('');
  openSheet(`<h2>旅行の設定</h2>${fld('t_title','タイトル',t.title)}${fld('t_dest','行き先',t.destination)}
    <div class="row2">${fld('t_start','出発日',t.start,'date')}${fld('t_end','帰る日',t.end,'date')}</div>
    ${fld('t_head',`人数（空欄ならメンバー数 ${(t.members||[]).length}人）`,t.headcount,'number','min="1"')}
    ${sel('t_mode','主な移動手段',t.mainMode||'mixed',[['mixed','公共交通と車の両方'],['transit','公共交通メイン'],['car','車メイン']])}
    <div class="row2">${fld('t_fuel','ガソリン（円/L）',t.fuelPrice||175,'number')}${fld('t_eff','燃費（km/L）',t.fuelEff||13,'number')}</div>
    ${area('t_notes','緊急連絡先・共有メモ',t.notes)}
    <div class="status" id="saveStatus"></div><button class="btn" id="saveBtn">保存</button>
    <h3 style="margin:18px 0 6px;font-size:15px">メンバー</h3><div class="avatars">${avatars}</div>
    <button class="btn ghost" id="shareBtn" style="margin-top:8px">＋ メンバーを招待（LINE）</button>
    ${isOwner?'<button class="btn ghost" id="resetInv" style="margin-top:6px">招待リンクを作り直す（古いリンクは使えなくなります）</button>':''}
    <button class="btn ghost" id="backupBtn" style="margin-top:14px">📋 データをコピー（バックアップ）</button>
    ${isOwner?'<button class="btn warn" id="delTrip" style="margin-top:8px">この旅行を削除</button>':'<button class="btn warn" id="leaveTrip" style="margin-top:8px">この旅行から抜ける</button>'}
    <button class="btn ghost" id="cancelBtn" style="margin-top:8px">閉じる</button>`);
  $('#cancelBtn').onclick=closeSheet; $('#shareBtn').onclick=openShare;
  $('#saveBtn').onclick=async()=>{ const d={title:gv('t_title'),destination:gv('t_dest'),start:gv('t_start'),end:gv('t_end'),headcount:gv('t_head'),mainMode:gv('t_mode'),fuelPrice:gv('t_fuel'),fuelEff:gv('t_eff'),notes:gv('t_notes'),updatedAt:Date.now()};
    if(d.start&&d.end&&d.end<d.start){ $('#saveStatus').textContent='帰る日は出発日以降にしてください'; return; }
    try{ $('#saveBtn').disabled=true; await F.updateDoc(F.doc(db,'trips',S.tripId),d); S.day=null; closeSheet(); toast('保存しました'); }catch(e){ showErr(e); $('#saveBtn').disabled=false; } };
  document.querySelectorAll('#sheet [data-rm]').forEach(b=>b.onclick=async()=>{ const u=b.dataset.rm; try{ await F.updateDoc(F.doc(db,'trips',S.tripId),{members:F.arrayRemove(u),['memberInfo.'+u]:F.deleteField()}); toast('メンバーを外しました'); closeSheet(); }catch(e){ showErr(e); } });
  const ri=$('#resetInv'); if(ri) ri.onclick=async()=>{ try{ await F.updateDoc(F.doc(db,'trips',S.tripId),{inviteCode:randCode()}); toast('招待リンクを作り直しました'); }catch(e){ showErr(e); } };
  $('#backupBtn').onclick=()=>copyText(JSON.stringify({trip:{...S.trip,inviteCode:undefined},stays:S.stays,items:S.items,costs:S.costs,bookings:S.bookings},null,1));
  const lv=$('#leaveTrip'); if(lv) lv.onclick=()=>{ openSheet(`<h2>この旅行から抜けますか？</h2><p class="small">もう一度参加するには招待リンクが必要です。</p><div class="row2"><button class="btn warn" id="yes">抜ける</button><button class="btn ghost" id="no">やめる</button></div>`);
    $('#no').onclick=closeSheet; $('#yes').onclick=async()=>{ try{ const id=S.tripId; leaveTripView(); await F.updateDoc(F.doc(db,'trips',id),{members:F.arrayRemove(S.user.uid),['memberInfo.'+S.user.uid]:F.deleteField()}); closeSheet(); toast('抜けました'); }catch(e){ toast('できませんでした'); } }; };
  const dt=$('#delTrip'); if(dt) dt.onclick=()=>{ openSheet(`<h2>「${esc(t.title||'この旅行')}」を削除しますか？</h2><p class="small">予定・宿・費用・予約もすべて消え、メンバー全員の画面からなくなります。元に戻せません。</p><div class="status" id="saveStatus"></div><div class="row2"><button class="btn warn" id="yes">削除する</button><button class="btn ghost" id="no">やめる</button></div>`);
    $('#no').onclick=closeSheet; $('#yes').onclick=async()=>{ $('#yes').disabled=true; try{ const id=S.tripId;
      for(const k of ['items','stays','costs','bookings']) for(const o of S[k]) await F.deleteDoc(dref(k,o.id));
      for(const k of Object.keys(S.routes)) await F.deleteDoc(dref('routes',k));
      leaveTripView(); await F.deleteDoc(F.doc(db,'trips',id)); closeSheet(); toast('削除しました'); }catch(e){ showErr(e); $('#yes').disabled=false; } }; };
}
function leaveTripView(){ S.unsubs.forEach(u=>{try{u();}catch(e){}}); S.unsubs=[]; S.tripId=null; S.trip={}; S.items=[];S.stays=[];S.costs=[];S.bookings=[];S.routes={}; try{localStorage.removeItem('lastTrip');}catch(e){} render(); }

function selectTrip(id, initial){
  if(S.tripId===id){ render(); return; }
  S.unsubs.forEach(u=>{try{u();}catch(e){}}); S.unsubs=[];
  S.tripId=id; S.trip=S.trips.find(t=>t.id===id)||initial||{}; S.items=[];S.stays=[];S.costs=[];S.bookings=[];S.routes={}; S.day=null; S.mapDay='all'; S.tab='plan';
  try{ localStorage.setItem('lastTrip',id); }catch(e){}
  ['items','stays','costs','bookings'].forEach(k=>S.unsubs.push(F.onSnapshot(col(k),s=>{ S[k]=s.docs.map(d=>({id:d.id,...d.data()})); render(); },e=>console.warn(k,e))));
  S.unsubs.push(F.onSnapshot(col('routes'),s=>{ const o={}; s.docs.forEach(d=>o[d.id]=d.data()); S.routes=o; render(); },e=>console.warn('routes',e)));
  render(); scrollTo(0,0);
}

async function handleJoin(){
  const p=new URLSearchParams(location.search); let j=p.get('join'), c=p.get('code');
  if(!j){ try{ const s=JSON.parse(sessionStorage.getItem('pendingJoin')||'null'); if(s){ j=s.j; c=s.c; } }catch(e){} }
  if(!j||!c) return;
  try{ sessionStorage.removeItem('pendingJoin'); }catch(e){}
  history.replaceState(null,'',location.pathname+location.hash);
  try{ await F.updateDoc(F.doc(db,'trips',j),{members:F.arrayUnion(S.user.uid), lastJoinCode:c, ['memberInfo.'+S.user.uid]:me()}); S.pendingSelect=j; toast('旅行に参加しました！'); }
  catch(e){ console.warn(e); $('#notice').innerHTML='<div class="banner">招待リンクが無効です。リンクが作り直された可能性があります。招待した人に新しいリンクをもらってください。</div>'; }
}

/* ================= login ================= */
function renderLogin(msg){
  $('#hdr').classList.add('hidden'); $('#tabs').classList.add('hidden');
  const joining = new URLSearchParams(location.search).get('join');
  $('#view').innerHTML=`<div class="login"><img src="icon-192.png" alt=""><h1 style="margin:0;font-size:24px">旅しおり</h1>
    <p class="small" style="margin:0">${joining?'旅行に招待されています。Googleアカウントでログインすると参加できます。':'旅行ごとに、同行メンバーだけで旅程を共有するアプリです。'}</p>
    <button class="gbtn" id="gLogin"><svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C36.9 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>Googleでログイン</button>
    <div class="status" id="lSt">${esc(msg||'')}</div></div>`;
  $('#gLogin').onclick=async()=>{
    const p=new URLSearchParams(location.search); if(p.get('join')){ try{ sessionStorage.setItem('pendingJoin',JSON.stringify({j:p.get('join'),c:p.get('code')})); }catch(e){} }
    const prov=new F.GoogleAuthProvider(); prov.setCustomParameters({prompt:'select_account'});
    try{ await F.signInWithPopup(auth,prov); }
    catch(e){ if(e&&(e.code==='auth/popup-blocked'||e.code==='auth/operation-not-supported-in-this-environment'||e.code==='auth/cancelled-popup-request')){ try{ await F.signInWithRedirect(auth,prov); }catch(e2){ $('#lSt').textContent='ログインできませんでした。SafariやChromeで開いてお試しください。'; } }
      else if(e&&e.code==='auth/unauthorized-domain') $('#lSt').textContent='このURLがFirebaseで許可されていません（承認済みドメインに追加してください）。';
      else if(e&&e.code!=='auth/popup-closed-by-user') $('#lSt').textContent='ログインできませんでした：'+(e.code||''); }
  };
}

/* ================= boot ================= */
document.querySelectorAll('#tabs button').forEach(b=>b.onclick=()=>{ S.tab=b.dataset.tab; render(); scrollTo(0,0); });
$('#btnSettings').onclick=openSettings; $('#btnShare').onclick=()=>S.tripId?openShare():toast('先に旅行を選んでください'); $('#tripTitle').onclick=openTrips;

(async function boot(){
  if(!CFG.firebase||!CFG.firebase.apiKey){ $('#view').innerHTML='<div class="card"><b>セットアップがまだです</b><p class="small">config.js にFirebaseの設定とGoogleマップのAPIキーを入れてください。</p></div>'; return; }
  const [app, A, Fs] = await Promise.all([import(FB+'firebase-app.js'), import(FB+'firebase-auth.js'), import(FB+'firebase-firestore.js')]);
  F = {...A, ...Fs};
  const fa = app.initializeApp(CFG.firebase);
  auth = A.getAuth(fa);
  try{ db = Fs.initializeFirestore(fa,{localCache:Fs.persistentLocalCache({tabManager:Fs.persistentMultipleTabManager()})}); }catch(e){ db = Fs.getFirestore(fa); }
  try{ await A.getRedirectResult(auth); }catch(e){}
  let tripsUnsub=null;
  A.onAuthStateChanged(auth, async u=>{
    if(tripsUnsub){ tripsUnsub(); tripsUnsub=null; }
    S.user=u;
    if(!u){ leaveTripView(); S.trips=[]; S.tripsLoaded=false; renderLogin(); return; }
    S.tripsLoaded=false; render();
    await handleJoin();
    tripsUnsub = F.onSnapshot(F.query(F.collection(db,'trips'),F.where('members','array-contains',u.uid)), s=>{
      S.trips=s.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.start||'').localeCompare(String(a.start||''))||(b.createdAt||0)-(a.createdAt||0));
      S.tripsLoaded=true;
      if(S.pendingSelect && S.trips.some(t=>t.id===S.pendingSelect)){ const id=S.pendingSelect; S.pendingSelect=null; selectTrip(id); }
      if(S.tripId){ const t=S.trips.find(x=>x.id===S.tripId); if(t) S.trip=t; else if(!s.metadata.fromCache && !S.pendingSelect) leaveTripView(); }
      if(!S.tripId && !S.pendingSelect && S.trips.length){
        let last=null; try{ last=localStorage.getItem('lastTrip'); }catch(e){}
        const t=todayStr(); const up=S.trips.filter(x=>(x.end||'9999')>=t).sort((a,b)=>String(a.start||'9999').localeCompare(String(b.start||'9999')));
        selectTrip(S.trips.some(x=>x.id===last)?last:(up[0]||S.trips[0]).id);
      }
      render();
    }, e=>{ console.error(e); $('#notice').innerHTML='<div class="banner">データを読み込めませんでした。Firestoreのルール設定を確認してください。</div>'; });
  });
})();
