export const VERSION='1.0.0';
export const COLORS=['#e34a33','#2878d0','#24a36a','#a958c6','#e09a24','#23a4aa'];
export const BONES=[['left_shoulder','right_shoulder'],['left_shoulder','left_elbow'],['left_elbow','left_wrist'],['right_shoulder','right_elbow'],['right_elbow','right_wrist'],['left_shoulder','left_hip'],['right_shoulder','right_hip'],['left_hip','right_hip'],['left_hip','left_knee'],['left_knee','left_ankle'],['right_hip','right_knee'],['right_knee','right_ankle']];

export function nearestSample(pass,time){if(!pass?.samples?.length)return null;let best=pass.samples[0];for(const s of pass.samples)if(Math.abs(s.timestamp-time)<Math.abs(best.timestamp-time))best=s;return best}
export function landmarkMap(d){return Object.fromEntries((d?.landmarks||[]).map(p=>[p.name,p]))}
export function centerOf(d){const m=landmarkMap(d),pts=['left_shoulder','right_shoulder','left_hip','right_hip'].map(n=>m[n]).filter(Boolean);if(!pts.length)return{x:.5,y:.5};return{x:pts.reduce((a,p)=>a+p.x,0)/pts.length,y:pts.reduce((a,p)=>a+p.y,0)/pts.length}}
function dist(a,b){return Math.hypot(a.x-b.x,a.y-b.y)}
export function assignTracks(samples,existingMeta={}){
  let next=1,previous=[]; const meta={...existingMeta};
  for(const sample of samples){const available=new Set(previous.map((_,i)=>i));for(const dancer of sample.dancers){const c=centerOf(dancer);let best=-1,score=.22;for(const i of available){const p=previous[i],s=dist(c,p.center);if(s<score){score=s;best=i}}if(best>=0){dancer.trackId=previous[best].id;available.delete(best)}else dancer.trackId=`dancer-${next++}`;if(!meta[dancer.trackId])meta[dancer.trackId]={name:`Dancer ${dancer.trackId.split('-')[1]}`,color:COLORS[(next-2)%COLORS.length],visible:true};}previous=sample.dancers.map(d=>({id:d.trackId,center:centerOf(d)}));}
  return meta;
}
function correctionKey(passId,trackId,name,time){return`${passId}|${trackId}|${name}|${time.toFixed(4)}`}
export function resolveSample(project,pass,time){const raw=nearestSample(pass,time);if(!raw)return null;const dancers=raw.dancers.map(d=>{const landmarks=d.landmarks.map(p=>{const exact=project.corrections[correctionKey(pass.id,d.trackId,p.name,raw.timestamp)];return exact?{...p,...exact,provenance:exact.hidden?'hidden':'manual'}:{...p,provenance:'raw'}});const m=Object.fromEntries(landmarks.filter(p=>!p.hidden).map(p=>[p.name,p]));const c=centerOf({landmarks});const shoulders=m.left_shoulder&&m.right_shoulder?dist(m.left_shoulder,m.right_shoulder):0;const hips=m.left_hip&&m.right_hip?dist(m.left_hip,m.right_hip):0;return{...d,landmarks,derived:{bodyCenter:c,scale:Math.max(shoulders,hips),orientation:m.left_shoulder&&m.right_shoulder?Math.atan2(m.right_shoulder.y-m.left_shoulder.y,m.right_shoulder.x-m.left_shoulder.x):0},provenance:landmarks.some(p=>p.provenance==='manual')?'corrected':'raw'}});return{timestamp:raw.timestamp,detector:pass.detector,dancers}}
export function setCorrection(project,passId,trackId,name,time,value){project.corrections[correctionKey(passId,trackId,name,time)]={...value,updatedAt:new Date().toISOString()}}
export function removeCorrection(project,passId,trackId,name,time){delete project.corrections[correctionKey(passId,trackId,name,time)]}
export function swapTracks(project,pass,a,b,start,end=Infinity){for(const s of pass.samples)if(s.timestamp>=start&&s.timestamp<=end){for(const d of s.dancers){if(d.trackId===a)d.trackId='__swap__';else if(d.trackId===b)d.trackId=a}for(const d of s.dancers)if(d.trackId==='__swap__')d.trackId=b}const ma=project.dancers[a],mb=project.dancers[b];if(ma&&mb){project.dancers[a]=mb;project.dancers[b]=ma}}
export function movementExport(project,pass){return{schema:'hansketch.movement',version:VERSION,createdAt:new Date().toISOString(),source:project.source,analysis:{id:pass.id,detector:pass.detector,modelVersion:pass.modelVersion,sampleRate:pass.sampleRate,range:pass.range},coordinateSystem:{space:'normalized-source-video',origin:'top-left',x:'right',y:'down'},dancers:project.dancers,keyframes:project.keyframes,samples:pass.samples.map(s=>resolveSample(project,pass,s.timestamp)),segmentation:{available:false,sampleRate:null,contours:null}}}

