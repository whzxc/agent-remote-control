// Thresholds shared by the token policy and normalization audit.
export function lengthDifference(value, nearest) {
  const difference = Math.abs(value - nearest);
  return { difference, ratio: nearest ? difference / Math.abs(nearest) : Infinity, large: difference > 2 && difference > Math.abs(nearest) * .2 };
}
export function tokenKind(name) {
  if (/^--radius-/.test(name)) return 'radius';
  if (/^--text-/.test(name) && !/(secondary|tertiary)$/.test(name)) return 'font-size';
  if (/^--line-/.test(name)) return 'line-height';
  if (/^--stroke-/.test(name)) return 'stroke';
  if (/^--tracking-/.test(name)) return 'letter-spacing';
  if (/^--weight-/.test(name)) return 'font-weight';
  if (/^--font-/.test(name)) return 'font-family';
  if (/^--shadow-/.test(name)) return 'shadow';
}
function rgb(value) {
  const hex = /^#([\da-f]{3,8})$/i.exec(value.trim());
  if (hex) {
    let h=hex[1]; if(h.length===3||h.length===4)h=[...h].map(x=>x+x).join('');
    return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255).concat(h.length===8?parseInt(h.slice(6),16)/255:1);
  }
  const m=/^rgba?\(([^)]+)\)$/.exec(value.trim());
  if(m){const parts=m[1].split(/[\s,\/]+/);return parts.slice(0,3).map(x=>parseFloat(x)/(x.endsWith('%')?100:255)).concat(parts[3]?parseFloat(parts[3])/(parts[3].endsWith('%')?100:1):1);}
  return ({white:[1,1,1,1],black:[0,0,0,1],transparent:[0,0,0,0]})[value.trim()];
}
function lab(c) {
  const [r,g,b]=c.map(x=>x>.04045?((x+.055)/1.055)**2.4:x/12.92);
  const f=x=>x>.008856?Math.cbrt(x):7.787*x+16/116;
  const x=f((r*.4124564+g*.3575761+b*.1804375)/.95047),y=f(r*.2126729+g*.7151522+b*.072175),z=f((r*.0193339+g*.119192+b*.9503041)/1.08883);
  return [116*y-16,500*(x-y),200*(y-z)];
}
// CIEDE2000, with unit parametric factors and a D65 sRGB conversion.
export function deltaE(left, right) {
  const a=rgb(left),b=rgb(right);if(!a||!b)return undefined;
  const [l1,a1,b1]=lab(a),[l2,a2,b2]=lab(b),rad=Math.PI/180;
  const c1=Math.hypot(a1,b1),c2=Math.hypot(a2,b2),cm=(c1+c2)/2,g=.5*(1-Math.sqrt(cm**7/(cm**7+25**7)));
  const ap1=(1+g)*a1,ap2=(1+g)*a2,cp1=Math.hypot(ap1,b1),cp2=Math.hypot(ap2,b2);
  const h=(x,y)=>(Math.atan2(y,x)/rad+360)%360,h1=h(ap1,b1),h2=h(ap2,b2);
  const dl=l2-l1,dc=cp2-cp1;let dh=h2-h1;if(!cp1||!cp2)dh=0;else if(dh>180)dh-=360;else if(dh< -180)dh+=360;
  const dH=2*Math.sqrt(cp1*cp2)*Math.sin(dh*rad/2),lm=(l1+l2)/2,cp=(cp1+cp2)/2;
  let hm=h1+h2;if(cp1&&cp2)hm=Math.abs(h1-h2)<=180?hm/2:(hm+(hm<360?360:-360))/2;
  const t=1-.17*Math.cos((hm-30)*rad)+.24*Math.cos(2*hm*rad)+.32*Math.cos((3*hm+6)*rad)-.20*Math.cos((4*hm-63)*rad);
  const sl=1+.015*(lm-50)**2/Math.sqrt(20+(lm-50)**2),sc=1+.045*cp,sh=1+.015*cp*t;
  const rt=-2*Math.sqrt(cp**7/(cp**7+25**7))*Math.sin(60*Math.exp(-(((hm-275)/25)**2))*rad);
  return Math.sqrt((dl/sl)**2+(dc/sc)**2+(dH/sh)**2+rt*(dc/sc)*(dH/sh));
}
export function valueDifference(kind, left, right) {
  if(kind==='color'){
    const differences=left.map((value,index)=>deltaE(value,right[index]??right[0]));
    if(differences.some(x=>x===undefined))return;
    return {difference:Math.max(...differences),large:differences.some(x=>x>5),themes:differences};
  }
  if(kind==='font-family')return {difference:left[0]===right[0]?0:Infinity,large:left[0]!==right[0]};
  if(kind==='shadow'){
    const shape=s=>s.replace(/var\([^)]+\)|rgba?\([^)]+\)|#[0-9a-f]+/gi,'COLOR').replace(/-?\d*\.?\d+(?:px)?/g,'N').replace(/\s+/g,' ').trim();
    if(left.length!==right.length)return {difference:Infinity,large:true};
    if(left.some((value,index)=>shape(value)!==shape(right[index])))return {difference:Infinity,large:true};
    const a=left[0].match(/-?\d*\.?\d+px/g)??[],b=right[0].match(/-?\d*\.?\d+px/g)??[];
    if(a.length!==b.length)return {difference:Infinity,large:true};
    const diffs=a.map((v,i)=>lengthDifference(parseFloat(v),parseFloat(b[i])));
    return {difference:Math.max(0,...diffs.map(d=>d.difference)),large:diffs.some(d=>d.large)};
  }
  const a=/^(-?\d*\.?\d+)(px|em|rem|%)?$/.exec(left[0]),b=/^(-?\d*\.?\d+)(px|em|rem|%)?$/.exec(right[0]);
  if(!a||!b||a[2]!==b[2])return;
  if(kind==='font-weight')return {difference:Math.abs(+a[1]-+b[1]),large:Math.abs(+a[1]-+b[1])>100};
  if(kind==='line-height' && !a[2]) return lengthDifference(+a[1] * 14, +b[1] * 14);
  if(a[2]!== 'px')return {difference:Math.abs(+a[1]-+b[1]),large:a[1]!==b[1]};
  return lengthDifference(+a[1],+b[1]);
}
export function nearestToken(row, tokens) {
  const kind=tokenKind(row.token)??(rgb(row.values[0])?'color':undefined);
  if(!kind)return;
  return tokens.filter(other=>other.token!==row.token && (tokenKind(other.token)??(rgb(other.values[0])?'color':undefined))===kind)
    .map(other=>({token:other.token,...valueDifference(kind,row.values,other.values)})).filter(d=>d.large!==undefined)
    .sort((a,b)=>a.difference-b.difference||a.token.localeCompare(b.token))[0];
}
