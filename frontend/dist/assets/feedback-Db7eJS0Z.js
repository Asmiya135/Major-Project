import{c as i,a as c}from"./client-DANBHpMb.js";import{j as u,r as s}from"./index-zffr4sBR.js";/**
 * @license lucide-react v0.487.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const x=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["path",{d:"m9 12 2 2 4-4",key:"dzmm74"}]],N=i("circle-check",x);/**
 * @license lucide-react v0.487.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const v=[["circle",{cx:"12",cy:"12",r:"10",key:"1mglay"}],["polyline",{points:"12 6 12 12 16 14",key:"68esgv"}]],A=i("clock",v);/**
 * @license lucide-react v0.487.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const I=[["path",{d:"M7 16.3c2.2 0 4-1.83 4-4.05 0-1.16-.57-2.26-1.71-3.19S7.29 6.75 7 5.3c-.29 1.45-1.14 2.84-2.29 3.76S3 11.1 3 12.25c0 2.22 1.8 4.05 4 4.05z",key:"1ptgy4"}],["path",{d:"M12.56 6.6A10.97 10.97 0 0 0 14 3.02c.5 2.5 2 4.9 4 6.5s3 3.5 3 5.5a6.98 6.98 0 0 1-11.91 4.97",key:"1sl1rz"}]],z=i("droplets",I);/**
 * @license lucide-react v0.487.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const w=[["polygon",{points:"3 11 22 2 13 21 11 13 3 11",key:"1ltx0t"}]],L=i("navigation",w);/**
 * @license lucide-react v0.487.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const j=[["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",key:"4alrt4"}],["path",{d:"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",key:"v07s0e"}],["line",{x1:"10",x2:"10",y1:"11",y2:"17",key:"1uufr5"}],["line",{x1:"14",x2:"14",y1:"11",y2:"17",key:"xtxkd"}]],m=i("trash-2",j);/**
 * @license lucide-react v0.487.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const T=[["path",{d:"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",key:"wmoenq"}],["path",{d:"M12 9v4",key:"juzpu7"}],["path",{d:"M12 17h.01",key:"p32p05"}]],_=i("triangle-alert",T);function q({type:t,className:e="w-5 h-5"}){switch(t){case"pothole":return u.jsx(_,{className:e});case"flood":return u.jsx(z,{className:e});case"debris":return u.jsx(m,{className:e});default:return u.jsx(_,{className:e})}}function b(t){const e=new URLSearchParams;return t!=null&&t.hazard_type&&e.set("hazard_type",t.hazard_type),t!=null&&t.severity&&e.set("severity",t.severity),t!=null&&t.since_hours&&e.set("since_hours",String(t.since_hours)),c.get(`/api/hazards?${e}`)}function R(t={}){const[e,l]=s.useState([]),[d,y]=s.useState(!0),[h,a]=s.useState(null),o=()=>{b(t).then(n=>{l(n.hazards),a(null)}).catch(n=>a(String(n))).finally(()=>y(!1))};return s.useEffect(()=>{if(o(),t.pollInterval&&t.pollInterval>0){const n=setInterval(o,t.pollInterval);return()=>clearInterval(n)}},[]),{hazards:e,loading:d,error:h,reload:o}}function E(t){return c.post("/api/trips/start",{session_id:t})}function M(t){return c.post("/api/trips/end",t)}function $(t){return c.get(`/api/trips/${t}/summary`)}const p="vw_session_id";function V(){const[t,e]=s.useState(()=>sessionStorage.getItem(p)),[l,d]=s.useState(null),[y,h]=s.useState(null),[a,o]=s.useState(!1),[n,g]=s.useState(!1),S=s.useCallback(async()=>{o(!0);try{const f=sessionStorage.getItem(p)??void 0,r=await E(f);return sessionStorage.setItem(p,r.session_id),e(r.session_id),d(r.trip_id),r.session_id}finally{o(!1)}},[]),k=s.useCallback(async f=>{if(!t)return null;g(!0);try{await M({session_id:t,...f});const r=await $(t);return h(r),r}finally{g(!1)}},[t]);return{sessionId:t,tripId:l,summary:y,starting:a,ending:n,start:S,end:k}}function D(t){return c.post("/api/feedback",t)}function F(){return c.get("/api/system/status")}export{A as C,q as H,L as N,_ as T,V as a,N as b,F as f,D as s,R as u};