// Continuous motion clips are deliberately derived from the resolved analysis layer.
// They never write back into raw detector samples or the user's corrections.
const finite=n=>Number.isFinite(n);
const pointUsable=p=>!!p&&!p.hidden&&finite(p.x)&&finite(p.y);
const clipEpsilon=1e-6;
function clipRange(pass,requested){
 const fallback=pass?.range||{start:0,end:0},start=Math.max(fallback.start,requested?.start??fallback.start),end=Math.min(fallback.end,requested?.end??fallback.end);
 if(!finite(start)||!finite(end)||end<=start)throw new Error('Choose a Motion Clip range inside the active analysis pass');
 return{start,end};
}
function selectedPassSamples(pass,range){return(pass?.samples||[]).filter(s=>s.timestamp>=range.start-clipEpsilon&&s.timestamp<=range.end+clipEpsilon).slice().sort((a,b)=>a.timestamp-b.timestamp)}
function trackIdsInSamples(project,samples,visibleOnly){
 const ids=new Set();for(const sample of samples)for(const dancer of sample.dancers||[])if(!visibleOnly||project.dancers?.[dancer.trackId]?.visible!==false)ids.add(dancer.trackId);return[...ids];
}
function cloneLandmark(p){return{...p,hidden:!!p.hidden,provenance:p.provenance||'raw'}}
function frameDancer(frame,id){let dancer=frame.dancers.get(id);if(!dancer){dancer={trackId:id,landmarks:new Map(),interpolated:true};frame.dancers.set(id,dancer)}return dancer}
function distancePoints(a,b){return Math.hypot((finite(a.smoothedX)?a.smoothedX:a.x)-(finite(b.smoothedX)?b.smoothedX:b.x),(finite(a.smoothedY)?a.smoothedY:a.y)-(finite(b.smoothedY)?b.smoothedY:b.y))}
function neighbourIndexes(values,times,index,maxGap,usable){
 let previous=null,next=null;
 for(let i=index-1;i>=0;i--){if(times[index]-times[i]>maxGap+clipEpsilon)break;if(usable(values[i])){previous=i;break}}
 for(let i=index+1;i<values.length;i++){if(times[i]-times[index]>maxGap+clipEpsilon)break;if(usable(values[i])){next=i;break}}
 return{previous,next};
}
function confidenceWeight(point){const score=finite(point?.score)?Math.max(.02,point.score):1;return score*score*(point?.interpolated ? .45 : 1)}
function smoothLandmarkSeries(points,times,smoothingSeconds){
 if(smoothingSeconds<=0){for(const point of points)if(pointUsable(point)){point.smoothedX=point.x;point.smoothedY=point.y}return}
 for(let i=0;i<points.length;i++){
  const point=points[i];if(!pointUsable(point))continue;let total=0,x=0,y=0;
  for(let j=0;j<points.length;j++){const other=points[j];if(!pointUsable(other)||Math.abs(times[j]-times[i])>smoothingSeconds+clipEpsilon)continue;const weight=confidenceWeight(other);total+=weight;x+=other.x*weight;y+=other.y*weight}
  point.smoothedX=total?x/total:point.x;point.smoothedY=total?y/total:point.y;
 }
}
function addPointDerivatives(points,times,maxGap){
 for(let i=0;i<points.length;i++){
  const point=points[i];if(!pointUsable(point))continue;const{previous,next}=neighbourIndexes(points,times,i,maxGap,pointUsable);let vx=0,vy=0,available=false;
  if(previous!==null&&next!==null){const dt=times[next]-times[previous];if(dt>0){vx=(points[next].smoothedX-points[previous].smoothedX)/dt;vy=(points[next].smoothedY-points[previous].smoothedY)/dt;available=true}}
  else{const other=next??previous;if(other!==null){const dt=Math.abs(times[other]-times[i]);if(dt>0){const direction=next!==null?1:-1;vx=(points[other].smoothedX-point.smoothedX)/dt*direction;vy=(points[other].smoothedY-point.smoothedY)/dt*direction;available=true}}}
  point.vx=vx;point.vy=vy;point.velocityAvailable=available;
 }
 for(let i=0;i<points.length;i++){
  const point=points[i];if(!pointUsable(point))continue;const{previous,next}=neighbourIndexes(points,times,i,maxGap,pointUsable);let ax=0,ay=0,available=false;
  if(previous!==null&&next!==null&&points[previous].velocityAvailable&&points[next].velocityAvailable){const dt=times[next]-times[previous];if(dt>0){ax=(points[next].vx-points[previous].vx)/dt;ay=(points[next].vy-points[previous].vy)/dt;available=true}}
  point.ax=ax;point.ay=ay;point.accelerationAvailable=available;
 }
}
function addScalarDerivatives(records,times,maxGap,valueKey,velocityKey,accelerationKey){
 const usable=record=>finite(record?.[valueKey]);
 for(let i=0;i<records.length;i++){
  const record=records[i];if(!usable(record))continue;const{previous,next}=neighbourIndexes(records,times,i,maxGap,usable);let velocity=0,available=false;
  if(previous!==null&&next!==null){const dt=times[next]-times[previous];if(dt>0){velocity=(records[next][valueKey]-records[previous][valueKey])/dt;available=true}}
  else{const other=next??previous;if(other!==null){const dt=Math.abs(times[other]-times[i]);if(dt>0){velocity=(records[other][valueKey]-record[valueKey])/dt*(next!==null?1:-1);available=true}}}
  record[velocityKey]=velocity;record[`${velocityKey}Available`]=available;
 }
 for(let i=0;i<records.length;i++){
  const record=records[i];if(!usable(record))continue;const{previous,next}=neighbourIndexes(records,times,i,maxGap,usable);let acceleration=0,available=false;
  if(previous!==null&&next!==null&&records[previous][`${velocityKey}Available`]&&records[next][`${velocityKey}Available`]){const dt=times[next]-times[previous];if(dt>0){acceleration=(records[next][velocityKey]-records[previous][velocityKey])/dt;available=true}}
  record[accelerationKey]=acceleration;record[`${accelerationKey}Available`]=available;
 }
}
function bodyMeasure(dancer){
 const landmarks=dancer?[...dancer.landmarks.values()]:[],byName=new Map(landmarks.map(point=>[point.name,point]));
 const torso=['left_shoulder','right_shoulder','left_hip','right_hip'].map(name=>byName.get(name)).filter(pointUsable);
 const valid=torso.length?torso:landmarks.filter(pointUsable);
 if(!valid.length)return null;
 const x=valid.reduce((sum,point)=>sum+(finite(point.smoothedX)?point.smoothedX:point.x),0)/valid.length;
 const y=valid.reduce((sum,point)=>sum+(finite(point.smoothedY)?point.smoothedY:point.y),0)/valid.length;
 const leftShoulder=byName.get('left_shoulder'),rightShoulder=byName.get('right_shoulder'),leftHip=byName.get('left_hip'),rightHip=byName.get('right_hip');
 const shoulder=pointUsable(leftShoulder)&&pointUsable(rightShoulder)?distancePoints(leftShoulder,rightShoulder):null;
 const hip=pointUsable(leftHip)&&pointUsable(rightHip)?distancePoints(leftHip,rightHip):null;
 const pair=shoulder!==null?[leftShoulder,rightShoulder]:hip!==null?[leftHip,rightHip]:null;
 return{x,y,orientation:pair?Math.atan2(pair[1].smoothedY-pair[0].smoothedY,pair[1].smoothedX-pair[0].smoothedX):null,scale:Math.max(shoulder||0,hip||0)||null};
}
function unwrapAngles(records,times,maxGap){
 let previous=null;
 for(let i=0;i<records.length;i++){
  const record=records[i];if(!finite(record?.orientation))continue;
  if(previous===null||times[i]-times[previous]>maxGap+clipEpsilon)record.orientationUnwrapped=record.orientation;
  else{let delta=record.orientation-records[previous].orientation;while(delta>Math.PI)delta-=Math.PI*2;while(delta<-Math.PI)delta+=Math.PI*2;record.orientationUnwrapped=records[previous].orientationUnwrapped+delta}
  previous=i;
 }
}
function deriveBodies(frames,trackIds,times,maxGap){
 for(const id of trackIds){
  const bodies=frames.map(frame=>bodyMeasure(frame.dancers.get(id)));const centres=bodies.map(body=>body&&{x:body.x,y:body.y});
  smoothLandmarkSeries(centres,times,0);addPointDerivatives(centres,times,maxGap);unwrapAngles(bodies,times,maxGap);addScalarDerivatives(bodies,times,maxGap,'orientationUnwrapped','orientationVelocity','orientationAcceleration');addScalarDerivatives(bodies,times,maxGap,'scale','scaleVelocity','scaleAcceleration');
  for(let i=0;i<frames.length;i++){
   const dancer=frames[i].dancers.get(id),body=bodies[i];if(!dancer)continue;
   if(body){const centre=centres[i],orientation=body.orientation,scale=body.scale;dancer.derived={bodyCenter:centre?{x:centre.x,y:centre.y,vx:centre.vx,vy:centre.vy,ax:centre.ax,ay:centre.ay,velocityAvailable:centre.velocityAvailable,accelerationAvailable:centre.accelerationAvailable}:null,rootTranslation:centre?{x:centre.x,y:centre.y,vx:centre.vx,vy:centre.vy,ax:centre.ax,ay:centre.ay}:null,orientation,orientationUnwrapped:body.orientationUnwrapped??orientation,orientationVelocity:body.orientationVelocity||0,orientationAcceleration:body.orientationAcceleration||0,scale,scaleVelocity:body.scaleVelocity||0,scaleAcceleration:body.scaleAcceleration||0};
    if(centre&&finite(orientation)&&finite(scale)&&scale>.000001)for(const point of dancer.landmarks.values())if(pointUsable(point)){const dx=(finite(point.smoothedX)?point.smoothedX:point.x)-centre.x,dy=(finite(point.smoothedY)?point.smoothedY:point.y)-centre.y,c=Math.cos(orientation),s=Math.sin(orientation);point.localX=(dx*c+dy*s)/scale;point.localY=(-dx*s+dy*c)/scale}
   }else dancer.derived={bodyCenter:null,rootTranslation:null,orientation:null,orientationUnwrapped:null,orientationVelocity:0,orientationAcceleration:0,scale:null,scaleVelocity:0,scaleAcceleration:0};
  }
 }
}
function serialiseLandmark(point){return{name:point.name,x:finite(point.x)?point.x:null,y:finite(point.y)?point.y:null,score:finite(point.score)?point.score:0,hidden:!!point.hidden,provenance:point.provenance||'raw',interpolated:!!point.interpolated,smoothedX:finite(point.smoothedX)?point.smoothedX:null,smoothedY:finite(point.smoothedY)?point.smoothedY:null,vx:finite(point.vx)?point.vx:0,vy:finite(point.vy)?point.vy:0,ax:finite(point.ax)?point.ax:0,ay:finite(point.ay)?point.ay:0,velocityAvailable:!!point.velocityAvailable,accelerationAvailable:!!point.accelerationAvailable,localX:finite(point.localX)?point.localX:null,localY:finite(point.localY)?point.localY:null}}
function serialiseDancer(dancer){return{trackId:dancer.trackId,landmarks:[...dancer.landmarks.values()].sort((a,b)=>a.name.localeCompare(b.name)).map(serialiseLandmark),derived:dancer.derived||{bodyCenter:null,rootTranslation:null,orientation:null,scale:null}}}

