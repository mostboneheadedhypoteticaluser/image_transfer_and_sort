import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoMediaPoint } from "../shared/protocol";

let map: L.Map | null = null;
let layer: L.LayerGroup | null = null;
let points: GeoMediaPoint[] = [];
let loaded = false;
const escapeHtml=(v:string)=>v.replace(/[&<>"\']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","\'":"&#039;"}[c] ?? c));
const thumb=(p:GeoMediaPoint)=>p.thumbnailVersion ? "image-sorter-thumb://media/"+p.mediaId+"?v="+encodeURIComponent(p.thumbnailVersion) : null;

function clusters(currentMap:L.Map, items:GeoMediaPoint[]): GeoMediaPoint[][] {
  const zoom=currentMap.getZoom(), cell=Math.max(48,92-zoom*3), groups=new Map<string,GeoMediaPoint[]>();
  for(const item of items){ const p=currentMap.project([item.latitude,item.longitude],zoom); const key=Math.floor(p.x/cell)+":"+Math.floor(p.y/cell); const g=groups.get(key) ?? []; g.push(item); groups.set(key,g); }
  return [...groups.values()];
}
function render(): void {
  if(!map || !layer) return; layer.clearLayers(); const bounds=map.getBounds().pad(0.3); const visible=points.filter((p)=>bounds.contains([p.latitude,p.longitude]));
  for(const group of clusters(map,visible)){
    const lat=group.reduce((s,p)=>s+p.latitude,0)/group.length, lng=group.reduce((s,p)=>s+p.longitude,0)/group.length;
    if(group.length===1){ const p=group[0]; const marker=L.circleMarker([lat,lng],{radius:7,weight:2,fillOpacity:.82}); const image=thumb(p); const html="<div class=\"map-popup\">"+(image?"<img src=\""+image+"\" alt=\"\">":"")+"<strong>"+escapeHtml(p.relativePath)+"</strong><small>"+(p.capturedAt?escapeHtml(p.capturedAt):"Aufnahmedatum unbekannt")+"</small></div>"; marker.bindPopup(html); marker.addTo(layer); }
    else { const radius=Math.min(30,12+Math.log2(group.length)*4); const marker=L.circleMarker([lat,lng],{radius,weight:2,fillOpacity:.86}); marker.bindTooltip(String(group.length),{permanent:true,direction:"center",className:"map-cluster-label"}); marker.on("click",()=>map?.setView([lat,lng],Math.min(18,map.getZoom()+2),{animate:true})); marker.addTo(layer); }
  }
  const total=document.querySelector<HTMLElement>("#mapGeoCount"); if(total) total.textContent=points.length.toLocaleString("de-DE");
}
export async function activateMapView(): Promise<void> {
  const el=document.querySelector<HTMLDivElement>("#mediaMap"); const empty=document.querySelector<HTMLDivElement>("#mapEmptyState"); if(!el) return;
  if(!map){ map=L.map(el,{zoomControl:true,preferCanvas:true}).setView([48.8,9.2],5); L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"}).addTo(map); layer=L.layerGroup().addTo(map); map.on("zoomend moveend",render); }
  map.invalidateSize();
  if(!loaded){ points=await window.imageSorter.catalog.listGeoMedia(); loaded=true; if(empty) empty.hidden=points.length>0; if(points.length){ const b=L.latLngBounds(points.map((p)=>[p.latitude,p.longitude] as [number,number])); map.fitBounds(b.pad(.12),{maxZoom:14}); } render(); }
}
export function invalidateMapData(): void { loaded=false; }