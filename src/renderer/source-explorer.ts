import type { ExplorerFolderNode, ExplorerRoot, SourceRecord } from "../shared/protocol";

let sources: SourceRecord[] = [];
const norm = (v: string) => v.replace(/[\\/]+$/g, "").replace(/\\/g, "/").toLocaleLowerCase("de-DE");
const same = (a: string, b: string) => norm(a) === norm(b);
const inside = (c: string, p: string) => { const cc=norm(c), pp=norm(p); return cc===pp || cc.startsWith(pp+"/"); };
const exact = (p: string) => sources.find((s)=>same(s.path,p)) ?? null;
const covering = (p: string) => sources.filter((s)=>inside(p,s.path)).sort((a,b)=>b.path.length-a.path.length)[0] ?? null;

export async function initEmbeddedSourceExplorer(): Promise<void> {
  const tree=document.querySelector<HTMLDivElement>("#embeddedFolderTree");
  const active=document.querySelector<HTMLDivElement>("#embeddedActiveSources");
  const count=document.querySelector<HTMLElement>("#embeddedSourceCount");
  const status=document.querySelector<HTMLDivElement>("#embeddedTreeStatus");
  const refresh=document.querySelector<HTMLButtonElement>("#embeddedRefreshExplorer");
  if(!tree || !active || !count || !status || !refresh) return;
  const renderActive=()=>{
    count.textContent=String(sources.length); active.replaceChildren();
    if(!sources.length){ const e=document.createElement("div"); e.className="source-empty"; e.textContent="Noch keine Ordner ausgewählt."; active.appendChild(e); return; }
    for(const source of sources){
      const row=document.createElement("div"); row.className="embedded-source-chip";
      const mark=document.createElement("span"); mark.textContent="✓";
      const body=document.createElement("div"); const strong=document.createElement("strong"); const small=document.createElement("small");
      strong.textContent=source.path.replace(/\\/g,"/").split("/").filter(Boolean).at(-1) ?? source.path; small.textContent=source.path;
      body.append(strong,small); row.append(mark,body); active.appendChild(row);
    }
  };
  const refreshSelections=()=>{
    for(const row of tree.querySelectorAll<HTMLElement>(".embedded-folder-row")){
      const p=row.dataset.path; if(!p) continue; const box=row.querySelector<HTMLInputElement>("input[type=checkbox]"); if(!box) continue;
      const ex=exact(p), cov=covering(p), inherited=Boolean(cov && !ex); box.checked=Boolean(ex||inherited); box.disabled=inherited;
      row.classList.toggle("selected",Boolean(ex)); row.classList.toggle("inherited",inherited);
    }
  };
  const loadSources=async()=>{ sources=await window.imageSorter.catalog.listSources(); renderActive(); refreshSelections(); };
  const createNode=(node: ExplorerFolderNode|ExplorerRoot, depth:number, drive=false): HTMLElement=>{
    const wrap=document.createElement("div"); wrap.className="embedded-folder-node";
    const row=document.createElement("div"); row.className="embedded-folder-row"; row.dataset.path=node.path; row.style.setProperty("--depth",String(depth));
    const toggle=document.createElement("button"); toggle.className="embedded-folder-toggle"; toggle.type="button"; toggle.textContent=node.hasChildren?"›":""; toggle.disabled=!node.hasChildren;
    const box=document.createElement("input"); box.type="checkbox";
    const icon=document.createElement("span"); icon.className=drive?"embedded-drive-icon":"embedded-folder-icon"; icon.textContent=drive?"▣":"▰";
    const info=document.createElement("div"); info.className="embedded-folder-info"; const title=document.createElement("strong"); title.textContent=node.name;
    const meta=document.createElement("small"); const parts:string[]=[]; if(node.directImages) parts.push(node.directImages.toLocaleString("de-DE")+" Bilder"); if(node.directVideos) parts.push(node.directVideos.toLocaleString("de-DE")+" Videos");
    meta.textContent=parts.length?parts.join(" · ")+" direkt":node.hasChildren?"Unterordner vorhanden":"keine Medien direkt"; info.append(title,meta); row.append(toggle,box,icon,info); wrap.appendChild(row);
    const children=document.createElement("div"); children.className="embedded-folder-children"; children.hidden=true; wrap.appendChild(children);
    let loaded=false, loading=false;
    const setOpen=async(open:boolean)=>{ if(!node.hasChildren) return; if(open && !loaded && !loading){ loading=true; toggle.classList.add("loading"); try{ const nodes=await window.imageSorter.catalog.getExplorerChildren(node.path); children.replaceChildren(...nodes.map((n)=>createNode(n,depth+1))); loaded=true; refreshSelections(); } catch(error){ children.textContent=error instanceof Error?error.message:String(error); children.classList.add("load-error"); loaded=true; } finally { loading=false; toggle.classList.remove("loading"); } } children.hidden=!open; toggle.classList.toggle("expanded",open); };
    toggle.addEventListener("click",()=>void setOpen(children.hidden)); title.addEventListener("dblclick",()=>void setOpen(children.hidden));
    box.addEventListener("change",()=>void (async()=>{ box.disabled=true; try{ const ex=exact(node.path); if(ex) await window.imageSorter.catalog.disableSource(ex.id); else await window.imageSorter.catalog.addSource(node.path); await loadSources(); } finally { refreshSelections(); } })());
    return wrap;
  };
  const loadExplorer=async()=>{ refresh.disabled=true; status.hidden=false; status.textContent="Laufwerke werden geladen …"; tree.hidden=true; try{ await loadSources(); const roots=await window.imageSorter.catalog.listExplorerRoots(); tree.replaceChildren(...roots.map((r)=>createNode(r,0,true))); refreshSelections(); status.hidden=roots.length>0; status.textContent=roots.length?"":"Keine erreichbaren Laufwerke gefunden."; tree.hidden=roots.length===0; } catch(error){ status.hidden=false; status.textContent=error instanceof Error?error.message:String(error); } finally { refresh.disabled=false; } };
  refresh.addEventListener("click",()=>void loadExplorer());
  await loadExplorer();
}