export function getTrackDiagnostics(project,pass,{range=pass?.range,visibleOnly=false,maxGapSeconds=.25}={}){
 const selectedRange=clipRange(pass,range),samples=selectedPassSamples(pass,selectedRange),trackIds=trackIdsInSamples(project,samples,visibleOnly),tracks={},warnings=[];
 for(const id of trackIds){
  const times=samples.filter(sample=>sample.dancers?.some(dancer=>dancer.trackId===id)).map(sample=>sample.timestamp);let segments=0,longGaps=0,longestGap=0,previous=null;
  for(const time of times){if(previous===null||time-previous>maxGapSeconds+clipEpsilon){segments++;if(previous!==null)longGaps++}if(previous!==null)longestGap=Math.max(longestGap,time-previous);previous=time}
  const coverage=samples.length?times.length/samples.length:0,trackWarnings=[];
  if(coverage<.7)trackWarnings.push(`low coverage ${(coverage*100).toFixed(0)}%`);if(segments>1)trackWarnings.push(`${segments} fragments`);
  tracks[id]={trackId:id,samples:times.length,totalSamples:samples.length,coverage,segments,longGaps,longestGap,warnings:trackWarnings};if(trackWarnings.length)warnings.push(`${project.dancers?.[id]?.name||id}: ${trackWarnings.join(', ')}`);
 }
 return{range:selectedRange,sampleCount:samples.length,trackIds,tracks,warnings};
}

export function mergeTrackFragments(project,pass,targetId,fragmentId){
 if(!pass||!targetId||!fragmentId||targetId===fragmentId)return{ok:false,message:'Choose two different tracks'};
 if(!pass.samples.some(sample=>sample.dancers?.some(dancer=>dancer.trackId===targetId)))return{ok:false,message:'The destination track is not in this analysis pass'};
 if(!pass.samples.some(sample=>sample.dancers?.some(dancer=>dancer.trackId===fragmentId)))return{ok:false,message:'The fragment track is not in this analysis pass'};
 if(pass.samples.some(sample=>sample.dancers?.some(dancer=>dancer.trackId===targetId)&&sample.dancers?.some(dancer=>dancer.trackId===fragmentId)))return{ok:false,message:'These tracks overlap in time and cannot be safely merged'};
 let merged=0;for(const sample of pass.samples)for(const dancer of sample.dancers||[])if(dancer.trackId===fragmentId){dancer.trackId=targetId;merged++}
 const prefix=`${pass.id}|${fragmentId}|`,replacement=`${pass.id}|${targetId}|`;
 for(const [key,value]of Object.entries(project.corrections||{}))if(key.startsWith(prefix)){const nextKey=replacement+key.slice(prefix.length);if(!(nextKey in project.corrections))project.corrections[nextKey]=value;delete project.corrections[key]}
 if(!project.dancers[targetId]&&project.dancers[fragmentId])project.dancers[targetId]={...project.dancers[fragmentId]};
 if(!project.passes.some(other=>other.samples?.some(sample=>sample.dancers?.some(dancer=>dancer.trackId===fragmentId))))delete project.dancers[fragmentId];
 return{ok:true,merged,message:`Merged ${merged} samples into ${project.dancers?.[targetId]?.name||targetId}`};
}

export function buildMotionClip(project,pass,{range=pass?.range,visibleOnly=true,smoothingMs=100,maxGapSeconds=.25}={}){
 const selectedRange=clipRange(pass,range),rawSamples=selectedPassSamples(pass,selectedRange);if(!rawSamples.length)throw new Error('The selected Motion Clip range contains no analyzed samples');
 const smoothing=Math.max(0,Math.min(250,Number(smoothingMs)||0))/1000,maxGap=Math.max(0,Number(maxGapSeconds)||0),times=rawSamples.map(sample=>sample.timestamp),trackIds=trackIdsInSamples(project,rawSamples,visibleOnly),frames=rawSamples.map(raw=>{const resolved=resolveSample(project,pass,raw.timestamp),frame={timestamp:raw.timestamp,dancers:new Map()};for(const dancer of resolved?.dancers||[])if(trackIds.includes(dancer.trackId)){const copy={trackId:dancer.trackId,landmarks:new Map((dancer.landmarks||[]).map(point=>[point.name,cloneLandmark(point)])),interpolated:false};frame.dancers.set(copy.trackId,copy)}return frame});
 for(const id of trackIds){
  const names=new Set();for(const frame of frames)for(const name of frame.dancers.get(id)?.landmarks.keys()||[])names.add(name);
  for(const name of names){
   let previous=null;
   for(let i=0;i<frames.length;i++){
    const point=frames[i].dancers.get(id)?.landmarks.get(name);
    if(pointUsable(point)){
     if(previous!==null&&i-previous>1&&times[i]-times[previous]<=maxGap+clipEpsilon)for(let gap=previous+1;gap<i;gap++){const existing=frames[gap].dancers.get(id)?.landmarks.get(name);if(existing?.hidden)continue;const amount=(times[gap]-times[previous])/(times[i]-times[previous]),interpolated={name,x:frames[previous].dancers.get(id).landmarks.get(name).x+(point.x-frames[previous].dancers.get(id).landmarks.get(name).x)*amount,y:frames[previous].dancers.get(id).landmarks.get(name).y+(point.y-frames[previous].dancers.get(id).landmarks.get(name).y)*amount,score:Math.min(frames[previous].dancers.get(id).landmarks.get(name).score??1,point.score??1)*.75,hidden:false,provenance:'gap-interpolated',interpolated:true};frameDancer(frames[gap],id).landmarks.set(name,interpolated)}
     previous=i;
    }
   }
   const series=frames.map(frame=>frame.dancers.get(id)?.landmarks.get(name)||null);smoothLandmarkSeries(series,times,smoothing);addPointDerivatives(series,times,maxGap);
  }
 }
 deriveBodies(frames,trackIds,times,maxGap);
 const diagnostics=getTrackDiagnostics(project,pass,{range:selectedRange,visibleOnly,maxGapSeconds:maxGap}),dancers={};
 for(const id of trackIds){const metadata=project.dancers?.[id]||{},diagnostic=diagnostics.tracks[id];dancers[id]={id,trackId:id,name:metadata.name||id,color:metadata.color||null,visible:metadata.visible!==false,...diagnostic}}
 const clip={schema:'hansketch.motion-clip',version:VERSION,createdAt:new Date().toISOString(),source:project.source?{...project.source}:null,analysis:{id:pass.id,detector:pass.detector,modelVersion:pass.modelVersion,sampleRate:pass.sampleRate,range:{...pass.range}},range:selectedRange,coordinateSystem:{space:'normalized-source-video',origin:'top-left',x:'right',y:'down',units:'source-width/source-height'},dancers,keyframes:[...(project.keyframes||[])].sort((a,b)=>a-b),rangeKeyframes:(project.keyframes||[]).filter(time=>time>=selectedRange.start-clipEpsilon&&time<=selectedRange.end+clipEpsilon).sort((a,b)=>a-b),processing:{smoothingMs:Math.round(smoothing*1000),smoothing:'confidence-weighted centered window; resolved x/y remain unsmoothed',maxInterpolatedGapSeconds:maxGap,gapProvenance:'gap-interpolated',visibleTracksOnly:visibleOnly,diagnostics},samples:frames.map(frame=>({timestamp:frame.timestamp,dancers:trackIds.map(id=>frame.dancers.get(id)).filter(Boolean).map(serialiseDancer)}))};
 const validation=validateMotionClip(clip);if(!validation.valid)throw new Error(validation.errors[0]);return clip;
}

function interpolateNumber(a,b,amount){return finite(a)&&finite(b)?a+(b-a)*amount:(finite(a)?a:(finite(b)?b:null))}
function interpolateLandmark(a,b,amount){
 if(!a||!b||a.hidden||b.hidden)return null;
 return{...a,x:interpolateNumber(a.x,b.x,amount),y:interpolateNumber(a.y,b.y,amount),score:interpolateNumber(a.score,b.score,amount),smoothedX:interpolateNumber(a.smoothedX,b.smoothedX,amount),smoothedY:interpolateNumber(a.smoothedY,b.smoothedY,amount),vx:interpolateNumber(a.vx,b.vx,amount),vy:interpolateNumber(a.vy,b.vy,amount),ax:interpolateNumber(a.ax,b.ax,amount),ay:interpolateNumber(a.ay,b.ay,amount),localX:interpolateNumber(a.localX,b.localX,amount),localY:interpolateNumber(a.localY,b.localY,amount),provenance:'sampled',interpolated:true};
}
function interpolateDerived(a,b,amount){
 const centreA=a?.bodyCenter,centreB=b?.bodyCenter,centre=centreA&&centreB?{x:interpolateNumber(centreA.x,centreB.x,amount),y:interpolateNumber(centreA.y,centreB.y,amount),vx:interpolateNumber(centreA.vx,centreB.vx,amount),vy:interpolateNumber(centreA.vy,centreB.vy,amount),ax:interpolateNumber(centreA.ax,centreB.ax,amount),ay:interpolateNumber(centreA.ay,centreB.ay,amount)}:null;
 const orientationA=finite(a?.orientationUnwrapped)?a.orientationUnwrapped:a?.orientation,orientationB=finite(b?.orientationUnwrapped)?b.orientationUnwrapped:b?.orientation,orientationUnwrapped=interpolateNumber(orientationA,orientationB,amount);
 return{bodyCenter:centre,rootTranslation:centre?{...centre}:null,orientation:finite(orientationUnwrapped)?Math.atan2(Math.sin(orientationUnwrapped),Math.cos(orientationUnwrapped)):null,orientationUnwrapped,orientationVelocity:interpolateNumber(a?.orientationVelocity,b?.orientationVelocity,amount)||0,orientationAcceleration:interpolateNumber(a?.orientationAcceleration,b?.orientationAcceleration,amount)||0,scale:interpolateNumber(a?.scale,b?.scale,amount),scaleVelocity:interpolateNumber(a?.scaleVelocity,b?.scaleVelocity,amount)||0,scaleAcceleration:interpolateNumber(a?.scaleAcceleration,b?.scaleAcceleration,amount)||0};
}

export function sampleMotionClip(clip,timestamp){
 const validation=validateMotionClip(clip);if(!validation.valid)throw new Error(validation.errors[0]);const samples=clip.samples,time=Math.max(clip.range.start,Math.min(timestamp,clip.range.end));let upper=samples.findIndex(sample=>sample.timestamp>=time-clipEpsilon);if(upper<0)upper=samples.length-1;const lower=Math.max(0,upper-(samples[upper].timestamp>time+clipEpsilon?1:0)),a=samples[lower],b=samples[upper];
 if(a===b||Math.abs(a.timestamp-b.timestamp)<clipEpsilon)return{timestamp:a.timestamp,sourceTimestamp:a.timestamp,dancers:a.dancers.map(dancer=>({...dancer,landmarks:dancer.landmarks.map(point=>({...point})),derived:{...dancer.derived,bodyCenter:dancer.derived?.bodyCenter?{...dancer.derived.bodyCenter}:null}}))};
 if(b.timestamp-a.timestamp>(clip.processing?.maxInterpolatedGapSeconds??.25)+clipEpsilon)return{timestamp:time,sourceTimestamp:time,dancers:[]};
 const amount=(time-a.timestamp)/(b.timestamp-a.timestamp),ids=new Set([...a.dancers.map(dancer=>dancer.trackId),...b.dancers.map(dancer=>dancer.trackId)]),dancers=[];
 for(const id of ids){const first=a.dancers.find(dancer=>dancer.trackId===id),second=b.dancers.find(dancer=>dancer.trackId===id);if(!first||!second)continue;const landmarks=[],names=new Set([...first.landmarks.map(point=>point.name),...second.landmarks.map(point=>point.name)]);for(const name of names){const point=interpolateLandmark(first.landmarks.find(item=>item.name===name),second.landmarks.find(item=>item.name===name),amount);if(point)landmarks.push(point)}if(landmarks.length)dancers.push({trackId:id,landmarks,derived:interpolateDerived(first.derived,second.derived,amount)})}
 return{timestamp:time,sourceTimestamp:time,dancers};
}

export function validateMotionClip(clip){
 const errors=[],warnings=[];if(!clip||clip.schema!=='hansketch.motion-clip')errors.push('Not a hansketch.motion-clip file');if(!clip?.version)errors.push('Motion Clip version is missing');if(!clip?.range||!finite(clip.range.start)||!finite(clip.range.end)||clip.range.end<=clip.range.start)errors.push('Motion Clip range is invalid');if(!Array.isArray(clip?.samples)||!clip.samples.length)errors.push('Motion Clip has no samples');
 let previous=-Infinity;for(const sample of clip?.samples||[]){if(!finite(sample.timestamp)||sample.timestamp<previous){errors.push('Motion Clip sample timestamps are invalid');break}previous=sample.timestamp;if(!Array.isArray(sample.dancers)){errors.push('Motion Clip sample dancers are invalid');break}for(const dancer of sample.dancers)if(!dancer.trackId||!Array.isArray(dancer.landmarks)){errors.push('Motion Clip dancer data is invalid');break}}
 for(let i=1;i<(clip?.samples||[]).length;i++)if(clip.samples[i].timestamp-clip.samples[i-1].timestamp>(clip.processing?.maxInterpolatedGapSeconds??.25)+clipEpsilon)warnings.push(`Unfilled motion gap near ${clip.samples[i-1].timestamp.toFixed(3)} s`);
 return{valid:!errors.length,errors,warnings};
}
function hexRgb(hex){return[parseInt(hex.slice(1,3),16)/255,parseInt(hex.slice(3,5),16)/255,parseInt(hex.slice(5,7),16)/255,1]}
function clamp(n,min,max){return Math.max(min,Math.min(max,n))}
function findLandmark(anchor,trackId,name){const d=anchor.sample.dancers.find(x=>x.trackId===trackId);return d&&landmarkMap(d)[name]}
function tangent(anchors,index,trackId,name){const here=findLandmark(anchors[index],trackId,name);if(!here)return{x:0,y:0};let before=null,after=null;for(let i=index-1;i>=0;i--){const p=findLandmark(anchors[i],trackId,name);if(p){before={p,t:anchors[i].time};break}}for(let i=index+1;i<anchors.length;i++){const p=findLandmark(anchors[i],trackId,name);if(p){after={p,t:anchors[i].time};break}}if(before&&after){const dt=after.t-before.t;return dt>0?{x:(after.p.x-before.p.x)/dt,y:(after.p.y-before.p.y)/dt}:{x:0,y:0}}const other=after||before;if(!other)return{x:0,y:0};const dt=Math.abs(other.t-anchors[index].time);const sign=after?1:-1;return dt>0?{x:(other.p.x-here.x)/dt*sign,y:(other.p.y-here.y)/dt*sign}:{x:0,y:0}}
function hermite(p0,p1,m0,m1,u,dt){const u2=u*u,u3=u2*u,h00=2*u3-3*u2+1,h10=u3-2*u2+u,h01=-2*u3+3*u2,h11=u3-u2;const dh00=(6*u2-6*u)/dt,dh10=3*u2-4*u+1,dh01=(-6*u2+6*u)/dt,dh11=3*u2-2*u;return{x:h00*p0.x+h10*dt*m0.x+h01*p1.x+h11*dt*m1.x,y:h00*p0.y+h10*dt*m0.y+h01*p1.y+h11*dt*m1.y,vx:dh00*p0.x+dh10*m0.x+dh01*p1.x+dh11*m1.x,vy:dh00*p0.y+dh10*m0.y+dh01*p1.y+dh11*m1.y}}

export function buildKeyframeMotion(project,pass,keyframes,{confidence=.35}={}){
 const times=[...new Set(keyframes.filter(t=>t>=pass.range.start&&t<=pass.range.end))].sort((a,b)=>a-b);if(times.length<2)throw new Error('Select at least two keyframes inside the active analysis range');
 const anchors=times.map(time=>({time,sample:resolveSample(project,pass,time)})).filter(a=>a.sample);if(anchors.length<2)throw new Error('The active pass has insufficient data at the selected keyframes');
 const dancerIds=[...new Set(anchors.flatMap(a=>a.sample.dancers.map(d=>d.trackId)))].filter(id=>project.dancers[id]?.visible!==false);
 return{schema:'hansketch.keyframe-motion',interpolation:'cubic-hermite',passId:pass.id,start:anchors[0].time,end:anchors.at(-1).time,duration:anchors.at(-1).time-anchors[0].time,anchors,dancerIds,confidence};
}

export function sampleKeyframeMotion(motion,elapsedTime){
 const sourceTimestamp=clamp(motion.start+elapsedTime,motion.start,motion.end);let si=0;while(si<motion.anchors.length-2&&sourceTimestamp>motion.anchors[si+1].time)si++;const a=motion.anchors[si],b=motion.anchors[si+1],dt=Math.max(.0001,b.time-a.time),u=clamp((sourceTimestamp-a.time)/dt,0,1),dancers=[];
 for(const id of motion.dancerIds){const da=a.sample.dancers.find(d=>d.trackId===id),db=b.sample.dancers.find(d=>d.trackId===id);if(!da&&!db)continue;const names=[...new Set([...(da?.landmarks||[]).map(p=>p.name),...(db?.landmarks||[]).map(p=>p.name)])],landmarks=[];for(const name of names){const p0=da&&landmarkMap(da)[name],p1=db&&landmarkMap(db)[name];if(p0?.hidden||p1?.hidden)continue;if(p0&&p1&&p0.score>=motion.confidence&&p1.score>=motion.confidence){let m0=tangent(motion.anchors,si,id,name),m1=tangent(motion.anchors,si+1,id,name);const maxSpeed=Math.max(.25,Math.hypot(p1.x-p0.x,p1.y-p0.y)/dt*3);for(const m of[m0,m1]){const speed=Math.hypot(m.x,m.y);if(speed>maxSpeed){m.x*=maxSpeed/speed;m.y*=maxSpeed/speed}}const p=hermite(p0,p1,m0,m1,u,dt);landmarks.push({...p,name,score:Math.min(p0.score,p1.score),opacity:1,provenance:p0.provenance==='manual'||p1.provenance==='manual'?'corrected':'interpolated'})}else{const p=p0||p1;if(p&&p.score>=motion.confidence)landmarks.push({...p,vx:0,vy:0,opacity:p0?1-u:u,provenance:'faded'})}}if(!landmarks.length)continue;const derived={bodyCenter:centerOf({landmarks}),opacity:da&&db?1:(da?1-u:u)};dancers.push({trackId:id,landmarks,derived,opacity:derived.opacity})}
 return{sourceTimestamp,dancers};
}

function point(p,w,h,v=1){return{x:p.x*w,y:p.y*h,vx:(p.vx||0)*w*v,vy:(p.vy||0)*h*v,pinned:false}}
export function hansketchExport(project,pass,{mode='skeleton',width=500,height=500,baseRadius=5,velocityScale=1,confidence=.35,keyframes=project.keyframes}={}){
 const motion=buildKeyframeMotion(project,pass,keyframes,{confidence}),sampleData=[];for(let t=0;t<motion.duration+1e-6;t+=1/Math.max(1,pass.sampleRate))sampleData.push(sampleKeyframeMotion(motion,t));if(sampleData.at(-1)?.sourceTimestamp<motion.end)sampleData.push(sampleKeyframeMotion(motion,motion.duration));const chains=[];
 const add=(pts,id)=>{if(pts.length>1)chains.push({chain:pts,color:hexRgb(project.dancers[id]?.color||COLORS[0]),baseDotRadius:+baseRadius,isClosed:false,frozen:false,isParticle:false})};
 if(mode==='skeleton'){for(const sample of sampleData)for(const d of sample.dancers){const m=landmarkMap(d);for(const [a,b]of BONES)if(m[a]&&m[b])add([point(m[a],width,height,velocityScale),point(m[b],width,height,velocityScale)],d.trackId)}}
 if(mode==='trajectories'){for(const id of Object.keys(project.dancers)){const names=new Set();for(const s of sampleData){const d=s.dancers.find(x=>x.trackId===id);d?.landmarks.forEach(p=>names.add(p.name))}for(const name of names){const pts=[];for(const s of sampleData){const d=s.dancers.find(x=>x.trackId===id),p=d&&landmarkMap(d)[name];if(p&&!p.hidden&&p.score>=confidence)pts.push(point(p,width,height,velocityScale))}add(pts,id)}}}
 if(mode==='bodyPaths'){for(const id of Object.keys(project.dancers)){const centers=[];for(const s of sampleData){const d=s.dancers.find(x=>x.trackId===id);if(d)centers.push(point(d.derived.bodyCenter,width,height,velocityScale))}add(centers,id)}}
 return{chains,circles:[],settings:{canvasWidth:+width,canvasHeight:+height},movementAdapter:{schema:'hansketch.adapter',version:VERSION,mode,analysisPassId:pass.id,sourceRange:{start:motion.start,end:motion.end},selectedKeyframes:motion.anchors.map(a=>a.time),interpolation:motion.interpolation,sourceTiming:true,transform:{width:+width,height:+height,preserveAspect:true},velocityScale:+velocityScale}};
}
